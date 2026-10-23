// Business Control's numbers: this window and the one before it, per app.
//
// Derived from the cube (useBizCube) — the KPIs are the sum of its rows and
// the previous window is its totals leg. No scan of its own any more: this
// used to be the heaviest query in the app, two per-session legs that on a
// production estate had not finished at forty seconds.
import { useMemo } from "react";
import { sumRows, useBizCube, type CubeRow } from "./useBizCube";
import type { OutcomeDefs, Timeframe } from "../utils/dql";

export interface BizPeriod {
  sessions: number; realSessions: number; converted: number; convertedReal: number;
  hitReal: number; fatalSessions: number;
  /** Customers whose actions went past the satisfaction threshold T. */
  waitedReal: number;
  engaged: number; realEngaged: number; actions: number; abandoned: number;
  satisfied: number; tolerating: number; frustrated: number;
}
export interface BizKpis {
  /** Per RUM app id: current and previous period. */
  byApp: Map<string, { cur: BizPeriod; prev: BizPeriod }>;
  /** True while these came from a PREVIEW: real, measured, not yet whole.
   *  The cards say so; the final replaces them; only the final is memoised. */
  partial?: boolean;
  /** When they were measured, if they came back from the cache. */
  cachedAt?: number;
}

const ZERO: BizPeriod = { sessions: 0, realSessions: 0, converted: 0, convertedReal: 0,
  hitReal: 0, fatalSessions: 0, waitedReal: 0, engaged: 0, realEngaged: 0, actions: 0, abandoned: 0,
  satisfied: 0, tolerating: 0, frustrated: 0 };

const period = (r: CubeRow): BizPeriod => ({
  sessions: r.sessions, realSessions: r.realSessions, converted: r.converted,
  convertedReal: r.convertedReal, hitReal: r.hitReal, fatalSessions: r.fatalSessions,
  waitedReal: r.waitedReal, engaged: r.engaged, realEngaged: r.realEngaged,
  actions: r.actions, abandoned: r.abandoned, satisfied: r.satisfied,
  tolerating: r.tolerating, frustrated: r.frustrated });

export function useBizKpis(tf: Timeframe, defs?: OutcomeDefs,
  appId?: string | null): BizKpis | null {
  const cube = useBizCube(tf, defs, appId);
  return useMemo(() => {
    /* both periods must be present for a comparison to mean anything — the
       board draws nothing until the previous window has landed whole */
    if (!cube || !cube.prev) return null;
    const byApp = new Map<string, { cur: BizPeriod; prev: BizPeriod }>();
    const ids = new Set<string>([...cube.cur.map((r) => r.appId), ...cube.prev.keys()]);
    for (const id of ids) {
      const cur = sumRows(cube.cur.filter((r) => r.appId === id), id);
      const prev = cube.prev.get(id);
      byApp.set(id, { cur: period(cur), prev: prev ? period(prev) : ZERO });
    }
    return cube.partial ? { byApp, partial: true }
      : cube.cachedAt ? { byApp, cachedAt: cube.cachedAt } : { byApp };
  }, [cube]);
}
