// Access and health by location, for the Overview tile — one leg, memoised
// per app and window like every other read in this product.
import { useEffect, useState } from "react";
import { qGeo, runDql, type Timeframe } from "../utils/dql";

export interface GeoRow {
  country: string; sessions: number; hit: number; ttfbMs: number;
  /** Duration-only Apdex bands over user actions (T = 3s) — the slowness
   *  side of frustration; the error side is counted by `hit`. */
  sat: number; tol: number; fru: number;
}

const memo = new Map<string, GeoRow[]>();

export function useGeo(tf: Timeframe, appId?: string | null): GeoRow[] | null {
  const key = appId ? `${tf.from}|${tf.to}|${appId}` : "";
  const [out, setOut] = useState<GeoRow[] | null>(key ? memo.get(key) ?? null : null);

  useEffect(() => {
    if (!key || !appId) { setOut(null); return; }
    const hit = memo.get(key);
    if (hit) { setOut(hit); return; }
    setOut(null);
    let live = true;
    (async () => {
      try {
        const rows = await runDql<Record<string, unknown>>(qGeo(tf, appId), 12);
        const res = rows.map((r) => ({
          country: String(r.country ?? "?"),
          sessions: Number(r.sessions) || 0,
          hit: Number(r.hitSessions) || 0,
          ttfbMs: Number(r.ttfbMs) || 0,
          sat: Number(r.sat) || 0,
          tol: Number(r.tol) || 0,
          fru: Number(r.fru) || 0,
        }));
        memo.set(key, res);
        if (live) setOut(res);
      } catch { if (live) setOut([]); }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return out;
}
