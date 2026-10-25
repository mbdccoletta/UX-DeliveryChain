import { svcIs } from "../utils/dql";
// Where each backend service is heading, one analyzer run per service.
//
// The projection rides the metric store, not Grail: `dt.service.request.count`
// and its failure counterpart are pre-aggregated series, so a forecast per
// service costs zero scanned bytes — measured on a live estate. What it does
// cost is an analyzer execution each, which is why the list is capped and
// nothing runs until the user opens the drill-down.
//
// Failures are only forecast where failures exist: projecting a flat zero
// wastes a run to draw a line along the axis.
import { useEffect, useState } from "react";
import { useMemoGen } from "../utils/memo";
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
     filter: { ${svcIs(id)} },
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
  const gen = useMemoGen();
  const key = `${targets.map((t) => t.id).join(",")}|${gen}`;
  const [rows, setRows] = useState<ServiceAhead[]>([]);

  useEffect(() => {
    if (!enabled || !targets.length) { setRows([]); return; }
    let live = true;
    // seed the list immediately so the panel opens with names and volumes,
    // and each forecast fills its own row when it arrives
    /* THE GENERATION BELONGS IN THE ENTRY, not only in the effect key.
       Refresh changed the key, so the effect re-ran — and then every row was
       served from an entry still stored under the bare service id, so no
       analyzer was called again. The panel paired refreshed measurements with
       projections from before the refresh, and a cached null could never be
       retried at all. */
    const slot = (id: string) => `${id}|${gen}`;
    setRows(targets.map((t) => ({
      ...t, thr: memo.get(slot(t.id))?.thr ?? null,
      fails: memo.get(slot(t.id))?.fails ?? null,
      done: memo.has(slot(t.id)),
    })));

    targets.filter((t) => !memo.has(slot(t.id))).forEach(async (t) => {
      const thr = await forecast(expr("dt.service.request.count", t.id), 12);
      // a service with no measured failures gets no failure projection
      const fails = await forecast(expr("dt.service.request.failure_count", t.id), 12);
      const hit = { thr, fails: fails && fails.total >= 1 ? fails : null };
      memo.set(slot(t.id), hit);
      if (live) {
        setRows((prev) => prev.map((r) =>
          r.id === t.id ? { ...r, ...hit, done: true } : r));
      }
    });

    return () => { live = false; };
  }, [key, enabled]);

  return rows;
}
