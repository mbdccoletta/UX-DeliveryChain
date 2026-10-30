// Where the difficulty lives — inside the backend or outside it.
//
// Derived from the cube (useBizCube), both windows, per application. Two
// evidence kinds: TIME (each view's wait decomposed by the agent: user's
// network, server waiting, download & render on the device) and ERRORS (each
// error's origin from its own record). It used to be four scan legs of its
// own; the cube carries both sums, so it costs nothing further.
import { useMemo } from "react";
import { sumRows, useBizCube, type CubeRow } from "./useBizCube";
import type { Timeframe } from "../utils/dql";

export interface SlowSplit { views: number; meas: number; net: number; srv: number; rend: number }
export type ErrBucket = "backend" | "frontend" | "policy" | "third_party" | "device" | "connection" | "request_4xx" | "other";
export interface DifficultyApp {
  slow: { cur: SlowSplit; prev: SlowSplit };
  err: { cur: Map<ErrBucket, number>; prev: Map<ErrBucket, number> };
}

const Z: SlowSplit = { views: 0, meas: 0, net: 0, srv: 0, rend: 0 };
const slowOf = (r: CubeRow): SlowSplit =>
  ({ views: r.slowViews, meas: r.slowMeas, net: r.net, srv: r.srv, rend: r.rend });
const errOf = (r: CubeRow) => {
  const m = new Map<ErrBucket, number>();
  for (const b of Object.keys(r.err) as ErrBucket[]) if (r.err[b] > 0) m.set(b, r.err[b]);
  return m;
};

export function useDifficulty(tf: Timeframe, appId?: string | null,
  defs?: Parameters<typeof useBizCube>[1]): Map<string, DifficultyApp> | null {
  const cube = useBizCube(tf, defs, appId);
  return useMemo(() => {
    if (!cube) return null;
    const m = new Map<string, DifficultyApp>();
    const ids = new Set<string>([...cube.cur.map((r) => r.appId), ...(cube.prev?.keys() ?? [])]);
    for (const id of ids) {
      const cur = sumRows(cube.cur.filter((r) => r.appId === id), id);
      const prev = cube.prev?.get(id);
      m.set(id, {
        slow: { cur: slowOf(cur), prev: prev ? slowOf(prev) : { ...Z } },
        err: { cur: errOf(cur), prev: prev ? errOf(prev) : new Map() },
      });
    }
    return m;
  }, [cube]);
}
