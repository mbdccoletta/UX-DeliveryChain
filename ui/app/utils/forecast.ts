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
export async function forecast(expression: string, horizon = 12): Promise<Forecast | null> {
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

    return {
      point, lower, upper,
      total: point.reduce((a, b) => a + b, 0),
      slope: point[point.length - 1] - point[0],
      horizon: point.length,
      intervalMs: Number(rec.interval ?? 0) / 1e6,
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
 * in the window, measured at about 1.4 GB per hour for this tenant's busiest
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
}

export function forecastPlan(windowMinutes: number): ForecastPlan {
  const histMin = Math.max(60, Math.min(Math.round(windowMinutes * 3), FC_HIST_CAP_MIN));
  const binMin = binMinutesFor(histMin);
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
  };
}

/** How far ahead a forecast actually reached, from the analyzer's own answer —
 *  never a hardcoded label, so the words cannot drift from the projection. */
export const aheadOf = (fc: Forecast) =>
  durStr(Math.max(1, Math.round((fc.horizon * fc.intervalMs) / 60000)));
