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
import { forecast, type Forecast } from "../utils/forecast";
import { binFor, durStr, type Timeframe } from "../utils/dql";

/** The metrics that have a real per-bin series behind them. */
export type Metric = "sessions" | "errors" | "actions" | "requests";

export const METRIC_LABEL: Record<Metric, string> = {
  sessions: "sessions", errors: "errors",
  actions: "user actions", requests: "web requests",
};

/** Three windows of history at the chart's own bin width, and a horizon of
 *  about a third of the visible span — derived, so any window the selector
 *  offers is covered, not just four presets. */
const histOf = (tf: Timeframe) => durStr(tf.minutes * 3);
const horizonOf = (tf: Timeframe) => {
  const bin = tf.minutes / 34;
  return Math.max(6, Math.min(24, Math.round((tf.minutes / 3) / Math.max(bin, 1))));
};

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
    forecast(`fetch user.events, from: now()-${histOf(tf!)}
| filter dt.rum.application.id == "${rumAppId!.replace(/"/g, "")}"
| makeTimeseries ${AGG[metric!]}, interval: ${binFor(tf!.minutes)}`, horizonOf(tf!))
      .then((f) => { memo.set(key, f); if (live) setFc(f); });

    return () => { live = false; };
  }, [key, rumAppId, tf, metric]);

  return fc;
}
