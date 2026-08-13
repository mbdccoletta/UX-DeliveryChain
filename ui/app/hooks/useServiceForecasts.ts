// Where each backend service is heading, one analyzer run per service.
//
// The projection rides the metric store, not Grail: `dt.service.request.count`
// and its failure counterpart are pre-aggregated series, so a forecast per
// service costs zero scanned bytes — measured on this tenant. What it does
// cost is an analyzer execution each, which is why the list is capped and
// nothing runs until the user opens the drill-down.
//
// Failures are only forecast where failures exist: projecting a flat zero
// wastes a run to draw a line along the axis.
import { useEffect, useState } from "react";
import { forecast, type Forecast } from "../utils/forecast";

export interface ServiceAhead {
  id: string;
  name: string;
  /** Traces observed for this service — the order the list is worth reading in. */
  traces: number;
  /** Projected request volume, or null when the analyzer refused. */
  thr: Forecast | null;
  /** Projected failures, only attempted where failures were measured. */
  fails: Forecast | null;
  /** False while its two analyses are still running. */
  done: boolean;
}

export interface ServiceTarget { id: string; name: string; traces: number }

/** How many services may be projected at once — an analyzer is not free. */
export const SERVICE_FORECAST_CAP = 6;

const memo = new Map<string, { thr: Forecast | null; fails: Forecast | null }>();

const expr = (metric: string, id: string) =>
  `timeseries v = sum(${metric}),
     filter: { dt.entity.service == "${id.replace(/"/g, "")}" },
     from: now()-24h, interval: 1h`;

/**
 * Forecasts for the given services, filled in as each analysis lands.
 *
 * `enabled` gates the whole thing: the drill-down is closed most of the time,
 * and a closed panel must not spend.
 */
export function useServiceForecasts(
  targets: ServiceTarget[], enabled: boolean,
): ServiceAhead[] {
  const key = targets.map((t) => t.id).join(",");
  const [rows, setRows] = useState<ServiceAhead[]>([]);

  useEffect(() => {
    if (!enabled || !targets.length) { setRows([]); return; }
    let live = true;
    // seed the list immediately so the panel opens with names and volumes,
    // and each forecast fills its own row when it arrives
    setRows(targets.map((t) => ({
      ...t, thr: memo.get(t.id)?.thr ?? null, fails: memo.get(t.id)?.fails ?? null,
      done: memo.has(t.id),
    })));

    targets.filter((t) => !memo.has(t.id)).forEach(async (t) => {
      const thr = await forecast(expr("dt.service.request.count", t.id), 12);
      // a service with no measured failures gets no failure projection
      const fails = await forecast(expr("dt.service.request.failure_count", t.id), 12);
      const hit = { thr, fails: fails && fails.total >= 1 ? fails : null };
      memo.set(t.id, hit);
      if (live) {
        setRows((prev) => prev.map((r) =>
          r.id === t.id ? { ...r, ...hit, done: true } : r));
      }
    });

    return () => { live = false; };
  }, [key, enabled]);

  return rows;
}
