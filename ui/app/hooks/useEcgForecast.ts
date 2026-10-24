// The future of ONE metric, on demand.
//
// The card's numbers are clickable, and clicking one asks the platform's
// analyzer where that metric is heading. Only the metric asked for is
// forecast: an analyzer execution takes seconds, and running four of them so
// three can go unread is spend with no reader.
//
// The model reads three windows of history at the chart's own bin width — a
// forecast needs more past than the screen shows — while the horizon stays
// about a third of the visible span, so the future never dwarfs the present.
import { useEffect, useState } from "react";
import { useMemoGen } from "../utils/memo";
import { calibrate, forecast, forecastPlan, type Forecast , histWindow } from "../utils/forecast";
import { qMetricForecastExpr, seriesEnd, withinSessionLag, type Timeframe } from "../utils/dql";
import { OPTIONAL_SCAN_BUDGET_GIB } from "../utils/cost";

/** The metrics that have a real per-bin series behind them. */
export type Metric = "sessions" | "errors" | "actions" | "requests";

export const METRIC_LABEL: Record<Metric, string> = {
  sessions: "sessions", errors: "errors",
  actions: "user actions", requests: "web requests",
};

// History, bin and horizon all come from forecastPlan now — the single rule
// shared with the chain's own projection. What used to live here asked for
// three times the visible window at the CHART's bin width, uncapped: on a
// thirty-day view that is ninety days of user.events per metric, four metrics
// deep, every one of them past the platform's 500 GB scan limit. That is the
// slowness a wide window showed, and the numbers it returned came from a
// partial scan. The plan caps history at one day and sizes the bin off the
// history, so the projection keeps its points and the window keeps its cost.

const AGG: Record<Metric, string> = {
  sessions: "sessions = countDistinct(dt.rum.session.id)",
  errors: `errors = countIf(characteristics.classifier == "error", default: 0)`,
  actions: `actions = countIf(characteristics.classifier == "user_action", default: 0)`,
  requests: `requests = countIf(characteristics.classifier == "request", default: 0)`,
};
/* ONLY THE EVENTS THE COUNT COUNTS. The classifier filter is the one
   predicate that cuts what Grail reads (measured in production: a country
   or session-hash filter still read the full 264 GB; a classifier filter
   read 41). A count of requests over a 3-hour history read every event the
   application emitted — 405 GiB per forecast — to count one kind of them.
   Same count, fewer bytes; `default: 0` keeps a bin with none of that kind
   at zero, exactly as the unfiltered count had it. Sessions count every
   event, so they keep the full scan. */
const ONLY: Partial<Record<Metric, string>> = {
  errors: `\n| filter characteristics.classifier == "error"`,
  actions: `\n| filter characteristics.classifier == "user_action"`,
  requests: `\n| filter characteristics.classifier == "request"`,
};

const memo = new Map<string, Forecast | null>();

/** Forecast for one metric, or null while loading / when it is not sound. */
/**
 * `frontendName` moves the SESSIONS forecast onto `user.sessions`.
 *
 * Without it the projection trained on a different population from the chart
 * it is drawn over: the series counted every session with an event in a bin
 * while the chart, the headline and the hand-off had all moved to the store
 * the platform lists. The screen said "peak 13" under "forecast ~258 next
 * 40m" — two true numbers about two different things, which is the whole
 * class of defect this app has spent the week removing.
 *
 * The other three metrics are event counts and stay where events live.
 */
/* SESSIONS AND REQUESTS TRAIN ON THE METRIC STORE TOO, CALIBRATED (0.16.24).
 * Measured on production they were 58% of every Overview open: 328 GiB for
 * sessions (inside the session store's lag the history fell back to three
 * hours of raw events) and 162 GiB for requests. The metrics answer the same
 * history for ~0 GiB, but neither counts exactly what the chart draws —
 * sessions read 1.4–4.6% apart, requests 22%. So the metric forecast is
 * rescaled by k = drawn ÷ metric over the bins both hold, and it is only kept
 * when that ratio is STABLE (first half and second half of the overlap agree
 * within 10%): a constant offset is a scale, a drifting one is a different
 * population. Anything else — no overlap, a metric with no samples, a ratio
 * that drifts — falls back to the event history exactly as before. `ref` is
 * the series the card and the chart draw; null while it loads. */
