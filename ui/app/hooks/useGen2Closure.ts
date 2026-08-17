// The components the classic topology knows and Smartscape does not.
//
// The chain reads Smartscape, which is the right default: it is the model the
// rest of the platform is moving to. But it is not complete yet, and the gap
// is visible to the user — the platform's own service flow drew boxes this
// chain did not, and "validate Gen2 when Gen3 has none" is the rule that
// closes it.
//
// FALLBACK, not a second source of truth. A service enters here only when
// Smartscape has no node for it: everything already in scope is filtered out
// before the query returns, so the two models never disagree on screen. What
// arrives is what would otherwise be missing.
//
// Measured on guu84124 / easyTravel mainframe: seven services from Smartscape,
// one — MF easyTravelBusiness — from here, called by three of them.
import { useEffect, useState } from "react";
import { qServicesGen2Calls, runDql } from "../utils/dql";

export interface Gen2Service {
  /** Same id space as Smartscape — the two models join without translation. */
  id: string;
  name: string;
  /** Classic isExternalService — kept for the twin dedup above. */
  ext?: boolean;
  /** The classic serviceType: DATABASE_SERVICE, CICS_SERVICE, QUEUE_LISTENER… */
  kind: string;
  /** The host the classic model places it on, when it names one. */
  host?: string;
  /** Which in-scope services call it — how the edge finds its source card. */
  callers: string[];
}

/**
 * How far to follow the classic call graph out of the scope.
 *
 * Three rounds, because the answer has to terminate and a topology can chain:
 * frontend → service → database is already two. Measured here it settles after
 * one — easyTravelBusiness calls nothing — so the cap is a guard, not a limit
 * anyone reaches.
 */
const MAX_ROUNDS = 3;

const memo = new Map<string, Gen2Service[]>();

/** Classic-only services reachable from these, or null while loading. */
export function useGen2Closure(serviceIds: string[], active = true): Gen2Service[] | null {
  const ids = [...serviceIds].sort();
  const key = active && ids.length ? ids.join(",") : "";
  const [out, setOut] = useState<Gen2Service[] | null>(key ? memo.get(key) ?? null : null);

  useEffect(() => {
    if (!key) { setOut(null); return; }
    const hit = memo.get(key);
    if (hit) { setOut(hit); return; }

    setOut(null);
    let live = true;
    (async () => {
      // `known` is everything Smartscape already accounts for, and it grows as
      // the walk finds more: without it a two-way call relation would bounce
      // between the same pair for every round the cap allows.
      const known = new Set(ids);
      const found = new Map<string, Gen2Service>();
      try {
        let frontier = ids;
        for (let round = 0; round < MAX_ROUNDS && frontier.length; round++) {
          const rows = await runDql<Record<string, unknown>>(
            qServicesGen2Calls(frontier), 80);
          const next: string[] = [];
          for (const r of rows) {
            const id = String(r.id ?? "");
            const src = String(r.src ?? "");
            if (!id || known.has(id)) continue;
            const seen = found.get(id);
            if (seen) {
              if (src && !seen.callers.includes(src)) seen.callers.push(src);
              continue;
            }
            // `host` arrives as the classic model's array, which is one entry
            // in every case observed; the card shows one host, so take one.
            const host = Array.isArray(r.host) ? String(r.host[0] ?? "")
              : r.host ? String(r.host) : "";
            found.set(id, { id, name: String(r.name ?? id),
              kind: String(r.kind ?? ""), host: host || undefined,
              ext: r.ext === true || r.ext === "true",
              callers: src ? [src] : [] });
            next.push(id);
          }
          // only the newly found are followed; re-walking the frontier would
          // return the same rows and the loop would never shrink
          next.forEach((i) => known.add(i));
          frontier = next;
        }
        /* THE TWIN DEDUP, by name, not by type. An EXTERNAL WEB service is
         * usually the same code seen from its caller ("MF /services/
         * JourneyService/ on port 8091" beside "MF JourneyService") — but the
         * old flag+type test also killed real unmonitored endpoints with no
         * twin at all (measured: CouchDB_ET on 5984, 8,482 spans/2h, gone
         * from every layer). So an ext WEB row is dropped only when a
         * monitored row's significant name tokens ALL appear in its name —
         * the audit's fourteen ext∧WEB services split cleanly: the true
         * duplicates match a twin, CouchDB matches none and stays. */
        const all = [...found.values()];
        const tokens = (nm: string) => nm.toLowerCase().replace(/[^a-z0-9]+/g, " ")
          .split(" ").filter((t) => t.length >= 4);
        const monitored = all.filter((g) => !g.ext);
        const isTwin = (g: Gen2Service & { ext?: boolean }) => {
          const hay = ` ${tokens(g.name).join(" ")} `;
          return monitored.some((m) => {
            const tk = tokens(m.name);
            return tk.length > 0 && tk.every((t) => hay.includes(` ${t} `));
          });
        };
        // classic AGGREGATION BUCKETS ("Requests to public networks",
        // "Requests on localhost:8091") are not components either — they are
        // the classic model's catch-alls, and a box named after one says
        // nothing a reader can act on
        const isBucket = (g: Gen2Service) => /^requests (to|on) /i.test(g.name);
        const list = all.filter((g) =>
          !(g.ext && /^(WEB_SERVICE|WEB_REQUEST_SERVICE)$/.test(g.kind)
            && (isTwin(g) || isBucket(g))));
        memo.set(key, list);
        if (live) setOut(list);
      } catch {
        // The classic model is unavailable — the chain shows what Smartscape
        // knows, which is what it did before this existed. It never invents.
        if (live) setOut([]);
      }
    })();

    return () => { live = false; };
  }, [key, ids.join(",")]);

  return out;
}
