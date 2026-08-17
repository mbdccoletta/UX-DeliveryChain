// Where the difficulty lives — inside the backend or outside it.
//
// One query (qDifficulty), both windows, per application. Two evidence kinds:
// TIME (each view's wait decomposed by the agent: user's network, server
// waiting, download & render on the device) and ERRORS (each error's origin
// from its own record). The section combines them with the differential
// diagnosis (from the breakdown) and Davis's open problems (already loaded).
import { useEffect, useState } from "react";
import { qDifficulty, runDql, type Timeframe } from "../utils/dql";

export interface SlowSplit { views: number; meas: number; net: number; srv: number; rend: number }
export type ErrBucket = "backend" | "frontend" | "policy" | "third_party" | "device" | "connection" | "request_4xx" | "other";
export interface DifficultyApp {
  slow: { cur: SlowSplit; prev: SlowSplit };
  err: { cur: Map<ErrBucket, number>; prev: Map<ErrBucket, number> };
}

const Z: SlowSplit = { views: 0, meas: 0, net: 0, srv: 0, rend: 0 };

export function useDifficulty(tf: Timeframe, appId?: string | null):
  Map<string, DifficultyApp> | null {
  const key = `${tf.from}|${tf.to}|${appId ?? ""}`;
  const [out, setOut] = useState<Map<string, DifficultyApp> | null>(null);

  useEffect(() => {
    let live = true;
    setOut(null);
    (async () => {
      try {
        const rows = await runDql<Record<string, unknown>>(qDifficulty(tf, appId), 400);
        const m = new Map<string, DifficultyApp>();
        const slot = (id: string) => {
          const s = m.get(id) ?? { slow: { cur: { ...Z }, prev: { ...Z } },
            err: { cur: new Map(), prev: new Map() } };
          m.set(id, s); return s;
        };
        for (const r of rows) {
          const id = String(r.appId ?? "");
          if (!id) continue;
          const period = r.period === "cur" ? "cur" : "prev";
          if (r.kind === "slow") {
            slot(id).slow[period] = {
              views: Number(r.views) || 0, meas: Number(r.meas) || 0,
              net: Number(r.net) || 0, srv: Number(r.srv) || 0, rend: Number(r.rend) || 0 };
          } else if (r.kind === "err") {
            slot(id).err[period].set(String(r.bucket) as ErrBucket, Number(r.sessions) || 0);
          }
        }
        if (live) setOut(m);
      } catch { if (live) setOut(new Map()); }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return out;
}