const CALIBRATED: Partial<Record<Metric, true>> = { sessions: true, requests: true };

export function ratioTo(
  f: Forecast, ref: ReadonlyArray<{ t: string; v: number }>, askedStart: number | null,
): number | string {
  /* The analyzer's record may not echo the timeframe; the history's start is
     then known from the request itself — `timeseries` floors it to the bin. */
  const start = f.start ?? (askedStart !== null && f.intervalMs > 0
    ? Math.floor(askedStart / f.intervalMs) * f.intervalMs : null);
  if (start === null || !(f.intervalMs > 0)) return "the metric series carried no timeframe";
  /* EDGE BINS ARE PARTIAL BY CONSTRUCTION. The drawn series' first bin holds
     only the part of it after the window's start, and its last ones are still
     filling (beacons land minutes late) — while the metric's bins over the
     same times are whole. Compared, they read as a drift that is not there.
     Only the settled middle calibrates. */
  const settled = ref.slice(1, -2);
  const pairs: Array<[number, number]> = [];
  for (const r of settled) {
    const t = Date.parse(r.t);
    if (!Number.isFinite(t)) continue;
    const m = f.measured[Math.round((t - start) / f.intervalMs)];
    if (m != null && m > 0 && r.v > 0) pairs.push([r.v, m]);
  }
  if (pairs.length < 6) return `only ${pairs.length} bins overlap the drawn series`;
  const k = (a: Array<[number, number]>) =>
    a.reduce((x, p) => x + p[0], 0) / a.reduce((x, p) => x + p[1], 0);
  const h = Math.floor(pairs.length / 2);
  const all = k(pairs);
  const drift = Math.abs(k(pairs.slice(0, h)) - k(pairs.slice(h))) / all;
  return drift <= 0.1 ? all
    : `its ratio to the drawn series drifted ${Math.round(drift * 100)}% across the window`;
}

/** Why a projection is absent, by key — for the chart's "not sound" tooltip. */
const whyMemo = new Map<string, string>();

export function useMetricForecast(
  ...a: Parameters<typeof useMetricForecastWhy>
): Forecast | null {
  return useMetricForecastWhy(...a).fc;
}

