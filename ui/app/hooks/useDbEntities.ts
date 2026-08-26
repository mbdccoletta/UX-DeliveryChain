// The DB entities behind every store card, resolved in one batch.
//
// Store cards are discovered from spans and used to carry NO entity ids —
// which meant a database's own health alerts (bound to DB_INSTANCE_* /
// CUSTOM_DEVICE- ids) could never light them: the audit found two active
// custom alerts on database instances that the Databases app showed and this
// chain silently ignored. One Smartscape lookup per store SET (memoised),
// matching by connection hostname first — the strong arm — then by the name
// bridge qDbEntity already measured.
import { useEffect, useState } from "react";
import { qDbEntities, runDql } from "../utils/dql";
import type { DataStore } from "./useDataStores";

export interface DbIds { id: string; classic?: string; name: string }

const memo = new Map<string, Map<string, DbIds>>();

export function useDbEntities(stores: DataStore[] | null): Map<string, DbIds> | null {
  const targets = [...new Map((stores ?? []).map((s) => [s.store,
    { addr: s.store, ns: s.ns }])).values()]
    .sort((a, b) => a.addr.localeCompare(b.addr));
  const key = targets.length ? targets.map((t) => `${t.addr}|${t.ns ?? ""}`).join(",") : "";
  const [out, setOut] = useState<Map<string, DbIds> | null>(key ? memo.get(key) ?? null : null);

  useEffect(() => {
    if (!key) { setOut(null); return; }
    if (memo.has(key)) { setOut(memo.get(key) ?? null); return; }
    let live = true;
    (async () => {
      const map = new Map<string, DbIds>();
      try {
        const rows = await runDql<{ id?: string; classic?: string; type?: string;
          name?: string; host?: string }>(qDbEntities(targets), 40);
        for (const t of targets) {
          const match = (r: typeof rows[number]) =>
            r.host === t.addr || r.name === t.addr || (t.ns && r.name === t.ns)
            || (r.name ?? "").includes(`@${t.addr}`)
            || (r.name ?? "").startsWith(`${t.addr}:`);
          // instance over database, hostname-exact over name bridge
          const cands = rows.filter(match).sort((a, b) =>
            Number(b.host === t.addr) - Number(a.host === t.addr)
            || Number(String(b.type).startsWith("DB_INSTANCE_"))
              - Number(String(a.type).startsWith("DB_INSTANCE_")));
          const hit = cands[0];
          if (hit?.id) map.set(t.addr, { id: String(hit.id),
            classic: hit.classic ? String(hit.classic) : undefined,
            name: String(hit.name ?? hit.id) });
        }
      } catch { /* no map: cards keep no ids, as before */ }
      memo.set(key, map);
      if (live) setOut(map);
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return out;
}
