// Access and health by location, for the Overview tile — one leg, memoised
// per app and window like every other read in this product.
import { useEffect, useState } from "react";
import { useMemoGen } from "../utils/memo";
import { qGeo, runDql, type Timeframe } from "../utils/dql";

export interface GeoRow {
  country: string; sessions: number; hit: number; ttfbMs: number;
  /** Duration-only Apdex bands over user actions (T = 3s) — the slowness
   *  side of frustration; the error side is counted by `hit`. */
  sat: number; tol: number; fru: number;
}

/** The rows, plus whether they are still a PREVIEW. A normal array to every
 *  consumer; the one flag rides along so the tile can say "measuring…" while
 *  the figures firm up, and stop saying it when the final lands. */
export type GeoRows = GeoRow[] & { partial?: boolean };

const memo = new Map<string, GeoRows>();

const shape = (rows: Record<string, unknown>[]): GeoRows => rows.map((r) => ({
  country: String(r.country ?? "?"),
  sessions: Number(r.sessions) || 0,
  hit: Number(r.hitSessions) || 0,
  ttfbMs: Number(r.ttfbMs) || 0,
  sat: Number(r.sat) || 0,
  tol: Number(r.tol) || 0,
  fru: Number(r.fru) || 0,
}));

export function useGeo(tf: Timeframe, appId?: string | null): GeoRows | null {
  const gen = useMemoGen();
  const key = appId ? `${tf.from}|${tf.to}|${appId}|${gen}` : "";
  const [out, setOut] = useState<GeoRows | null>(key ? memo.get(key) ?? null : null);

  useEffect(() => {
    if (!key || !appId) { setOut(null); return; }
    const hit = memo.get(key);
    if (hit) { setOut(hit); return; }
    setOut(null);
    let live = true;
    (async () => {
      try {
        /* THE MAP PAINTS ON THE PREVIEW TOO. Measured on production (HAR 13,
           1h window): this query's execute came back at t+4.9s carrying all
           twelve countries, and the final landed at t+16.2s. Every other
           panel had been drawn for ten seconds while the map and the country
           list waited for the final — the one hook that never asked for the
           preview. The preview rows are marked `partial`, the tile says so,
           and the final replaces them. Integrity rule: a preview paints, it
           never decides, and it is never memoised as the answer. */
        const rows = await runDql<Record<string, unknown>>(qGeo(tf, appId), 12,
          undefined, (early) => {
            if (!live || !early.length) return;
            const prev = shape(early); prev.partial = true;
            setOut(prev);
          });
        const res = shape(rows);
        memo.set(key, res);
        if (live) setOut(res);
      } catch { if (live) setOut([]); }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return out;
}