/** The projection, and — when there is none — the reason, in one sentence. */
export function useMetricForecastWhy(
  rumAppId?: string, tf?: Timeframe, metric?: Metric | null,
  frontendName?: string, ref?: ReadonlyArray<{ t: string; v: number }> | null,
  /** GiB the window's own event scan read; null while unknown. An event
   *  history is only run when its estimate stays within the guardrail. */
  windowScanGiB?: number | null,
  /** True when `ref` was drawn from the very metric the forecast trains on
   *  (the Overview's metric-store series, 0.17.0): there is no second
   *  population to calibrate against, so the projection is used as it comes.
   *  Calibrating anyway is what hid it — the analyzer does not echo the
   *  history it trained on, so the overlap was always empty. */
  sameSource = false,
): { fc: Forecast | null; why: string | null } {
  const gen = useMemoGen();
  const fe = frontendName || "";
  const key = rumAppId && tf && metric
    ? `${rumAppId}|${tf.from}|${tf.to}|${metric}|${fe}|${gen}` : "";
  const [fc, setFc] = useState<Forecast | null>(key ? memo.get(key) ?? null : null);
  const [why, setWhy] = useState<string | null>(key ? whyMemo.get(key) ?? null : null);

  useEffect(() => {
    if (!key) { setFc(null); setWhy(null); return; }
    if (memo.has(key)) { setFc(memo.get(key) ?? null); setWhy(whyMemo.get(key) ?? null); return; }
    setWhy(null);

    const viaMetric = !!(metric && CALIBRATED[metric] && fe && ref !== undefined);
    // calibration needs the drawn series; wait for it rather than guess
    if (viaMetric && !ref?.length) { setFc(null); return; }

    let live = true;
    setFc(null);
    const plan = forecastPlan(tf!.minutes);
    /* bounded by the SELECTED window, not by now() — see histWindow */
    const win = histWindow(tf!, plan.histMin);
    /* `time: start_time` because a row of `user.sessions` IS a session: it
       belongs to the bin it began in, not to every bin it spanned. The same
       anchor qSessionSeries uses, so the drawn series and the forecast's
       training series are the one series. */
    // the session store is empty inside its own lag — train on events there
    /* ERRORS, REQUESTS AND ACTIONS TRAIN ON THE METRIC STORE. Measured on
       production: every analyzer poll blocks ~2 s and the raw-event history
       behind it is the slow part; the same counter as a `timeseries` answers
       in ~200 ms and is the analyzer's documented input. The history keeps
       the plan's length and bin, and ends where the live series ends. */
    /* …EXCEPT REQUESTS. Bin by bin on a production capture the request
       metric runs 22% above the request events the card and its bars count;
       a band trained on it would be drawn over a different population. Errors
       and actions matched within 0.2% and stay on the metric. */
    const expr = (metric === "errors" || metric === "actions") && fe
      ? qMetricForecastExpr(metric, fe, win.from, seriesEnd({ ...tf!, to: win.to }), plan.bin)
      : metric === "sessions" && fe && !withinSessionLag(tf!)
      ? `fetch user.sessions, from: ${win.from}, to: ${seriesEnd({ ...tf!, to: win.to })}
| expand fe = frontend.name
| filter fe == "${fe.replace(/["\\]/g, "")}"
| makeTimeseries sessions = countDistinct(dt.rum.session.id), time: start_time, interval: ${plan.bin}`
      : `fetch user.events, from: ${win.from}, to: ${win.to}
| filter dt.rum.application.id == "${rumAppId!.replace(/"/g, "")}"${ONLY[metric!] ?? ""}
| makeTimeseries ${AGG[metric!]}, interval: ${plan.bin}`;
    const done = (f: Forecast | null, reason?: string) => {
      memo.set(key, f);
      if (!f && reason) whyMemo.set(key, reason);
      if (live) { setFc(f); setWhy(f ? null : reason ?? null); }
    };
    const NO_SOUND = "the platform's analyzer returned no sound projection";
    /* THE GUARDRAIL (utils/cost.ts): an event history is run only when the
       window's measured scan, stretched to the history's length, stays inside
       the budget. Unknown counts as over — a customer's bill is not the place
       to find out. Metric-store histories cost nothing and are never held. */
    const eventScan = /^\s*fetch /.test(expr);
    const est = windowScanGiB != null ? windowScanGiB * (plan.histMin / tf!.minutes) : null;
    const affordable = windowScanGiB === undefined
      || (est !== null && est <= OPTIONAL_SCAN_BUDGET_GIB);
    /* Not decided yet is not "no": the window's scan has not been measured,
       so wait for it instead of memoising a refusal for the whole session. */
    if (eventScan && !viaMetric && windowScanGiB === null) { live = false; setFc(null); return; }
    const held = `the event history would read ${est === null ? "an unmeasured amount"
      : `≈${Math.round(est)} GiB`} — over the ${OPTIONAL_SCAN_BUDGET_GIB} GiB guardrail for optional reads`;
    const history = () => (!eventScan || affordable
      ? forecast(expr, plan.horizon) : Promise.resolve(null));
    if (!viaMetric) {
      history().then((f) => done(f, !eventScan || affordable ? NO_SOUND : held));
    } else {
      // the history's start as asked, for when the record does not echo it
      const rel = /^now\(\)-(\d+)m$/.exec(win.from.trim());
      const askedStart = rel ? Date.now() - Number(rel[1]) * 60000
        : Number.isFinite(Date.parse(win.from.replace(/"/g, "")))
          ? Date.parse(win.from.replace(/"/g, "")) : null;
      forecast(qMetricForecastExpr(metric as "sessions" | "requests", fe, win.from,
        seriesEnd({ ...tf!, to: win.to }), plan.bin), plan.horizon)
        .then((f) => {
          if (!f) return done(null, `${NO_SOUND} from the metric history`);
          if (sameSource) return done({ ...f, basis: { k: 1 } });
          const k = f.emptyInput ? "the metric has no samples" : ratioTo(f, ref!, askedStart);
          if (typeof k === "number") return done(calibrate(f, k));
          return history().then((e) => done(e && { ...e, basis: { why: k } },
            `the metric was not used (${k}); ${affordable ? `${NO_SOUND} from the event history` : held}`));
        });
    }

    return () => { live = false; };
  }, [key, rumAppId, tf, metric, fe, !!ref?.length, windowScanGiB == null]);

  return { fc, why };
}
