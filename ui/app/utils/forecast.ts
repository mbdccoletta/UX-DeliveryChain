// Where the numbers are heading, from the platform's own predictive analyzer.
//
// Everything else in this app reports what already happened. This is the one
// piece that looks forward — and it only speaks when the analyzer says the
// forecast is sound: an unreliable projection shown to a business owner is
// worse than no projection at all.
import { analyzersClient } from "@dynatrace-sdk/client-davis-analyzers";
import { binMinutesFor, durStr } from "./dql";

const ANALYZER = "dt.statistics.GenericForecastAnalyzer";

export interface Forecast {
  /** Projected values, one per interval ahead. */
  point: number[];
  lower: number[];
  upper: number[];
  /** Sum of the projected points — the "how much more" figure. */
  total: number;
  /** Difference between the last and first projected point. */
  slope: number;
  /** How many intervals ahead, and how long each is. */
  horizon: number;
  intervalMs: number;
  /** TRUE when the series handed to the analyzer carried no measurement at
   *  all — every point null or zero. A forecast of nothing is still a
   *  forecast, and it comes back VALID: the analyzer is right that the next
   *  points are zero. But "zero is coming" and "this metric is not published
   *  for this entity" are different sentences, and only the second one is
   *  true when a service shows thousands of calls in traces and an empty
   *  series in the metric store. The caller decides what to say; it cannot
   *  decide without being told. */
  emptyInput: boolean;
}

/** Polls until the analysis completes, per the documented execution contract. */
async function poll(requestToken: string) {
  const MAX = 10;
  for (let i = 0; i < MAX; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const { result } = await analyzersClient.pollAnalyzerExecution({
      analyzerName: ANALYZER, requestToken,
    });
    if (result.executionStatus === "COMPLETED") return result;
    if (result.executionStatus === "ABORTED") throw new Error("analysis aborted");
  }
  // the guide recommends cancelling rather than leaving it running; a result
  // that lands between the last poll and the cancel is still returned
  const cancelled = await analyzersClient.cancelAnalyzerExecution({
    analyzerName: ANALYZER, requestToken,
  });
  if (cancelled?.result.executionStatus === "COMPLETED") return cancelled.result;
  throw new Error("analysis did not finish");
}

/**
 * Runs a forecast over a DQL timeseries.
 *
 * Returns null whenever the answer would not be trustworthy — analyzer refused,
 * quality not VALID, or no points came back. Callers show nothing in that case.
 */
/* ONE ANALYSIS PER QUESTION, EVEN WHILE IT IS STILL RUNNING. The completed
 * results are memoised by the callers, but two subscribers that ask the same
 * question before either answer lands both miss the cache and both pay for
 * the same Grail scan. The Overview does exactly that on first render: the
 * card's projection and the sessions chart ask for the sessions forecast at
 * the same moment. A pending promise per expression lets the second one wait
 * on the first instead of buying it twice. */
const inFlight = new Map<string, Promise<Forecast | null>>();

export function forecast(expression: string, horizon = 12): Promise<Forecast | null> {
  const key = `${horizon}|${expression}`;
  const running = inFlight.get(key);
  if (running) return running;
  const p = runForecast(expression, horizon).finally(() => { inFlight.delete(key); });
  inFlight.set(key, p);
  return p;
}

