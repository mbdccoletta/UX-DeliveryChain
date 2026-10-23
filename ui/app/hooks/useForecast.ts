// Whether the selected application is heading somewhere worse.
//
// The chain highlights only what a signal backs — problems, anomalies, custom
// alerts — and the forecast is the fourth signal: the platform's own
// predictive analyzer, run over this application's error series. Fetched
// lazily and memoised per application AND window, because an analyzer
// execution takes seconds and the answer does not change while the user
// looks at the screen.
//
// It used to read a fixed twenty-four hours and project a fixed twelve,
// whatever the selector said — so a reader on a thirty-day view was shown a
// number from a window they had not chosen, labelled with a horizon nobody
// had derived. Both now come from forecastPlan, the one rule every RUM
// forecast in this app obeys, and the label is read back off the analyzer's
// own answer rather than typed into the markup.
import { useEffect, useState } from "react";
import { useMemoGen } from "../utils/memo";
import { forecast, forecastPlan, type Forecast , histWindow } from "../utils/forecast";
import { qEventErrorRateExpr, qMetricErrorRateExpr, qMetricForecastExpr, type Timeframe } from "../utils/dql";

const memo = new Map<string, Forecast | null>();

export function useAppForecast(
  appId?: string, tf?: Timeframe, frontendName?: string,
  /** "errors" projects the error COUNT (what the cards print); "errorRate"
   *  projects errors per user action — what the verdict judges, because a
   *  count rises with traffic and more people is not a degradation. */
  kind: "errors" | "errorRate" = "errors",
): Forecast | null {
  const gen = useMemoGen();
  const fe = frontendName || "";
  const key = appId && tf ? `${kind}|${appId}|${tf.from}|${tf.to}|${fe}|${gen}` : "";
  const [ahead, setAhead] = useState<Forecast | null>(key ? memo.get(key) ?? null : null);

  useEffect(() => {
    if (!key || !appId || !tf) { setAhead(null); return; }
    if (memo.has(key)) { setAhead(memo.get(key) ?? null); return; }
    let live = true;
    setAhead(null);
    const plan = forecastPlan(tf.minutes);
    /* bounded by the SELECTED window, not by now() — see histWindow */
    const win = histWindow(tf!, plan.histMin);
    // the error series from the metric store when the frontend is known —
    // ~200 ms instead of a raw-event scan; see qMetricForecastExpr
    forecast(
      kind === "errorRate"
        ? (fe ? qMetricErrorRateExpr(fe, win.from, win.to, plan.bin)
           : qEventErrorRateExpr(appId, win.from, win.to, plan.bin))
      : fe ? qMetricForecastExpr("errors", fe, win.from, win.to, plan.bin)
         : `fetch user.events, from: ${win.from}, to: ${win.to}
       | filter dt.rum.application.id == "${appId.replace(/"/g, "")}"
       | makeTimeseries errors = countIf(characteristics.classifier == "error"), interval: ${plan.bin}`,
      plan.horizon,
    ).then((f) => { memo.set(key, f); if (live) setAhead(f); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return ahead;
}
