// The Databases app's own entity behind a store card, when one exists.
//
// Asked only when a store's drawer is open — one node lookup per selection,
// memoised. A hit turns the route's dead end into "Open in Databases"; a miss
// offers nothing, because a guessed id opens a page about something else.
import { useEffect, useState } from "react";
import { qDbEntity, runDql } from "../utils/dql";

export interface DbEntity { id: string; type: string; name: string }

const memo = new Map<string, DbEntity | null>();

export function useDbEntity(
  address?: string | null, ns?: string, active = true,
): DbEntity | null {
  const key = active && address ? `${address}|${ns ?? ""}` : "";
  const [out, setOut] = useState<DbEntity | null>(key ? memo.get(key) ?? null : null);

  useEffect(() => {
    if (!key) { setOut(null); return; }
    if (memo.has(key)) { setOut(memo.get(key) ?? null); return; }

    let live = true;
    (async () => {
      let hit: DbEntity | null = null;
      try {
        const rows = await runDql<Record<string, unknown>>(
          qDbEntity(address!, ns), 4);
        // an INSTANCE is the address's own kind of thing; a DATABASE (matched
        // by namespace) is the fallback
        const pick = rows.find((r) => String(r.type).startsWith("DB_INSTANCE_"))
          ?? rows[0];
        if (pick?.id) hit = { id: String(pick.id), type: String(pick.type),
          name: String(pick.name ?? pick.id) };
      } catch { /* Smartscape unavailable — the route simply lacks the hop */ }
      memo.set(key, hit);
      if (live) setOut(hit);
    })();

    return () => { live = false; };
  }, [key]);

  return out;
}