async function runForecast(expression: string, horizon = 12): Promise<Forecast | null> {
  try {
    const res = await analyzersClient.executeAnalyzer({
      analyzerName: ANALYZER,
      body: { timeSeriesData: { expression }, forecastHorizon: horizon } as never,
    });
    const result = res.requestToken ? await poll(res.requestToken) : res.result;
    if (result.executionStatus !== "COMPLETED") return null;

    const out = (result.output as never as Array<Record<string, never>>)?.[0];
    // the analyzer states whether its own forecast is sound; anything but VALID
    // is not worth putting in front of someone
    if ((out as never as { forecastQualityAssessment?: string })
      ?.forecastQualityAssessment !== "VALID") return null;

    const rec = (out as never as {
      timeSeriesDataWithPredictions?: { records?: Array<Record<string, unknown>> };
    }).timeSeriesDataWithPredictions?.records?.[0];
    if (!rec) return null;

    const point = (rec["dt.davis.forecast:point"] as number[]) ?? [];
    const lower = (rec["dt.davis.forecast:lower"] as number[]) ?? [];
    const upper = (rec["dt.davis.forecast:upper"] as number[]) ?? [];
    if (!point.length) return null;

    /* the record echoes the series it was given, under the alias the
       expression named; find it by shape rather than by guessing the name */
    const inputs = Object.entries(rec)
      .filter(([k, v]) => Array.isArray(v) && !k.startsWith("dt.davis.forecast:"))
      .map(([, v]) => v as Array<number | null>);
    const measured = inputs.find((a) => a.length >= point.length) ?? inputs[0] ?? [];
    /* ABSENT, NOT IDLE. The first cut called a series empty when nothing in
       it was a non-zero number — which is also true of an instrumented
       service that simply had no traffic in the history, and saying "no
       request metric for this service" about a service that publishes one
       and sat idle is a different falsehood from the one this was fixing.
       Absence is the absence of SAMPLES: every point null. A run of zeros is
       a measurement, and zero is a legitimate thing to forecast. */
    const emptyInput = measured.length > 0 && measured.every((n) => n == null);

    return {
      point, lower, upper,
      total: point.reduce((a, b) => a + b, 0),
      slope: point[point.length - 1] - point[0],
      horizon: point.length,
      intervalMs: Number(rec.interval ?? 0) / 1e6,
      emptyInput,
    };
  } catch {
    // no scope, analyzer unavailable, or the query returned nothing usable
    return null;
  }
}

/**
 * ONE rule for every forecast this app draws over RUM.
 *
 * A forecast needs history, and on Grail history is money: the scan is LINEAR
 * in the window, measured at about 1.4 GB per hour for a live estate's busiest
 * application. The old rule asked for three times the visible window with no
 * ceiling, so a thirty-day view quietly asked the analyzer for NINETY DAYS —
 * past the platform's 500 GB scan limit, which is why a wide window felt slow
 * and answered from a partial scan.
 *
 * So history is three windows OR twenty-four hours, whichever is smaller. The
 * bin is then sized off that history rather than off the window, which keeps
 * about thirty-four points behind every projection no matter how wide the view
 * is, and the horizon is half of them. A two-hour view forecasts three hours
 * from six, a thirty-day view forecasts twelve hours from twenty-four — and
 * neither can cost more than one day of scan.
 */
export const FC_HIST_CAP_MIN = 1440;

/**
 * THE HISTORY ENDS WHERE THE WINDOW ENDS.
 *
 * Every forecast here read `from: now()-<history>` and gave the analyzer no
 * end bound, so on a historical selection it trained on the traffic of RIGHT
 * NOW and the result was then presented as that selection's next window — the
 * chain used it in that window's verdict, the Overview appended it to that
 * window's chart, and Business Control called it "next". A projection of the
 * wrong hours, labelled with the right ones.
 *
 * A live window is unchanged: the history still runs back from now(). A
 * shifted one gets absolute bounds computed from tf.to, which is the form
 * tfFrom already emits for everything else on such a window.
 */
