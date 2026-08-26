// Device profiles and request paths, fetched when someone actually looks.
//
// The performance audit measured these two queries at 10.1 GB of the eager
// load's 30.4 GB — a third of every refresh — feeding only the "-all" layer
// drawer, which the navigation reshape retired from the main flow (a layer
// click now lands on its most deserving element). Deep links can still open
// it, so the data is fetched HERE, on first open, memoised per window.
import { useEffect, useState } from "react";
import { num, qDevices, qPaths, runDql, type Timeframe } from "../utils/dql";
import type { DeviceRow, PathRow } from "./useChainData";

export interface LayerStats { devices: DeviceRow[]; paths: PathRow[] }

const memo = new Map<string, LayerStats>();

export function useLayerStats(tf: Timeframe, active: boolean): LayerStats | null {
  const key = active ? `${tf.from}|${tf.to}` : "";
  const [out, setOut] = useState<LayerStats | null>(key ? memo.get(key) ?? null : null);

  useEffect(() => {
    if (!key) { setOut(null); return; }
    if (memo.has(key)) { setOut(memo.get(key) ?? null); return; }
    let live = true;
    (async () => {
      try {
        const [devices, paths] = await Promise.all([
          runDql<Record<string, unknown>>(qDevices(tf), 200),
          runDql<Record<string, unknown>>(qPaths(tf), 200),
        ]);
        const res: LayerStats = {
          devices: devices.map((r) => ({
            appId: String(r.appId ?? ""),
            res: String(r.res ?? "—"), dpr: r.dpr as string | null,
            orient: r.orient as string | null, agent: r.agent as string | null,
            utype: r.utype as string | null,
            sessions: num(r.sessions), views: num(r.views),
          })),
          paths: paths.map((r) => ({
            appId: String(r.appId ?? ""),
            path: String(r.path ?? ""), method: r.method as string | null,
            status: r.status as string | null, reqs: num(r.reqs),
            p50: num(r.p50), p90: num(r.p90),
          })),
        };
        memo.set(key, res);
        if (live) setOut(res);
      } catch { if (live) setOut({ devices: [], paths: [] }); }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return out;
}
