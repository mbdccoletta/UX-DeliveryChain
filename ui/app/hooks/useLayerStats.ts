// Device profiles and request paths, fetched when someone actually looks.
//
// The performance audit measured these two queries at 10.1 GB of the eager
// load's 30.4 GB — a third of every refresh — feeding only the "-all" layer
// drawer, which the navigation reshape retired from the main flow (a layer
// click now lands on its most deserving element). Deep links can still open
// it, so the data is fetched HERE, on first open, memoised per window.
import { useEffect, useState } from "react";
import { useMemoGen } from "../utils/memo";
import { num, qDevices, qPaths, runSized, type Timeframe } from "../utils/dql";
import type { DeviceRow, PathRow } from "./useChainData";

export interface LayerStats { devices: DeviceRow[]; paths: PathRow[] }

const memo = new Map<string, LayerStats>();

export function useLayerStats(
  tf: Timeframe, active: boolean, appId?: string | null,
  /** Sessions of the window (the read is sized by a measured probe now). */
  _sessions = 0,
): LayerStats | null {
  const gen = useMemoGen();
  const key = active ? `${tf.from}|${tf.to}|${appId ?? ""}|${gen}` : "";
  const [out, setOut] = useState<LayerStats | null>(key ? memo.get(key) ?? null : null);

  useEffect(() => {
    if (!key) { setOut(null); return; }
    if (memo.has(key)) { setOut(memo.get(key) ?? null); return; }
    let live = true;
    (async () => {
      try {
        // sized by a measured probe (runSized, 0.17.33)
        const sized = await runSized(tf, [
          { build: (t) => qDevices(t, null, appId), max: 200 },
          { build: (t) => qPaths(t, appId), max: 200 },
        ]);
        const [devices, paths] = sized.rows;
        const k = 1 / sized.share;
        const res: LayerStats = {
          devices: devices.map((r) => ({
            appId: String(r.appId ?? ""),
            res: String(r.res ?? "—"), dpr: r.dpr as string | null,
            orient: r.orient as string | null, agent: r.agent as string | null,
            utype: r.utype as string | null,
            sessions: Math.round(num(r.sessions) * k), views: Math.round(num(r.views) * k),
          })),
          paths: paths.map((r) => ({
            appId: String(r.appId ?? ""),
            path: String(r.path ?? ""), method: r.method as string | null,
            status: r.status as string | null, reqs: Math.round(num(r.reqs) * k),
            p50: num(r.p50), p90: num(r.p90),
          })),
        };
        memo.set(key, res);
        if (live) setOut(res);
      } catch { if (live) setOut({ devices: [], paths: [] }); }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, appId]);

  return out;
}