export function histWindow(
  tf: { to: string }, histMin: number,
): { from: string; to: string } {
  const v = tf.to.trim().replace(/^"(.*)"$/, "$1");
  if (/^now\(?\)?$/i.test(v)) return { from: `now()-${histMin}m`, to: "now()" };
  /* A SHIFTED WINDOW IS OFTEN STILL RELATIVE. tfFrom emits `now()-2h` for the
     END of a range like from=-4h,to=-2h, and the first cut of this function
     only recognised the literal `now()`: everything else went to new Date(),
     which cannot parse `now()-2h`, so it fell back to anchoring on now() —
     the exact defect this function exists to fix, surviving in the case that
     needed it most. Relative ends are resolved here instead of being handed
     to a Date constructor that has no idea what they mean. */
  const MIN: Record<string, number> = { s: 1 / 60, m: 1, h: 60, d: 1440, w: 10080 };
  const rel = /^now\(?\)?\s*-\s*(\d+)\s*([smhdw])$/i.exec(v);
  if (rel) {
    /* A RELATIVE END STAYS RELATIVE. Resolving it against Date.now() produced
       a different ISO string on every call, so two subscribers asking the same
       question a millisecond apart built two different expressions — and the
       in-flight dedupe, which keys on the expression, missed and bought the
       same analyzer scan twice. That is the defect the dedupe exists to stop,
       recreated by the fix for a different one.
       Offsets compose, so the whole window can stay in the grammar it arrived
       in: an end of now()-2h with six hours of history is now()-480m to
       now()-120m, the same two strings every time. */
    const offMin = Math.round(Number(rel[1]) * MIN[rel[2].toLowerCase()]);
    return { from: `now()-${offMin + histMin}m`, to: `now()-${offMin}m` };
  }
  const endMs = new Date(v).getTime();
  if (!Number.isFinite(endMs)) return { from: `now()-${histMin}m`, to: "now()" };
  const end = new Date(endMs);
  const start = new Date(endMs - histMin * 6e4);
  return { from: `"${start.toISOString()}"`, to: `"${end.toISOString()}"` };
}

export interface ForecastPlan {
  /** History to read, as a DQL duration. */
  hist: string;
  /** Bin width for the series, as a DQL duration. */
  bin: string;
  /** Points to project. */
  horizon: number;
  /** How far ahead that reaches, in words. */
  ahead: string;
  /** True when the window wanted more history than the ceiling allows. */
  capped: boolean;
  /** The history, in minutes — for callers that need to bound it explicitly. */
  histMin: number;
}

export function forecastPlan(windowMinutes: number): ForecastPlan {
  const histMin = Math.max(60, Math.min(Math.round(windowMinutes * 3), FC_HIST_CAP_MIN));
  /* THE BIN IS THE WINDOW'S, NOT THE HISTORY'S — and getting this wrong made
   * the chart lie. The measured series is binned by binMinutesFor(window);
   * the plan binned by binMinutesFor(history), which is three times longer.
   * Measured: 2h → 5-minute bins. Forecast, before this: 15-minute bins. Both
   * are then plotted against each other in the card bars and in MetricChart,
   * so a perfectly steady two requests a minute drew measured points of 10
   * beside predicted points of 30 — an invented tripling, in the one part of
   * the screen that claims to say what happens next.
   * Measured across the windows this app offers, the mismatch was 5x at 30
   * minutes, 3x at 2 hours and 4x at 6; only the 24-hour window agreed by
   * accident. The history cap stays — it is what keeps a wide window from
   * billing like one — but the bin now matches what it is drawn beside. */
  const binMin = binMinutesFor(windowMinutes);
  const points = Math.max(4, Math.floor(histMin / binMin));
  // The future never dwarfs the present: the projection reaches about a third
  // of the visible window, and never further than half the history behind it.
  // Without the first bound a two-hour view drew three hours of guess after
  // two hours of fact; without the second, a wide view would project days off
  // one capped day of history.
  const horizon = Math.min(
    Math.max(4, Math.round(points / 2)),
    Math.max(4, Math.round(windowMinutes / 3 / binMin)),
  );
  return {
    hist: durStr(histMin),
    bin: durStr(binMin),
    horizon,
    ahead: durStr(binMin * horizon),
    capped: windowMinutes * 3 > FC_HIST_CAP_MIN,
    histMin,
  };
}

/** How far ahead a forecast actually reached, from the analyzer's own answer —
 *  never a hardcoded label, so the words cannot drift from the projection. */
export const aheadOf = (fc: Forecast) =>
  durStr(Math.max(1, Math.round((fc.horizon * fc.intervalMs) / 60000)));
