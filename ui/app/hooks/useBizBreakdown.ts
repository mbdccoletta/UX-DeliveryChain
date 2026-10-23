// Business Control's breakdown: what failure costs, and where conversion
// lives.
//
// Derived from the cube (useBizCube): each dimension's buckets are the sum of
// the cube rows that carry that value, and the error-cost split is the
// hit/clean columns. It used to be its own per-session scan capped at 20 000
// sessions — on a six-million-session hour the segment ranking came from an
// arbitrary 0.3% and said "partial" in small print. The cube is grouped
// server-side over every session, so these are totals now; the only cap left
// is on GROUPS, and the flag below says when it bit.
import { useMemo } from "react";
import { BIZ_CUBE_CAP } from "../utils/dql";
import { useBizCube, type CubeRow } from "./useBizCube";
import type { OutcomeDefs, Timeframe } from "../utils/dql";

/** The dimensions the board offers, and the column each one reads. */
const DIMS: Array<[string, keyof CubeRow]> = [
  ["country", "country"], ["os", "os"], ["browser", "browser"],
  ["device type", "deviceType"], ["user type", "userType"],
];

export interface BreakRow {
  d: string; bucket: string; appId: string;
  sessions: number; conv: number; realN: number; realConv: number;
  /** Real sessions in this bucket that met at least one error. */
  realHit: number;
}

/** The rows, plus whether the server-side GROUP cap cut them short — then
 *  the totals omit the smallest groups and are floors, said out loud. */
export interface BreakRows extends Array<BreakRow> { partial?: boolean }

/** The server-side group limit these are read under. */
export const BREAKDOWN_CAP = BIZ_CUBE_CAP;

export function useBizBreakdown(tf: Timeframe, defs?: OutcomeDefs,
  appId?: string | null): BreakRows | null {
  const cube = useBizCube(tf, defs, appId);
  return useMemo(() => {
    if (!cube) return null;
    const acc = new Map<string, BreakRow>();
    const bump = (d: string, bucket: string, app: string,
      v: { sessions: number; conv: number; realN: number; realConv: number; realHit: number }) => {
      const k = `${d}\u0000${bucket}\u0000${app}`;
      const cur = acc.get(k) ?? { d, bucket, appId: app,
        sessions: 0, conv: 0, realN: 0, realConv: 0, realHit: 0 };
      cur.sessions += v.sessions; cur.conv += v.conv; cur.realN += v.realN;
      cur.realConv += v.realConv; cur.realHit += v.realHit;
      acc.set(k, cur);
    };
    for (const r of cube.cur) {
      // the error-cost split: sessions that met an error, and the clean rest
      bump("__err", "hit", r.appId, { sessions: r.hit, conv: r.hitConv,
        realN: r.hitReal, realConv: r.realHitConv, realHit: r.hitReal });
      bump("__err", "clean", r.appId, { sessions: r.sessions - r.hit,
        conv: r.converted - r.hitConv, realN: r.realSessions - r.hitReal,
        realConv: r.convertedReal - r.realHitConv, realHit: 0 });
      for (const [name, col] of DIMS) {
        const v = r[col];
        if (v === null || v === undefined || v === "") continue;
        bump(name, String(v), r.appId, { sessions: r.sessions, conv: r.converted,
          realN: r.realSessions, realConv: r.convertedReal, realHit: r.hitReal });
      }
    }
    // the legs kept their 40 biggest buckets per dimension; so does this
    const byDim = new Map<string, BreakRow[]>();
    for (const row of acc.values()) {
      const g = byDim.get(row.d) ?? [];
      g.push(row); byDim.set(row.d, g);
    }
    const res: BreakRows = [];
    for (const [, g] of byDim) {
      g.sort((a, b) => b.sessions - a.sessions);
      res.push(...g.slice(0, 40));
    }
    if (cube.capped) res.partial = true;
    return res;
  }, [cube]);
}
