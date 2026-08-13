// p50/p90/p95 and failures for every scoped service, in one metric-store read.
//
// The services panel used to show only projections — what each service is
// heading toward, with nothing about where it is now. These are the measured
// numbers that go beside them.
import { useEffect, useState } from "react";
import { qServiceVitals, runDql, type Timeframe } from "../utils/dql";

export interface ServiceVitals {
  /** Nanoseconds — the metric store's microseconds are scaled in the query. */
  p50: number; p90: number; p95: number;
  calls: number; fails: number;
  /** `dt.service.name` verbatim — the value the Services Explorer filters on. */
  name?: string;
}

const memo = new Map<string, Map<string, ServiceVitals>>();

/** Vitals keyed by service id, or null while loading. */
export function useServiceVitals(
  serviceIds: string[], tf: Timeframe, active = true,
): Map<string, ServiceVitals> | null {
  const ids = [...serviceIds].sort();
  const key = active && ids.length ? `${ids.join(",")}|${tf.from}|${tf.to}` : "";
  const [out, setOut] = useState<Map<string, ServiceVitals> | null>(
    key ? memo.get(key) ?? null : null);

  useEffect(() => {
    if (!key) { setOut(null); return; }
    const hit = memo.get(key);
    if (hit) { setOut(hit); return; }

    setOut(null);
    let live = true;
    (async () => {
      try {
        const rows = await runDql<Record<string, unknown>>(qServiceVitals(tf, ids), 40);
        const m = new Map<string, ServiceVitals>(rows.map((r) => [String(r.id), {
          p50: Number(r.p50) || 0, p90: Number(r.p90) || 0, p95: Number(r.p95) || 0,
          calls: Number(r.calls) || 0, fails: Number(r.fails) || 0,
          name: r.name == null ? undefined : String(r.name),
        }]));
        memo.set(key, m);
        if (live) setOut(m);
      } catch {
        // the panel keeps its projections and simply shows no measured columns
        if (live) setOut(new Map());
      }
    })();

    return () => { live = false; };
  }, [key, tf, ids.join(",")]);

  return out;
}
