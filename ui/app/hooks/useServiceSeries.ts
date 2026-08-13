// Throughput over time across the services one application actually calls.
//
// The other three cards chart a RUM series they already hold; the services card
// had none, and reusing the browser's request series under a "called services"
// label would have been a different measurement wearing the same word. This is
// the real one: `dt.service.request.count` summed over the scoped services,
// from the metric store — the same source the service forecasts use, which was
// measured at 0 scanned bytes.
import { useEffect, useState } from "react";
import { binFor, runDql, type Timeframe } from "../utils/dql";
import { forecast } from "../utils/forecast";

export interface ServiceSeries {
  /** One value per bin. */
  series: number[];
  /** The analyzer's projection of that same expression, or null when it
   *  declined — the card then draws history alone rather than a guess. */
  fc: number[] | null;
}

const memo = new Map<string, ServiceSeries>();

/** The series and its projection, or null while loading / nothing scoped. */
export function useServiceSeries(
  serviceIds: string[], tf: Timeframe, active = true,
): ServiceSeries | null {
  // sorted so the same set of services is the same cache key whatever order
  // the scope resolved them in
  const ids = [...serviceIds].sort();
  const key = active && ids.length ? `${ids.join(",")}|${tf.from}|${tf.to}` : "";
  const [series, setSeries] = useState<ServiceSeries | null>(
    key ? memo.get(key) ?? null : null);

  useEffect(() => {
    if (!key) { setSeries(null); return; }
    const hit = memo.get(key);
    if (hit) { setSeries(hit); return; }

    setSeries(null);
    let live = true;
    (async () => {
      try {
        // capped: the filter is an OR chain and a 200-service application would
        // build a query longer than the point of the chart
        const list = ids.slice(0, 40)
          .map((i) => `dt.entity.service == "${i.replace(/["\\]/g, "")}"`).join(" or ");
        // ONE expression, measured and projected — a second one written for
        // the forecast could drift from the bars it is drawn beside
        const expr = `timeseries calls = sum(dt.service.request.count),
             filter: { ${list} },
             from: ${tf.from}, to: ${tf.to}, interval: ${binFor(tf.minutes)}`;
        const [rows, ahead] = await Promise.all([
          runDql<{ calls?: (number | null)[] }>(expr, 1),
          forecast(expr, 8).catch(() => null),
        ]);
        const out: ServiceSeries = {
          series: (rows[0]?.calls ?? []).map((v) => Number(v) || 0),
          fc: ahead?.point ?? null,
        };
        memo.set(key, out);
        if (live) setSeries(out);
      } catch {
        // the card keeps its numbers and simply draws no bars
        if (live) setSeries({ series: [], fc: null });
      }
    })();

    return () => { live = false; };
  }, [key, tf, ids.join(",")]);

  return series;
}
