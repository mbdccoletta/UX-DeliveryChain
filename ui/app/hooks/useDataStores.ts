// Where this application's services keep their data.
//
// The chain stopped at the service. Every request that matters here ends in a
// database, and the column that should have shown it was blank — one more
// component drawn with nothing joining it to anything, which is the defect
// this whole pass set out to remove.
//
// CONDITIONAL, like the cloud layer. Measured on this tenant, 13 of 104
// services call a store; the rest call none, and for them nothing is drawn.
// A store node appears exactly where a service was measured talking to one.
import { useEffect, useState } from "react";
import { qServiceDataStores, runDql } from "../utils/dql";

export interface DataStore {
  /** The service that calls it — how the edge finds its source card. */
  svc: string;
  /**
   * The store's name as the caller addresses it: `easytrade-db`,
   * `valkey-cart`, `dynamodb.us-east-1.amazonaws.com`. Not an entity id,
   * because there is no entity — Smartscape maps no service-to-store edge on
   * this tenant. It is what the span says, which is what the service dialled.
   */
  store: string;
  /** redis, mssql, dynamodb, mongoose … the platform's own vocabulary. */
  sys: string;
  /** The database inside that store, when the driver names one. */
  ns?: string;
  calls: number;
  /**
   * How many of those calls had a status at all. Zero means failure was never
   * reported on these spans — different from "none failed", and the card has
   * to say which.
   */
  rated: number;
  errors: number;
  /** Nanoseconds, as spans carry them. */
  p50: number;
  p90: number;
}

const memo = new Map<string, DataStore[]>();

/** Stores these services call, or null while loading / nothing scoped. */
export function useDataStores(serviceIds: string[], active = true): DataStore[] | null {
  const ids = [...serviceIds].sort();
  const key = active && ids.length ? ids.join(",") : "";
  const [out, setOut] = useState<DataStore[] | null>(key ? memo.get(key) ?? null : null);

  useEffect(() => {
    if (!key) { setOut(null); return; }
    const hit = memo.get(key);
    if (hit) { setOut(hit); return; }

    setOut(null);
    let live = true;
    (async () => {
      try {
        const rows = await runDql<Record<string, unknown>>(qServiceDataStores(ids), 40);
        const list: DataStore[] = rows.map((r) => ({
          svc: String(r.svc ?? ""),
          store: String(r.store ?? ""),
          sys: String(r.sys ?? ""),
          ns: r.ns ? String(r.ns) : undefined,
          calls: Number(r.calls) || 0,
          rated: Number(r.rated) || 0,
          errors: Number(r.errors) || 0,
          p50: Number(r.p50) || 0,
          p90: Number(r.p90) || 0,
        })).filter((s) => s.svc && s.store);
        memo.set(key, list);
        if (live) setOut(list);
      } catch {
        // Span data unavailable — the chain ends at the service, which is what
        // it did before this existed. It never invents a store.
        if (live) setOut([]);
      }
    })();

    return () => { live = false; };
  }, [key, ids.join(",")]);

  return out;
}
