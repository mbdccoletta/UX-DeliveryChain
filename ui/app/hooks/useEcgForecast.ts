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
import { forecast, forecastPlan, type Forecast , histWindow } from "../utils/forecast";
import type { Timeframe } from "../utils/dql";

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
  errors: `errors = countIf(characteristics.classifier == "error")`,
  actions: `actions = countIf(characteristics.classifier == "user_action")`,
  requests: `requests = countIf(characteristics.classifier == "request")`,
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
export function useMetricForecast(
  rumAppId?: string, tf?: Timeframe, metric?: Metric | null,
  frontendName?: string,
): Forecast | null {
  const gen = useMemoGen();
  const fe = frontendName || "";
  const key = rumAppId && tf && metric
    ? `${rumAppId}|${tf.from}|${tf.to}|${metric}|${fe}|${gen}` : "";
  const [fc, setFc] = useState<Forecast | null>(key ? memo.get(key) ?? null : null);

  useEffect(() => {
    if (!key) { setFc(null); return; }
    if (memo.has(key)) { setFc(memo.get(key) ?? null); return; }

    let live = true;
    setFc(null);
    const plan = forecastPlan(tf!.minutes);
    /* bounded by the SELECTED window, not by now() — see histWindow */
    const win = histWindow(tf!, plan.histMin);
    /* `time: start_time` because a row of `user.sessions` IS a session: it
       belongs to the bin it began in, not to every bin it spanned. The same
       anchor qSessionSeries uses, so the drawn series and the forecast's
       training series are the one series. */
    const expr = metric === "sessions" && fe
      ? `fetch user.sessions, from: ${win.from}, to: ${win.to}
| expand fe = frontend.name
| filter fe == "${fe.replace(/["\\]/g, "")}"
| makeTimeseries sessions = countDistinct(dt.rum.session.id), time: start_time, interval: ${plan.bin}`
      : `fetch user.events, from: ${win.from}, to: ${win.to}
| filter dt.rum.application.id == "${rumAppId!.replace(/"/g, "")}"
| makeTimeseries ${AGG[metric!]}, interval: ${plan.bin}`;
    forecast(expr, plan.horizon)
      .then((f) => { memo.set(key, f); if (live) setFc(f); });

    return () => { live = false; };
  }, [key, rumAppId, tf, metric, fe]);

  return fc;
}
