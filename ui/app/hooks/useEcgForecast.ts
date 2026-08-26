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
import { forecast, forecastPlan, type Forecast } from "../utils/forecast";
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
export function useMetricForecast(
  rumAppId?: string, tf?: Timeframe, metric?: Metric | null,
): Forecast | null {
  const key = rumAppId && tf && metric
    ? `${rumAppId}|${tf.from}|${tf.to}|${metric}` : "";
  const [fc, setFc] = useState<Forecast | null>(key ? memo.get(key) ?? null : null);

  useEffect(() => {
    if (!key) { setFc(null); return; }
    if (memo.has(key)) { setFc(memo.get(key) ?? null); return; }

    let live = true;
    setFc(null);
    const plan = forecastPlan(tf!.minutes);
    forecast(`fetch user.events, from: now()-${plan.hist}
| filter dt.rum.application.id == "${rumAppId!.replace(/"/g, "")}"
| makeTimeseries ${AGG[metric!]}, interval: ${plan.bin}`, plan.horizon)
      .then((f) => { memo.set(key, f); if (live) setFc(f); });

    return () => { live = false; };
  }, [key, rumAppId, tf, metric]);

  return fc;
}
