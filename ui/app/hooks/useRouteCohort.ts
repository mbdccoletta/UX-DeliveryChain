// Business Control, scoped to the routes a reader picked on Journeys.
//
// The board's own scan (qBizKpis) is per application: it cannot know about a
// route, because a route is a mined sequence, not a field. So a route-scoped
// board is computed the way the poster computes its cohort — per-session facts
// joined to per-session journeys, in the browser — and it is run TWICE, this
// window and the one before, so the board keeps the trends it promises.
//
// What this can carry: customers, converted, conversion, customers at risk,
// crashes — the journey and brand figures that live in a session. What it
// cannot: the Davis forecast (an analyzer over a timeseries query) and the
// per-segment breakdown, which stay whole-application and say so on screen.
import { useEffect, useState } from "react";
import { useMemoGen } from "../utils/memo";
import {
  normalizeView, qCohortSessions, qPathSessions, runDql,
  type OutcomeDefs, type Timeframe,
} from "../utils/dql";
import { matchesRoutes, type RouteCtx } from "../components/FlowSankey";

export interface CohortFacts {
  customers: number; converted: number; hit: number; crashed: number; sessions: number;
  /** Real customers who went past their first screen. */
  engaged: number;
  /** Real customers made to wait past the satisfaction threshold. */
  waited: number;
  /** The failure cost, inside the cohort: conversion with and without errors. */
  cleanN: number; cleanConv: number; hitConv: number;
}
export interface RouteCohort {
  /** The query did not answer. NOT the same as a cohort with no sessions. */
  failed?: boolean; cur: CohortFacts; prev: CohortFacts; sampled: boolean }

const ZERO: CohortFacts = { customers: 0, converted: 0, hit: 0, crashed: 0, sessions: 0,
  engaged: 0, waited: 0, cleanN: 0, cleanConv: 0, hitConv: 0 };
const memo = new Map<string, RouteCohort>();

/** One window's facts for the sessions whose journey matches the picks. */
async function windowFacts(
  tf: Timeframe, appId: string, picks: string[], ctx: RouteCtx | null,
  defs?: OutcomeDefs,
): Promise<{ facts: CohortFacts; sampled: boolean }> {
  const [rows, paths] = await Promise.all([
    runDql<Record<string, unknown>>(qCohortSessions(tf, appId, defs), 10000),
    runDql<Record<string, unknown>>(qPathSessions(tf, appId), 10000),
  ]);
  const inCohort = new Set<string>();
  for (const r of paths) {
    const journey = (Array.isArray(r.path) ? (r.path as string[]) : [])
      .map(normalizeView).filter((v, i, a) => i === 0 || v !== a[i - 1]);
    if (journey.length && matchesRoutes(journey, picks, ctx)) inCohort.add(String(r.sid));
  }
  const mine = rows.filter((r) => inCohort.has(String(r.sid)));
  const real = mine.filter((r) => Number(r.isReal) === 1 || r.isReal === true);
  const clean = real.filter((r) => Number(r.errs) === 0);
  const hurt = real.filter((r) => Number(r.errs) > 0);
  const conv = (rs: Array<Record<string, unknown>>) =>
    rs.filter((r) => Number(r.reached) === 1).length;
  return {
    facts: {
      sessions: mine.length,
      customers: real.length,
      converted: conv(real),
      hit: hurt.length,
      crashed: mine.filter((r) => Number(r.crash) > 0).length,
      // the same per-session facts the board's own figures rest on, so a
      // narrowed board keeps every line it had: engagement and failure cost
      engaged: real.filter((r) => Number(r.views) > 1).length,
      waited: real.filter((r) => Number(r.waited) > 0).length,
      cleanN: clean.length, cleanConv: conv(clean), hitConv: conv(hurt),
    },
    sampled: paths.length >= 10000 || rows.length >= 10000,
  };
}

export function useRouteCohort(
  tf: Timeframe, appId: string, picks: string[] | null, ctx: RouteCtx | null,
  defs?: OutcomeDefs,
): RouteCohort | null {
  /* THE CONTEXT IS PART OF THE QUESTION. The cohort is resolved AGAINST ctx
     — the mined routes and their depth — and ctx was in neither the cache key
     nor the effect's dependencies. On a shared Business Control link the
     board mounts while the journeys are still being mined, so the first ctx
     has no routes and depth zero; a stage or tail selection evaluated against
     that empty context matched nothing, was cached under a key that did not
     mention it, and was never recomputed when the mine arrived. The board
     then quietly fell back to the whole application. The outcome definitions
     belong in the key for the same reason: they decide what "converted"
     means, so a different set is a different answer. */
  const ctxKey = ctx
    ? `${ctx.deepest}|${ctx.outcomes}|${[...ctx.top].sort().join(",")}`
      + `|${[...ctx.tailStarts].sort().join(",")}` : "";
  const gen = useMemoGen();
  const key = picks?.length && appId
    ? `${tf.from}|${tf.to}|${appId}|${picks.join("\t")}|${ctxKey}|${gen}`
      + `|${defs ? JSON.stringify(defs) : ""}` : "";
  const [out, setOut] = useState<RouteCohort | null>(key ? memo.get(key) ?? null : null);

  useEffect(() => {
    if (!key || !picks?.length) { setOut(null); return; }
    const hit = memo.get(key);
    if (hit) { setOut(hit); return; }
    setOut(null);
    let live = true;
    (async () => {
      try {
        const span = `${Math.max(1, Math.round(tf.minutes))}m`;
        const prevTf: Timeframe = { ...tf, from: `${tf.from}-${span}`, to: tf.from };
        const [a, b] = await Promise.all([
          windowFacts(tf, appId, picks, ctx, defs),
          windowFacts(prevTf, appId, picks, ctx, defs),
        ]);
        const res: RouteCohort = { cur: a.facts, prev: b.facts, sampled: a.sampled || b.sampled };
        memo.set(key, res);
        if (live) setOut(res);
      } catch {
        /* A FAILURE IS NOT AN EMPTY MEASUREMENT. This used to answer a failed
           query with zeroes, and ReportView reads cur.sessions === 0 as proof
           that nobody walked the selected routes: it drops the selection,
           shows whole-application figures and advises widening the window. A
           permission error or a timeout therefore silently changed what the
           board was about, and explained it with a reason that was not true.
           `failed` says which of the two happened. */
        if (live) setOut({ cur: { ...ZERO }, prev: { ...ZERO }, sampled: false, failed: true });
      }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return out;
}
