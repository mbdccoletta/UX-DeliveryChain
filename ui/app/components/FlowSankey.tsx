// Session flow: application → furthest stage reached → outcome.
// Ribbon width is the measured session count; the flow conserves volume, so
// wherever a ribbon narrows is literally where the business loses users.
import React, { useEffect, useRef, useState } from "react";
import { DONE, INFO_DIMS, INTENT, fmtMs, fmtN, normalizeView, outcomeTestFor,
  OUTCOME_WORDS, qNoTelemetry, qPathSessions, qCohortSessions, runDql,
  type OutcomeDefs, type Timeframe } from "../utils/dql";

/** The poster's scans, shared and remembered: keyed by the query text itself
 *  (which already carries window, app and definitions), so a re-open costs
 *  nothing and two callers in flight share one request. A failure forgets
 *  its key — the next click retries instead of caching the error. */
/* Memoised per query TEXT — and the text carries a RELATIVE timeframe
 * ("now()-2h"), so the key never changes as the clock walks. Without an
 * expiry, a poster reopened hours later served the first open's sessions
 * against a freshly-mined diagram: disjoint session ids, "0 sessions on
 * this route" beside a flow bar full of them. Five minutes keeps the
 * reopen-free win and lets the data stay the window it claims to be. */
const DQL_MEMO_TTL = 5 * 60_000;
const dqlMemo = new Map<string, { at: number; p: Promise<Array<Record<string, unknown>>> }>();
function memoDql(q: string, limit: number): Promise<Array<Record<string, unknown>>> {
  const hit = dqlMemo.get(q);
  if (hit && Date.now() - hit.at < DQL_MEMO_TTL) return hit.p;
  const p = runDql<Record<string, unknown>>(q, limit)
    .catch((e) => { dqlMemo.delete(q); throw e; });
  dqlMemo.set(q, { at: Date.now(), p });
  return p;
}

/**
 * The ACTIVE outcome test. One FlowSankey shows one application; the
 * component sets this before its models build (and its memo deps carry the
 * definition key), so a customer-taught conversion changes stages, matchers,
 * summary and poster in one move. Default: the measured keyword heuristic.
 */
let activeDone: (v: string) => boolean = (v) => DONE.test(v);
const doneOf = (journey: string[]) => journey.some((v) => activeDone(v));
import { RouteInfographic, type InfoRow, type StopRow } from "./RouteInfographic";
import type { AppRow, SeqRow, TransitionRow, ViewRow } from "../hooks/useChainData";
import { edgeHealth, frictionFor } from "../utils/friction";
import { HIT_BAD, HIT_WARN } from "../utils/verdict";

type Tone = "good" | "warn" | "bad" | "info";
interface Node {
  id: string; c: number; nm: string; v: number; tone: Tone; sub: string; appId?: string;
  /** Marks the mined path losing the most sessions before checkout. */
  ab?: boolean;
  /** Untruncated label, shown in the tooltip when nm was cut to fit. */
  full?: string;
}
interface Link {
  s: string; t: string; v: number; tone: Tone;
  /** What the user experienced on this move, when a transition measured it. */
  note?: string;
  losing?: boolean;
}

const TONE: Record<Tone, string> = { good: "--good", warn: "--warn", bad: "--bad", info: "--info" };
const cssVar = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || "#888";

type Stage = { id: string; nm: string; tone: Tone; sub: string };

/** How far a session got, as a stage id. */
function stageIdOf(path: string[], outcomes: boolean, deepest: number): string {
  if (!path.length) return "st-none";
  /* NO VOCABULARY. Stages used to be read off view NAMES — a screen called
   * "checkout" meant completed — which is a guess dressed as a measurement:
   * it fits one demo application and misses every customer whose screens are
   * named in another language, or whose completion is not a screen at all.
   * Measured on this tenant, 185 sessions of 970 counted as "converted" on
   * evidence the journey never showed, so a path that ended could display a
   * conversion. Depth is the honest signal, and it is defined for every
   * application without asking anyone anything. */
  void outcomes; void activeDone; void INTENT;
  if (deepest > 1 && path.length >= deepest) return "st-order";
  if (path.length > 2) return "st-cart";
  return path.length > 1 ? "st-prod" : "st-home";
}

/**
 * The label for a stage. With `outcomes` the wording is a business stage;
 * without it no outcome word matched anywhere in the application, so depth is
 * the only honest thing to report — true for any application type, including
 * screens named in another language or convention.
 */
function stageMeta(id: string, outcomes: boolean, deepest: number): Stage {
  if (id === "st-none") {
    // Sessions the path mining never saw. The subtitle names the actual cause:
    // journeys come from `navigation`, so a session lands here only when it
    // emitted no navigation at all — not merely when a view failed to close,
    // which is what the old wording ("without view_summary") implied.
    return { id, nm: "No navigation recorded", tone: "bad", sub: "session with no navigation event" };
  }
  void outcomes;
  if (id === "st-order") return { id, nm: "Reached the deepest journey", tone: "good", sub: `${deepest} views` };
  if (id === "st-cart") return { id, nm: "Went deep", tone: "warn", sub: "3+ views" };
  if (id === "st-prod") return { id, nm: "Two views in", tone: "warn", sub: "2 views" };
  return { id, nm: "Entry view only", tone: "warn", sub: "immediate bounce" };
}

const stageOf = (path: string[], outcomes = true, deepest = 0): Stage =>
  stageMeta(stageIdOf(path, outcomes, deepest), outcomes, deepest);

/** The longest journey observed, used when depth is the only signal. */
/**
 * THE COMPLETION DEPTH — one definition for the diagram, its header and the
 * board (ReportView imports this).
 *
 * NOT the longest route: measured here, the single deepest journey ran 25
 * views and exactly ONE session walked it, so "complete" meant 0.0% and the
 * funnel said nothing. One outlier cannot be the bar. The bar is the deepest
 * depth at least a tenth of the sessions still reach — self-calibrating, so
 * a three-screen signup and a twenty-screen checkout each get a bar their
 * own traffic defines.
 */
export const DEPTH_FLOOR = 0.1;
export const deepestOf = (seqs: SeqRow[]) => {
  const mine = seqs.filter((s) => s.journey.length > 0);
  const total = mine.reduce((a, s) => a + s.sessions, 0);
  if (!total) return 0;
  const reach = (d: number) =>
    mine.filter((s) => s.journey.length >= d).reduce((a, s) => a + s.sessions, 0);
  const maxDepth = mine.reduce((m, s) => Math.max(m, s.journey.length), 0);
  for (let d = maxDepth; d >= 2; d--) if (reach(d) / total >= DEPTH_FLOOR) return d;
  return maxDepth >= 2 ? 2 : maxDepth;
};

const OUTCOME: Record<string, { id: string; nm: string; tone: Tone; sub: string }> = {
  "st-order": { id: "o-conv", nm: "Converted", tone: "good", sub: "flow with a measured order" },
  "st-cart": { id: "o-cart", nm: "Stopped before the end", tone: "bad", sub: "started and abandoned" },
  "st-prod": { id: "o-browse", nm: "Left without starting", tone: "warn", sub: "no intent recorded" },
  "st-home": { id: "o-browse", nm: "Left without starting", tone: "warn", sub: "no intent recorded" },
  "st-none": { id: "o-blind", nm: "Invisible to the business", tone: "bad", sub: "instrumentation gap" },
};

/**
 * How many routes the diagram draws before folding the rest into one node.
 * Shared with the unpacking card, so what the fold SAYS it holds and what the
 * card LISTS can never drift apart.
 */
export const ROUTE_MAX = 9;

/**
 * The route-pick predicate, exported so BUSINESS CONTROL can reproduce the
 * exact cohort a reader picked on Journeys — same ids, same rule, one
 * definition. `ctx` is the full mine's vocabulary (which routes are drawn,
 * and the stage words), so a cohort means the same thing on both pages.
 */
/**
 * How many STARTING POINTS the folded tail is split into before the remainder
 * becomes a single node. The tail is not noise — measured on easytravel it is
 * 168 paths carrying 59% of the sessions, the biggest band on the diagram and
 * the only one that said nothing. It is large because routes are grouped by
 * EXACT sequence, so one extra step makes a new path: those 168 are mostly
 * variants of a handful of stories.
 *
 * Splitting them by where they BEGIN turns the anonymous 59% into four or five
 * bands a reader can name, each one pickable like any route. Drawing all 168
 * would not be expanding it — it would be the same dump, wider.
 */
const TAIL_GROUPS = 5;
/** A tail group's id IS its first step, so a pick survives a re-mine. */
const groupId = (first: string) => "jg-" + first;
/**
 * WHICH STARTING POINTS THE TAIL IS DRAWN AS — one definition, used by the
 * diagram that draws the bands AND by the predicate that resolves a click into
 * sessions. Written as a shared function because the first version did not:
 * the diagram split the tail into groups while `j-rest` still meant "anything
 * outside the top", so selecting a remainder of 37 paths reported the cohort
 * of all 168. Measured on easytravel — 303 sessions drawn, 2,057 selected.
 */
const tailStartsOf = (tail: SeqRow[]): Set<string> => {
  const by = new Map<string, number>();
  for (const s of tail) {
    const first = s.journey[0] ?? "";
    if (first) by.set(first, (by.get(first) ?? 0) + s.sessions);
  }
  return new Set([...by.entries()].sort((x, y) => y[1] - x[1])
    .slice(0, TAIL_GROUPS).map(([first]) => first));
};

export interface RouteCtx {
  top: Set<string>; outcomes: boolean; deepest: number;
  /** The first steps drawn as their own tail band. */
  tailStarts: Set<string>;
}
export const routeCtxOf = (seqs: SeqRow[], appId: string): RouteCtx => {
  const mine = seqs.filter((q) => q.appId === appId).sort((a, b) => b.sessions - a.sessions);
  return {
    top: new Set(mine.slice(0, ROUTE_MAX).map((q) => routeId(q.journey))),
    outcomes: mine.some((q) => doneOf(q.journey)),
    deepest: deepestOf(mine),
    tailStarts: tailStartsOf(mine.slice(ROUTE_MAX)),
  };
};
export function matchesRoutes(journey: string[], pk: string[], ctx: RouteCtx | null): boolean {
  if (!pk.length) return true;
  const routes = pk.filter((id) => id.startsWith("jp-") || id.startsWith("jg-")
    || id === "j-rest");
  const stages = pk.filter((id) => id.startsWith("st-"));
  if (routes.length) {
    const key = routeId(journey);
    const inTop = ctx?.top.has(key) ?? false;
    /* A tail group means "not one of the drawn routes, AND it starts here" —
     * the same two facts the diagram used to draw it, so the cohort Business
     * Control recomputes is provably the band the reader clicked. */
    const first = journey[0] ?? "";
    if (!routes.some((id) =>
      id === "j-rest" ? (!inTop && !(ctx?.tailStarts.has(first) ?? false))
      : id.startsWith("jg-") ? (!inTop && first === id.slice(3))
      : id === key)) return false;
  }
  if (stages.length) {
    const st = stageOf(journey, ctx?.outcomes ?? true, ctx?.deepest ?? 0).id;
    if (!stages.includes(st)) return false;
  }
  return true;
}

/** A route node's id IS its journey — stable across model rebuilds, so a
 *  picked route stays ringed when the diagram is re-mined from the cohort. */
const routeId = (journey: string[]) => "jp-" + journey.join("\u0001");

/** Builds nodes and ribbons from sessions per application and mined sequences. */
/* ONE application-health rule with every other screen (utils/verdict):
 * sessions hit by an error over sessions. The old inline errors-per-view
 * ratio drew GREEN an app where every session met one error across three
 * views, while the Overview called the same app Critical. Without a ux row
 * the health is unknown — info, never a guessed green. */
const appTone = (u: { sessions: number; hit: number } | undefined | null): Tone =>
  !u || u.sessions === 0 ? "info"
  : u.hit / u.sessions >= HIT_BAD ? "bad"
  : u.hit / u.sessions >= HIT_WARN ? "warn" : "good";

export function buildModel(apps: AppRow[], seqs: SeqRow[],
  ux?: Map<string, { sessions: number; hit: number }> | null) {
  const nodes: Node[] = [];
  const links: Link[] = [];
  const stageTot = new Map<string, { nm: string; tone: Tone; sub: string; v: number }>();
  const outTot = new Map<string, { nm: string; tone: Tone; sub: string; v: number }>();
  const envTotal = Math.max(1, apps.reduce((acc, a) => acc + a.sessions, 0));
  const share = (v: number) => pct100((v / envTotal) * 100);
  // Decided once for the whole environment: the stage map is shared, so per-app
  // vocabularies would overwrite each other's labels and the column would mix
  // "Completed" with "Reached the deepest journey".
  const envOutcomes = seqs.some((s) => doneOf(s.journey));
  const envDeepest = deepestOf(seqs);

  for (const a of apps) {
    const tone: Tone = appTone(ux?.get(a.appId));
    nodes.push({ id: "a-" + a.appId, c: 0, nm: a.name, v: a.sessions, tone,
      sub: `${share(a.sessions)} · ${fmtN(a.views)} views`, appId: a.appId });

    const mine = seqs.filter((s) => s.appId === a.appId);
    const outcomes = envOutcomes, deepest = envDeepest;
    let covered = 0;
    const byStage = new Map<string, number>();
    for (const s of mine) {
      const id = stageIdOf(s.journey, outcomes, deepest);
      byStage.set(id, (byStage.get(id) ?? 0) + s.sessions);
      covered += s.sessions;
    }
    // sessions with no discovered view at all
    const orphan = Math.max(0, a.sessions - covered);
    if (orphan) byStage.set("st-none", (byStage.get("st-none") ?? 0) + orphan);

    for (const [stId, v] of byStage) {
      const meta = stageMeta(stId, outcomes, deepest);
      const cur = stageTot.get(stId) ?? { nm: meta.nm, tone: meta.tone, sub: meta.sub, v: 0 };
      stageTot.set(stId, { ...cur, v: cur.v + v });
      links.push({ s: "a-" + a.appId, t: stId, v, tone: meta.tone });
    }
  }
  for (const [id, s] of stageTot) {
    nodes.push({ id, c: 1, nm: s.nm, v: s.v, tone: s.tone,
      sub: `${share(s.v)} · ${s.sub}` });
    const o = OUTCOME[id];
    if (!o) continue;
    const cur = outTot.get(o.id) ?? { nm: o.nm, tone: o.tone, sub: o.sub, v: 0 };
    outTot.set(o.id, { ...cur, v: cur.v + s.v });
    links.push({ s: id, t: o.id, v: s.v, tone: o.tone });
  }
  for (const [id, o] of outTot) nodes.push({ id, c: 2, nm: o.nm, v: o.v, tone: o.tone,
    sub: `${share(o.v)} · ${o.sub}` });
  return { nodes, links };
}

/* PERCENT-SCALE input (0..100), unlike utils/dql's fmtPct which takes a
 * share (0..1) — named apart so the two can never be swapped by accident. */
const pct100 = (v: number) => `${v.toFixed(v < 10 ? 1 : 0)}%`;

/** True when a mined path never reaches an instrumented checkout view. */
const abandons = (journey: string[]) =>
  journey.length > 0 && !doneOf(journey);

/**
 * Single-application mode: one ribbon per discovered navigation path, sized by
 * sessions, labeled with count and share of the application's sessions.
 */
export function buildAppModel(app: AppRow, seqs: SeqRow[], fragments = 0,
  /** Stage vocabulary from the FULL mine — when the model is rebuilt from a
   *  picked subset, deciding outcomes/deepest from the remainder made the
   *  drawn stages disagree with the pick matcher's (audit). */
  vocab?: { outcomes: boolean; deepest: number },
  uxRow?: { sessions: number; hit: number } | null) {
  const nodes: Node[] = [];
  const links: Link[] = [];
  // Window fragments — sessions whose only in-window content is one stray
  // metadata event — are NOT journeys: their activity happened outside the
  // window. They leave the denominator entirely; measured on easyTravel they
  // were 9 of every 10 "No view recorded" sessions, understating the funnel.
  const journeyable = Math.max(0, app.sessions - fragments);
  const total = Math.max(1, journeyable);
  const mine = seqs
    .filter((s) => s.appId === app.appId)
    .sort((a, b) => b.sessions - a.sessions);

  nodes.push({ id: "a-" + app.appId, c: 0, nm: app.name, v: journeyable,
    tone: appTone(uxRow),
    sub: `${fmtN(mine.length)} paths discovered`
      + (fragments > 0 ? ` · ${fmtN(fragments)} window fragments excluded` : ""),
    appId: app.appId });

  const outcomes = vocab?.outcomes ?? mine.some((s) => doneOf(s.journey));
  const deepest = vocab?.deepest ?? deepestOf(mine);
  const stageTot = new Map<string, { nm: string; tone: Tone; sub: string; v: number }>();
  const addStage = (path: string[], v: number, from: string) => {
    const st = stageOf(path, outcomes, deepest);
    const cur = stageTot.get(st.id) ?? { nm: st.nm, tone: st.tone, sub: st.sub, v: 0 };
    stageTot.set(st.id, { ...cur, v: cur.v + v });
    links.push({ s: from, t: st.id, v, tone: st.tone });
  };

  const MAX = ROUTE_MAX;
  const worst = mine.filter((s) => abandons(s.journey)).sort((a, b) => b.sessions - a.sessions)[0];
  let covered = 0;
  mine.slice(0, MAX).forEach((s) => {
    const id = routeId(s.journey);
    const label = s.journey.join(" → ");
    nodes.push({ id, c: 1, nm: label.length > 34 ? label.slice(0, 33) + "…" : label,
      full: label.length > 34 ? label : undefined,
      v: s.sessions, tone: stageOf(s.journey, outcomes, deepest).tone,
      sub: `${pct100((s.sessions / total) * 100)} of sessions`,
      ab: s === worst });
    links.push({ s: "a-" + app.appId, t: id, v: s.sessions, tone: stageOf(s.journey, outcomes, deepest).tone });
    addStage(s.journey, s.sessions, id);
    covered += s.sessions;
  });
  /* THE TAIL, BY WHERE IT BEGINS. One anonymous band holding the majority of
   * the sessions is the diagram's biggest claim and its emptiest one. Split by
   * first step it becomes bands that can be named, picked and taken to
   * Business Control like any route; whatever does not make the top few starts
   * still folds, but it is now a remainder rather than the headline. */
  const rest = mine.slice(MAX);
  if (rest.length) {
    const by = new Map<string, { v: number; n: number }>();
    for (const s of rest) {
      const first = s.journey[0] ?? "";
      const cur = by.get(first) ?? { v: 0, n: 0 };
      by.set(first, { v: cur.v + s.sessions, n: cur.n + 1 });
    }
    const drawnKeys = tailStartsOf(rest);
    const drawn = [...by.entries()].filter(([first]) => drawnKeys.has(first))
      .sort((x, y) => y[1].v - x[1].v);
    for (const [first, g] of drawn) {
      const id = groupId(first);
      const nm = first.length > 26 ? first.slice(0, 25) + "\u2026" : first;
      nodes.push({ id, c: 1, nm: `from ${nm}`, full: `${g.n} paths that begin at ${first}`,
        v: g.v, tone: "info",
        sub: `${g.n} paths \u00b7 ${pct100((g.v / total) * 100)} of sessions` });
      links.push({ s: "a-" + app.appId, t: id, v: g.v, tone: "info" });
      covered += g.v;
    }
    for (const s of rest) {
      const first = s.journey[0] ?? "";
      if (drawnKeys.has(first)) addStage(s.journey, s.sessions, groupId(first));
    }
    const leftovers = rest.filter((s) => !drawnKeys.has(s.journey[0] ?? ""));
    if (leftovers.length) {
      const v = leftovers.reduce((a, s) => a + s.sessions, 0);
      nodes.push({ id: "j-rest", c: 1,
        nm: `${leftovers.length} other paths`, v, tone: "info",
        sub: `from ${by.size - drawnKeys.size} more starting points`
          + ` \u00b7 ${pct100((v / total) * 100)} of sessions` });
      links.push({ s: "a-" + app.appId, t: "j-rest", v, tone: "info" });
      for (const s of leftovers) addStage(s.journey, s.sessions, "j-rest");
      covered += v;
    }
  }
  const orphan = Math.max(0, journeyable - covered);
  if (orphan) {
    // what remains after the fragments left: real sessions with no page
    // telemetry — request-only monitors, probes, sessions cut mid-load
    nodes.push({ id: "j-none", c: 1, nm: "No page telemetry", v: orphan, tone: "warn",
      sub: `${pct100((orphan / total) * 100)} of sessions` });
    links.push({ s: "a-" + app.appId, t: "j-none", v: orphan, tone: "bad" });
    addStage([], orphan, "j-none");
  }

  for (const [id, s] of stageTot) {
    nodes.push({ id, c: 2, nm: s.nm, v: s.v, tone: s.tone,
      sub: `${pct100((s.v / total) * 100)} of sessions` });
  }
  return { nodes, links };
}

const ORD = ["1st view", "2nd view", "3rd view", "4th view", "5th view", "6th view", "7th view"];
const MAX_STEP = 6;
/** Most nodes a column can show before the rest are folded into one. */
const MAX_PER_COL = 8;

/**
 * The real route through a session: one column per view position, so a node is
 * "the 2nd page these sessions opened", not "the furthest place they got to".
 * Sessions that stop leave through an explicit exit node at the next column,
 * which is why the diagram narrows exactly where users are lost.
 */
export function buildStepModel(app: AppRow, seqs: SeqRow[], trans: TransitionRow[] = []) {
  const mine = seqs.filter((s) => s.appId === app.appId && s.journey.length > 0);
  const measured = mine.reduce((a, s) => a + s.sessions, 0);
  const total = Math.max(1, measured);
  const pctOf = (v: number) => pct100((v / total) * 100);

  const vol = new Map<string, number>();          // `${step}|${view}` → sessions
  const linkVol = new Map<string, number>();      // `${from}>>${to}` → sessions
  const endVol = new Map<string, number>();       // exit/complete node → sessions
  const bump = (m: Map<string, number>, k: string, n: number) => m.set(k, (m.get(k) ?? 0) + n);

  for (const s of mine) {
    const j = s.journey.slice(0, MAX_STEP);
    for (let i = 0; i < j.length; i++) {
      const here = `${i}|${j[i]}`;
      bump(vol, here, s.sessions);
      if (i + 1 < j.length) {
        bump(linkVol, `${here}>>${i + 1}|${j[i + 1]}`, s.sessions);
      } else {
        // the session ends here: converted if the last view is a checkout
        const done = activeDone(j[i]);
        const end = `${done ? "done" : "exit"}-${i + 1}`;
        bump(endVol, end, s.sessions);
        bump(linkVol, `${here}>>${end}`, s.sessions);
      }
    }
  }

  const nodes: Node[] = [];
  const idOf = new Map<string, string>();
  for (const [key, v] of vol) {
    const [stepStr, view] = [key.slice(0, key.indexOf("|")), key.slice(key.indexOf("|") + 1)];
    const step = Number(stepStr);
    const id = `n${step}-${view}`;
    idOf.set(key, id);
    nodes.push({
      id, c: step, v, nm: view.length > 26 ? "…" + view.slice(-25) : view,
      full: view.length > 26 ? view : undefined,
      tone: activeDone(view) ? "good" : INTENT.test(view) ? "warn" : "info",
      sub: `${pctOf(v)} of sessions`,
    });
  }
  for (const [key, v] of endVol) {
    const step = Number(key.split("-")[1]);
    const done = key.startsWith("done");
    nodes.push({
      id: key, c: step, v, tone: done ? "good" : "bad",
      nm: done ? "✓ order completed" : "⊗ left the site",
      sub: `${pctOf(v)} of sessions`,
    });
  }
  const nodeId = (k: string) => idOf.get(k) ?? k;
  // the health of a move, keyed by the two view names it joins
  const health = new Map<string, ReturnType<typeof edgeHealth> & { key: string }>();
  for (const x of trans.filter((x) => x.appId === app.appId)) {
    health.set(`${x.src}>>${x.dst}`, { ...edgeHealth(x), key: `${x.src}>>${x.dst}` });
  }
  let links: Link[] = [...linkVol].map(([key, v]) => {
    const [from, to] = key.split(">>");
    const t = nodes.find((n) => n.id === nodeId(to));
    // from/to are `${step}|${view}` — the health map is keyed by view names
    const viewOf = (k: string) => k.slice(k.indexOf("|") + 1);
    const h = health.get(`${viewOf(from)}>>${viewOf(to)}`);
    return {
      s: nodeId(from), t: nodeId(to), v,
      tone: h?.health === "losing" ? "bad" : h?.health === "slow" ? "warn" : t?.tone ?? "info",
      note: h?.note,
      losing: h?.health === "losing",
    };
  });

  /*
   * A column can only hold so many readable rows. Whatever the data does, keep
   * the biggest views and fold the rest into one node, so the diagram degrades
   * into a summary instead of a comb of unreadable slivers.
   */
  const kept = new Map<string, string>();
  const columns = [...new Set(nodes.map((n) => n.c))];
  const folded: Node[] = [];
  for (const c of columns) {
    const inCol = nodes.filter((n) => n.c === c).sort((a, b) => b.v - a.v);
    const keep = inCol.slice(0, MAX_PER_COL);
    const rest = inCol.slice(MAX_PER_COL);
    keep.forEach((n) => kept.set(n.id, n.id));
    folded.push(...keep);
    if (rest.length) {
      const id = `more-${c}`;
      const v = rest.reduce((a, n) => a + n.v, 0);
      rest.forEach((n) => kept.set(n.id, id));
      folded.push({
        id, c, v, tone: "info",
        nm: `${rest.length} other views`,
        full: rest.map((n) => n.full ?? n.nm).join(" · "),
        sub: `${pctOf(v)} of sessions`,
      });
    }
  }
  // rewire the links onto whatever node survived, merging the duplicates
  const merged = new Map<string, Link>();
  for (const l of links) {
    const s = kept.get(l.s) ?? l.s, t = kept.get(l.t) ?? l.t;
    const key = `${s}>>${t}`;
    const hit = merged.get(key);
    if (hit) hit.v += l.v;
    else merged.set(key, { s, t, v: l.v, tone: l.tone });
  }
  links = [...merged.values()];

  const depth = Math.max(...folded.map((n) => n.c), 0) + 1;
  const cols = Array.from({ length: depth }, (_, i) =>
    i < ORD.length ? ORD[i] : `view ${i + 1}`);
  return { nodes: folded, links, cols, measured };
}

/**
 * The answer the page exists to give, in numbers: how many sessions finished,
 * and where the largest group stopped. Reading it should not require decoding
 * the diagram — the diagram is there to show *where*, not to be the only place
 * the figure lives.
 */
function flowSummary(apps: AppRow[], seqs: SeqRow[], appId?: string | null) {
  const scope = appId ? seqs.filter((s) => s.appId === appId) : seqs;
  if (!scope.length) return null;
  /* ONE RULE with the stage column beside it: finished = reached the deepest
   * journey (depth, no vocabulary). The header once counted by outcome
   * KEYWORD while the stages counted by depth — the same screen printed
   * "570 finished" over a stage node saying 569, and the reader caught the
   * off-by-one before anyone could explain it. Base = journeyed sessions,
   * the same population the stage nodes stand on. */
  const journeyed = scope.filter((s) => s.journey.length > 0);
  const deepest = deepestOf(journeyed);
  const measured = journeyed.reduce((a, s) => a + s.sessions, 0);
  const done = deepest > 1 ? journeyed.filter((s) => s.journey.length >= deepest)
    .reduce((a, s) => a + s.sessions, 0) : 0;
  // where the biggest group of unfinished sessions gave up
  const byLast = new Map<string, number>();
  for (const s of journeyed) {
    if (s.journey.length >= deepest && deepest > 1) continue;
    const last = s.journey[s.journey.length - 1];
    byLast.set(last, (byLast.get(last) ?? 0) + s.sessions);
  }
  const worst = [...byLast].sort((a, b) => b[1] - a[1])[0];
  return {
    measured, done, outcomes: deepest > 1,
    pct: measured ? (done / measured) * 100 : 0,
    dropView: worst?.[0] ?? null,
    dropSessions: worst?.[1] ?? 0,
    appName: appId ? apps.find((a) => a.appId === appId)?.name ?? appId : null,
  };
}

export function FlowSankey({
  apps, seqs, appId, transitions = [], views = [], ux, tf,
  cohort, onCohortConsumed,
  outcomeDefs, onBizScope, onPickApp,
}: {
  apps: AppRow[]; seqs: SeqRow[]; appId?: string | null;
  /** The window on screen — the matching-sessions fetch scans exactly it. */
  tf?: Timeframe;
  /** A cohort intent from Business Control: "unconverted" opens the
   *  infographic on the journeys that reached no goal, no picks required. */
  cohort?: "unconverted" | null;
  onCohortConsumed?: () => void;
  /** The value of one conversion (Business Control's field, via url state) —
   *  turns the route economics into money. null = customers only. */
  /** Customer-taught conversion definitions, per application. */
  outcomeDefs?: OutcomeDefs;
  /** Hand the current selection to Business Control, which recomputes its
   *  journey front for exactly these routes. */
  onBizScope?: (picks: string[]) => void;
  transitions?: TransitionRow[];
  /** Per-app UX aggregate — the funnel reads window-fragment counts from it. */
  ux?: Map<string, { fragments: number; sessions: number; hit: number }> | null;
  /** Per-view measurement from view_summary — the only event that knows how
   *  long a view actually took, because it is emitted when the view ends. */
  views?: ViewRow[];
  onPickApp?: (appId: string) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [selNode, setSelNode] = useState<Node | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  /* The canvas paints from CSS variables at DRAW time. The DOM and the SVG
   * follow a platform theme switch by themselves; a painted bitmap keeps the
   * old palette until something redraws it — measured: switching to light
   * left dark label plates on a white page. The shell flips
   * document.documentElement[data-theme], so watching that attribute is the
   * signal, and this counter is a draw dependency. */
  const [themeTick, setThemeTick] = useState(0);
  useEffect(() => {
    const el = document.documentElement;
    const mo = new MutationObserver(() => setThemeTick((t) => t + 1));
    mo.observe(el, { attributes: true, attributeFilter: ["data-theme", "class"] });
    // the OS-level preference too, for shells that follow it without an attribute
    const mq = window.matchMedia?.("(prefers-color-scheme: light)");
    const onMq = () => setThemeTick((t) => t + 1);
    mq?.addEventListener?.("change", onMq);
    return () => { mo.disconnect(); mq?.removeEventListener?.("change", onMq); };
  }, []);
  const [focus, setFocus] = useState(false);
  /* THE CUSTOM PATH: node ids picked across arbitrary columns of step mode.
   * Each id already encodes its meaning — `n<step>-<view>` is "this view at
   * this position", `done-<n>` / `exit-<n>` an ending — so the picks ARE a
   * sequence predicate: a session matches when its journey satisfies every
   * pick. The model is then REBUILT from only the matching sessions, so
   * every number on screen is the isolated cohort's own, not a lit subset
   * of the old ones. */
  const [picks, setPicks] = useState<string[]>([]);
  /* DEFINING THE CONVERSION JOURNEY, as a declared mode rather than a button
   * that appears once you happen to select something. The mechanism existed —
   * pick routes, the app learns where they END — but nothing on screen said
   * so, which is the same as not having it. Entering the mode says what the
   * app is waiting for, keeps taking picks (more than one journey is the
   * point), and ends in an explicit save. */
  const [stepHint, setStepHint] = useState<string | null>(null);
  /* The route's INFOGRAPHIC — the poster the reader asked for, opened by the
   * button on the path band and laid over the screen. null = closed;
   * "loading" while the two scans run (the cohort's ids, then its portrait). */
  const [info, setInfo] = useState<null | "loading" | "error" | InfoRow[]>(null);
  const [infoStops, setInfoStops] = useState<null | StopRow[]>(null);
  const [infoCohort, setInfoCohort] = useState(0);
  /** Whether the OPEN poster shows the unconverted cohort (set per open —
   *  the old cohortRef read leaked the label onto later manual posters). */
  const [infoIsCohort, setInfoIsCohort] = useState(false);
  /** True when the poster's figures were scaled from capped samples. */
  const [infoApprox, setInfoApprox] = useState(false);
  /* WHAT THE ROUTE IS WORTH: the cohort's conversion beside everyone else's,
   * customers, and — with the ticket set — the money the route carries. All
   * from the same per-session scan the poster already runs. */
  /** HOW THIS ROUTE LOADS — the technical vitals of the cohort beside
   *  everyone else's, in the poster's own cohort-vs-rest grammar. */
  const [infoVitals, setInfoVitals] = useState<null | {
    n: number; rest: number;
    lcp: number; lcpRest: number; ttfb: number; ttfbRest: number;
    fcp: number; fcpRest: number;
  }>(null);
  const [infoBiz, setInfoBiz] = useState<null | {
    customers: number; converted: number; conv: number;
    restConv: number; hit: number;
  }>(null);
  /* "No page telemetry", unpacked on click: what those sessions are made of
   * and which pages their stray beacons name. null = closed. */
  /** The folded remainder, unpacked by DESTINATION — opened from the band
   *  while the "N other paths" node is selected. Measured on this tenant:
   *  162 folded routes ended at just 10 views, one of them the conversion
   *  page — 392 real completions the reader could not see, let alone teach
   *  a goal from. Computed in memory: the journeys are already here. */
  const [ntel, setNtel] = useState<null | "loading" | {
    sessions: number; real: number; robots: number; oneEvent: number;
    reqOnly: number; p50dur: number; pages: Array<{ pg: string; n: number }>;
  }>(null);
  // "paths" (Which routes they take) is the default view by request — the
  // step drop-off is one click away; a custom path or a cohort intent still
  // forces "steps" when it needs the positional columns.
  const [mode, setMode] = useState<"steps" | "paths">("paths");
  /* the ACTIVE outcome test for this render — set before any model builds,
   * so stages, matchers, summary and poster all read the same definition */
  activeDone = outcomeTestFor(appId, outcomeDefs);
  const defsKey = JSON.stringify(outcomeDefs?.[appId ?? ""] ?? null);
  const hitRef = useRef<Array<Node & { x: number; y: number; h: number }>>([]);
  const stepModeRef = useRef(false);
  stepModeRef.current = !!appId && mode === "steps";
  const pathsModeRef = useRef(false);
  pathsModeRef.current = !!appId && mode === "paths";

  /* Route mode picks too, by request: routes and stages are the pickable
   * points. Ids carry their own meaning here as well — `jp-<journey>` is one
   * route, `j-rest` the folded remainder, `st-*` a furthest-stage — and a
   * session matches when it satisfies every column that has picks: any picked
   * route (union within the column) AND any picked stage. */
  /* ONE definition of the context, not two. This used to rebuild the ctx by
   * hand — with a hardcoded 9 where the rest of the file reads ROUTE_MAX — so
   * the page that DRAWS the cohort and the page that RECOMPUTES it could
   * disagree the moment either constant moved. It calls the exported builder
   * now, which is the same one Business Control uses. */
  const pathCtx = React.useMemo(
    () => (appId && apps.some((a) => a.appId === appId) ? routeCtxOf(seqs, appId) : null),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [apps, seqs, appId, defsKey]);

  const matchesRoutePicks = (journey: string[], pk: string[]): boolean =>
    matchesRoutes(journey, pk, pathCtx);
;

  /** The pick predicate of whichever view is on screen. */
  const matchesMode = (journey: string[], pk: string[]): boolean =>
    stepModeRef.current ? matchesPicks(journey, pk) : matchesRoutePicks(journey, pk);

  /** Does this journey pass through every picked point? */
  const matchesPicks = (journey: string[], pk: string[]): boolean => {
    const j = journey.slice(0, MAX_STEP);
    for (const id of pk) {
      const end = /^(done|exit)-(\d+)$/.exec(id);
      if (end) {
        if (j.length !== Number(end[2])) return false;
        const done = activeDone(j[j.length - 1] ?? "");
        if ((end[1] === "done") !== done) return false;
        continue;
      }
      const m = /^n(\d+)-([\s\S]*)$/.exec(id);
      if (!m) return false;             // a folded "N other views" is not a point
      if (j[Number(m[1])] !== m[2]) return false;
    }
    return true;
  };

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const app = appId ? apps.find((a) => a.appId === appId) : undefined;
    const fragmentsOf = (id: string) => ux?.get(id)?.fragments ?? 0;
  const stepMode = !!app && mode === "steps";
    /* Picking normally ISOLATES the flow to the matching journeys — right for
     * analysis, wrong while DEFINING: the first pick would collapse the
     * diagram to itself and there would be nothing left to pick the second
     * journey from, in a mode whose whole point is that more than one journey
     * can mean converted. So definition keeps the full flow on screen. */
    /* ROUTES STAY PICKABLE. Re-mining the flow to the first pick made the
     * other routes disappear, so a second one could never be clicked — the
     * diagram answered "this route" when the reader was still asking "these
     * routes". The count in the bar already states the narrowed cohort, so
     * nothing is lost by leaving every band on screen. The step view still
     * narrows, because there the picks ARE the columns. */
    const seqsIn = app && picks.length && stepMode
      ? seqs.filter((q) => q.appId !== app.appId || matchesPicks(q.journey, picks))
      : seqs;
    // route mode + picks: the model is remined from the matching journeys
    // The application node no longer shrinks to a pick either: the whole flow
    // stays on screen so a second and third route can be chosen, and the bar
    // carries the narrowed cohort in words.
    const isoApp = app;
    const built = !app ? { ...buildModel(apps, seqs, ux),
                           cols: ["Application", "Furthest stage reached", "Session outcome"] }
      : stepMode ? buildStepModel(app, seqsIn, transitions)
      : { ...buildAppModel(isoApp!, seqsIn, fragmentsOf(app.appId),
            pathCtx ? { outcomes: pathCtx.outcomes, deepest: pathCtx.deepest } : undefined,
            ux?.get(app.appId)),
          cols: ["Application", "Navigation path", "Furthest stage reached"] };
    const { nodes, links, cols } = built;

    /* THE DIAGRAM SIZES ITSELF. The shell used to be bound to the viewport
     * alone — clamp(360px, 100vh - 240px, 860px) — so an application with many
     * routes drew more rows than the box could hold and `overflow: hidden`
     * simply cut the last ones off. The busiest column decides the height it
     * needs; the viewport still decides the minimum, so a tall screen is used
     * and a short one scrolls instead of clipping. */
    const rowsNeeded = Math.max(
      ...[0, 1, 2].map((col) => nodes.filter((n) => n.c === col).length), 1);
    c.parentElement?.style.setProperty("--flow-rows", String(rowsNeeded));

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = c.clientWidth, h = c.clientHeight;
      if (!w || !h) return;
      if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr; }
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const padT = 32, padB = 14, gap = 13;
      // step mode packs more columns, so labels sit under their node instead of
      // beside it and the side margins shrink to give the flow room
      const leftPad = stepMode ? 96 : 208, rightPad = stepMode ? 150 : 285;
      const colX = cols.map((_, i) => leftPad + (i / Math.max(1, cols.length - 1)) * Math.max(180, w - leftPad - rightPad));
      // biggest first: the dominant route stays at the top of every column and
      // the long tail collects predictably at the bottom
      const byCol = cols.map((_, i) =>
        nodes.filter((n) => n.c === i).sort((a, b) => b.v - a.v));
      const total = Math.max(...byCol.map((arr) => arr.reduce((a, n) => a + n.v, 0)), 1);
      // one scale for every column, so a ribbon is exactly as wide as the node
      // it leaves — otherwise volume stops being comparable across columns
      const maxCount = Math.max(...byCol.map((a) => a.length), 1);
      const avail = h - padT - padB - gap * Math.max(0, maxCount - 1);
      /* THE FLOOR HAS TO BE PAID FOR. Every node gets at least 5px so a
       * one-session route stays clickable — but that floor was granted on top
       * of a pool already fully distributed, so a column with one dominant
       * route (measured: 1,962 of 1,971 sessions in a single band) overflowed
       * the canvas by roughly one floor+gap per tail route, and the last
       * labels were drawn below the bottom edge and clipped.
       *
       * The column that needs the most decides a single shrink factor, applied
       * everywhere — so the one-scale invariant holds (a ribbon stays exactly
       * as wide as the node it leaves) and nothing lands outside the box. */
      const rawH = (n: Node) => Math.max(5, (n.v / total) * avail);
      const needed = Math.max(1, ...byCol.map((arr) =>
        arr.reduce((a, n) => a + rawH(n), 0) + gap * Math.max(0, arr.length - 1)));
      const room = h - padT - padB;
      const fit = needed > room ? room / needed : 1;
      const placed: Array<Node & { x: number; y: number; h: number; inY: number; outY: number }> = [];
      byCol.forEach((arr, ci) => {
        let y = padT;
        for (const n of arr) {
          const hh = Math.max(3, rawH(n) * fit);
          placed.push({ ...n, x: colX[ci], y, h: hh, inY: y, outY: y });
          y += hh + gap * fit;
        }
      });
      hitRef.current = placed;
      const idx = new Map(placed.map((n) => [n.id, n]));
      const scale = (v: number) => (v / total) * avail;

      const col = (t: Tone) => cssVar(TONE[t]);
      ctx.font = "700 11px monospace";
      ctx.fillStyle = cssVar("--ink-2");
      cols.forEach((t, i) => {
        ctx.textAlign = i === 0 ? "right" : i === cols.length - 1 ? "left" : "center";
        ctx.fillText(t.toUpperCase(), colX[i] + (i === 0 ? -12 : i === cols.length - 1 ? 12 : 0), 15);
      });
      ctx.textAlign = "left";

      // lit path: ancestors and descendants of the selection, following link
      // direction. An undirected flood would leak through shared nodes (every
      // path touches the application node) and light the whole graph.
      const closure = (seed: string) => {
        const d = new Set<string>([seed]), u = new Set<string>([seed]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const l of links) {
            if (d.has(l.s) && !d.has(l.t)) { d.add(l.t); changed = true; }
            if (u.has(l.t) && !u.has(l.s)) { u.add(l.s); changed = true; }
          }
        }
        return { d, u };
      };
      /* THE LIGHT FOLLOWS THE WHOLE SELECTION, not the last thing clicked.
       * Lighting only the last node's ancestry meant picking a stage lit every
       * path that drains into it — the chips said one path, the picture showed
       * five. With more than one pick the lit set is the INTERSECTION of each
       * pick's ancestry, which is exactly the cohort the numbers describe. */
      const down = new Set<string>(), up = new Set<string>();
      const seeds = picks.length ? picks : (sel ? [sel] : []);
      if (seeds.length) {
        const cls = seeds.map(closure);
        for (const id of cls[0].d) if (cls.every((c) => c.d.has(id) || c.u.has(id))) down.add(id);
        for (const id of cls[0].u) if (cls.every((c) => c.d.has(id) || c.u.has(id))) up.add(id);
        for (const sd of seeds) { down.add(sd); up.add(sd); }
      }
      const lit = new Set([...down, ...up]);
      const litLink = (l: Link) =>
        (down.has(l.s) && down.has(l.t)) || (up.has(l.s) && up.has(l.t));

      for (const l of links) {
        const s = idx.get(l.s), t = idx.get(l.t);
        if (!s || !t) continue;
        const lw = Math.max(1.5, scale(l.v));
        const sy = s.outY + lw / 2; s.outY += lw;
        const ty = t.inY + lw / 2; t.inY += lw;
        const x0 = s.x + 9, x1 = t.x - 9, mx = (x0 + x1) / 2;
        const dim = (picks.length || sel) && !litLink(l);
        if (dim && focus) continue; // focus mode: unrelated ribbons disappear
        ctx.beginPath();
        ctx.moveTo(x0, sy - lw / 2);
        ctx.bezierCurveTo(mx, sy - lw / 2, mx, ty - lw / 2, x1, ty - lw / 2);
        ctx.lineTo(x1, ty + lw / 2);
        ctx.bezierCurveTo(mx, ty + lw / 2, mx, sy + lw / 2, x0, sy + lw / 2);
        ctx.closePath();
        // calmer field: soft ribbons by default, brighter when on the lit
        // path, near-invisible when dimmed — labels must win over ribbons
        const a = dim ? "0d" : sel ? "73" : "42";
        const g = ctx.createLinearGradient(x0, 0, x1, 0);
        g.addColorStop(0, col(s.tone) + a);
        g.addColorStop(1, col(l.tone) + a);
        ctx.fillStyle = g;
        ctx.fill();
      }

      for (const n of placed) {
        const dim = (picks.length || sel) && !lit.has(n.id);
        if (dim && focus) continue; // focus mode hides labels of hidden flows too
        ctx.globalAlpha = dim ? 0.25 : 1;
        ctx.fillStyle = col(n.tone);
        ctx.fillRect(n.x - 5, n.y, 10, n.h);
        if (picks.includes(n.id)) {
          // a picked waypoint of the custom path — ringed until unpicked
          ctx.strokeStyle = cssVar("--accent"); ctx.lineWidth = 2.5;
          ctx.strokeRect(n.x - 7.5, n.y - 2.5, 15, n.h + 5);
        } else if (n.id === sel || (n.id === hover && !dim)) {
          ctx.strokeStyle = cssVar("--accent"); ctx.lineWidth = n.id === sel ? 2 : 1;
          ctx.strokeRect(n.x - 6.5, n.y - 1.5, 13, n.h + 3);
        }
        if (n.ab) {
          ctx.save();
          ctx.setLineDash([4, 3]);
          ctx.strokeStyle = cssVar("--bad"); ctx.lineWidth = 1.5;
          ctx.strokeRect(n.x - 8.5, n.y - 3, 17, n.h + 6);
          ctx.restore();
        }
        const left = n.c === 0 && !stepMode;
        ctx.textAlign = stepMode ? "center" : left ? "right" : "left";
        const tx = stepMode ? n.x : left ? n.x - 12 : n.x + 12;
        const subTxt = (n.ab ? "▼ most abandoned · " : "") + `${fmtN(n.v)} · ${n.sub}`;
        /* The count is the point of the diagram, so it is written like it:
         * a heavier face than the name it sits under, and the plate behind it
         * is nearly opaque. At 0.82 a pink ribbon read straight through the
         * digits — "614 sessions" over a band is not a number anyone reads. */
        const subCol = n.ab ? cssVar("--bad") : cssVar("--ink");
        const NM_F = "600 12px sans-serif", SUB_F = "700 11px monospace";

        if (stepMode) {
          // a label needs its own vertical room; below that the tail would
          // overprint itself, so those nodes speak through hover instead
          if (n.h < 17 && n.id !== hover && n.id !== sel) { ctx.globalAlpha = 1; continue; }
          ctx.font = NM_F; const w1 = ctx.measureText(n.nm).width;
          ctx.font = SUB_F; const w2 = ctx.measureText(subTxt).width;
          const bw = Math.max(w1, w2), cy = n.y + n.h / 2;
          ctx.globalAlpha = dim ? 0.55 : 0.97;
          ctx.fillStyle = cssVar("--bg");
          ctx.fillRect(tx - bw / 2 - 6, cy - 14, bw + 12, 31);
          ctx.globalAlpha = dim ? 0.25 : 1;
          ctx.font = NM_F;
          ctx.fillStyle = dim ? cssVar("--ink-3") : cssVar("--ink");
          ctx.fillText(n.nm, tx, cy - 2);
          ctx.font = SUB_F;
          ctx.fillStyle = subCol;
          ctx.fillText(subTxt, tx, cy + 12);
          ctx.globalAlpha = 1;
          continue;
        }
        // backing plate: labels must stay readable over any ribbon behind them
        const plate = (bx: number, by: number, bw: number, bh: number) => {
          ctx.globalAlpha = dim ? 0.55 : 0.97;
          ctx.fillStyle = cssVar("--bg");
          ctx.fillRect(bx, by, bw, bh);
          ctx.globalAlpha = dim ? 0.25 : 1;
        };
        if (!left && n.h < 24) {
          // thin ribbon: one line, or stacked labels of adjacent nodes collide
          ctx.font = NM_F; const w1 = ctx.measureText(n.nm).width;
          ctx.font = SUB_F; const w2 = ctx.measureText(subTxt).width;
          const cy = n.y + n.h / 2;
          plate(tx - 4, cy - 9, w1 + w2 + 17, 18);
          ctx.font = NM_F;
          ctx.fillStyle = dim ? cssVar("--ink-3") : cssVar("--ink");
          ctx.fillText(n.nm, tx, cy + 4);
          ctx.font = SUB_F;
          ctx.fillStyle = subCol;
          ctx.fillText(subTxt, tx + w1 + 9, cy + 4);
        } else {
          ctx.font = NM_F; const w1 = ctx.measureText(n.nm).width;
          ctx.font = SUB_F; const w2 = ctx.measureText(subTxt).width;
          const cy = n.y + n.h / 2, bw = Math.max(w1, w2);
          plate(left ? tx - bw - 4 : tx - 4, cy - 13, bw + 8, 30);
          ctx.font = NM_F;
          ctx.fillStyle = dim ? cssVar("--ink-3") : cssVar("--ink");
          ctx.fillText(n.nm, tx, cy - 2);
          ctx.font = SUB_F;
          ctx.fillStyle = subCol;
          ctx.fillText(subTxt, tx, cy + 12);
        }
        ctx.globalAlpha = 1;
      }
      ctx.textAlign = "left";

      /* tooltip: the full path and its numbers, near the hovered node */
      const hv = hover ? placed.find((p) => p.id === hover) : null;
      if (hv) {
        const l1 = hv.full ?? hv.nm;
        const l2 = `${fmtN(hv.v)} · ${hv.sub}`;
        ctx.font = "600 11px sans-serif";
        const w1 = ctx.measureText(l1).width;
        ctx.font = "500 10px monospace";
        const w2 = ctx.measureText(l2).width;
        const bw = Math.max(w1, w2) + 20, bh = 40;
        const bx = Math.max(6, Math.min(w - bw - 6, hv.x + 16));
        const by = Math.max(6, Math.min(h - bh - 6, hv.y + hv.h / 2 - bh - 6 < 6 ? hv.y + hv.h / 2 + 10 : hv.y + hv.h / 2 - bh - 6));
        ctx.fillStyle = cssVar("--panel-2");
        ctx.strokeStyle = cssVar("--border-2");
        ctx.lineWidth = 1;
        ctx.fillRect(bx, by, bw, bh);
        ctx.strokeRect(bx, by, bw, bh);
        ctx.font = "600 11px sans-serif";
        ctx.fillStyle = cssVar("--ink");
        ctx.fillText(l1, bx + 10, by + 16);
        ctx.font = "500 10px monospace";
        ctx.fillStyle = cssVar("--ink-3");
        ctx.fillText(l2, bx + 10, by + 31);
      }
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    return () => ro.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apps, seqs, transitions, sel, appId, hover, focus, mode, ux, picks, pathCtx,
      defsKey, themeTick]);

  // a custom path belongs to one application's step view — changing either
  // dissolves it, because the picked positions mean nothing elsewhere
  useEffect(() => { setPicks([]); setStepHint(null); }, [appId, mode]);
  useEffect(() => { setStepHint(null); }, [picks.length]);
  // Business Control sends "unconverted": land in step mode and open the
  // portrait of who left without converting, then drop the intent so a manual
  // mode switch does not reopen it.
  const cohortRef = useRef<string | null>(null);
  /** Poster fetch token — a picks-change can close the poster while a fetch
   *  is in flight, and the late answer must not reopen it (audit nit). */
  const infoSeq = useRef(0);
  useEffect(() => {
    // fire once per (intent, app) arrival — not cleared from the url here, so a
    // dev-server hiccup or a re-render cannot lose it; a manual mode switch
    // already closes the poster, and re-firing is blocked by the key match
    const kk = cohort && appId ? `${cohort}|${appId}` : null;
    if (!kk || !tf) return;
    if (cohortRef.current === kk) {
      // blocked (poster already fired for this intent) — still CONSUME the
      // url param, or it strands and re-fires the poster on the next mount
      onCohortConsumed?.();
      return;
    }
    cohortRef.current = kk;
    setMode("steps"); setPicks([]);
    void openInfographic("unconverted");
    onCohortConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cohort, appId, tf]);
  // the fetched list describes ONE set of picks over one window
  // the poster describes one path over one window — a change closes it
  useEffect(() => { infoSeq.current++; setInfo(null); }, [picks.join("|"), appId, tf?.from, tf?.to]);

  /** Unpacks "No page telemetry" — opened from the band's button, never from
   *  the node's click, which stays a selection like any other. */
  const openNoTelemetry = async () => {
    if (!appId || !tf) return;
    setNtel("loading");
    try {
      const rows = await runDql<Record<string, unknown>>(qNoTelemetry(tf, appId), 20);
      const mix = rows.find((r) => r.kind === "mix");
      setNtel({
        sessions: Number(mix?.sessions) || 0, real: Number(mix?.real) || 0,
        robots: Number(mix?.robots) || 0, oneEvent: Number(mix?.oneEvent) || 0,
        reqOnly: Number(mix?.reqOnly) || 0, p50dur: Number(mix?.p50dur) || 0,
        pages: rows.filter((r) => r.kind === "page")
          .map((r) => ({ pg: String(r.bucket), n: Number(r.sessions) || 0 })),
      });
    } catch { setNtel(null); }
  };

  const openInfographic = async (mode?: "unconverted") => {
    if (!appId || !tf) return;
    const seq = ++infoSeq.current;
    setInfo("loading");
    try {
      /* The poster's two scans are INDEPENDENT and used to run in series —
       * measured: 9.2s (cohort attributes) then 2.1s (paths) = 11.3s of
       * "drawing the route's portrait…". Parallel now, and memoised per
       * window+app: the first open costs the slower scan alone, reopening
       * costs nothing. */
      const [rows, pr] = await Promise.all([
        memoDql(qCohortSessions(tf, appId, outcomeDefs), 10000),
        mode === "unconverted"
          ? Promise.resolve(null)
          : memoDql(qPathSessions(tf, appId), 10000),
      ]);
      // membership. "unconverted" is a predicate on the row (reached no goal);
      // otherwise the picked path, matched through the same mining the diagram
      // used, so the cohort is provably the ribbon's.
      let prTotal = 0, prMatched = 0;
      /* WHERE EACH SESSION STOPPED. The last step of a mined journey — kept
       * here because the poster's hardest question ("they showed intent and
       * did not advance: why?") is answered by the screen they stopped on,
       * and this query is already being run. No extra scan. */
      const lastOf = new Map<string, string>();
      const pickIds = pr === null ? null : (() => {
        prTotal = pr.length;
        const set = new Set<string>();
        for (const r of pr) {
          const journey = (Array.isArray(r.path) ? (r.path as string[]) : [])
            .map(normalizeView).filter((v, k, a) => k === 0 || v !== a[k - 1]);
          if (journey.length) lastOf.set(String(r.sid), journey[journey.length - 1]);
          if (journey.length && matchesMode(journey, picks)) set.add(String(r.sid));
        }
        prMatched = set.size;
        return set;
      })();
      const inCohortOf = (r: Record<string, unknown>) =>
        mode === "unconverted" ? Number(r.reached) === 0
        : pickIds ? pickIds.has(String(r.sid)) : true;
      /* HONEST SAMPLING. Both scans are capped (10k sessions, 2k paths);
       * printing a sample's absolute count against the band's full total once
       * read "≈33% of 5,022" for what the band called 100% (audit, vmware).
       * When a cap was hit, counts are scaled from the sample's match RATE to
       * the full mined total and the poster says "≈ · scaled from a sample". */
      const journeyedTotal = seqs.filter((q) => q.appId === appId && q.journey.length > 0)
        .reduce((a, q) => a + q.sessions, 0);
      const appTotal = apps.find((a) => a.appId === appId)?.sessions ?? rows.length;
      let cohortN: number;
      let sampled: boolean;
      if (mode === "unconverted") {
        sampled = rows.length >= 10000;
        const matched = rows.filter(inCohortOf).length;
        cohortN = sampled && rows.length > 0
          ? Math.round((matched / rows.length) * appTotal) : matched;
      } else {
        sampled = prTotal >= 10000 || rows.length >= 10000;
        // the match RATE comes from the path sample itself — the one place
        // that knows which journeys satisfy the picks — scaled to the full
        // mined volume the band displays
        cohortN = sampled && prTotal > 0
          ? Math.round((prMatched / prTotal) * (journeyedTotal || prTotal))
          : rows.filter(inCohortOf).length;
      }
      setInfoApprox(sampled);
      setInfoCohort(cohortN);
      // route economics: real people only, converted = reached an outcome
      const isRealRow = (r: Record<string, unknown>) =>
        Number(r.isReal) === 1 || r.isReal === true || r.isReal === "true";
      const bizOf = (rs: Array<Record<string, unknown>>) => {
        const real = rs.filter(isRealRow);
        const conv = real.filter((r) => Number(r.reached) === 1).length;
        return { customers: real.length, converted: conv,
          conv: real.length ? conv / real.length : 0,
          hit: real.filter((r) => Number(r.errs) > 0).length };
      };
      /* the cohort's LOAD, beside everyone else's — p75 across sessions, the
       * Web Vitals standard's percentile applied to each session's worst
       * measured load. Sessions the platform never timed (soft routes only)
       * are excluded rather than counted as zero. */
      const p75 = (xs: number[]) => {
        if (!xs.length) return 0;
        const t = [...xs].sort((a, b) => a - b);
        return t[Math.min(t.length - 1, Math.ceil(t.length * 0.75) - 1)];
      };
      const timed = (rs: Array<Record<string, unknown>>, k: string) =>
        rs.filter((r) => Number(r.measured) > 0 && Number(r[k]) > 0)
          .map((r) => Number(r[k]));
      /* The stop screens, cohort against everyone else, each with the share of
       * its sessions that met an error — because "they stopped at /cart" and
       * "a third of them hit an error there" are two halves of one answer. */
      const stopTally = (rs: Array<Record<string, unknown>>) => {
        const m = new Map<string, { n: number; err: number }>();
        for (const r of rs) {
          const v = lastOf.get(String(r.sid));
          if (!v) continue;
          const cur = m.get(v) ?? { n: 0, err: 0 };
          cur.n += 1; if (Number(r.errs) > 0) cur.err += 1;
          m.set(v, cur);
        }
        return m;
      };
      const inRows = rows.filter(inCohortOf);
      const outRows = rows.filter((r) => !inCohortOf(r));
      const inTimed = inRows.filter((r) => Number(r.measured) > 0).length;
      setInfoVitals(inTimed > 0 ? {
        n: inTimed, rest: outRows.filter((r) => Number(r.measured) > 0).length,
        lcp: p75(timed(inRows, "lcpMs")), lcpRest: p75(timed(outRows, "lcpMs")),
        ttfb: p75(timed(inRows, "ttfbMs")), ttfbRest: p75(timed(outRows, "ttfbMs")),
        fcp: p75(timed(inRows, "fcpMs")), fcpRest: p75(timed(outRows, "fcpMs")),
      } : null);
      const inStops = stopTally(inRows), outStops = stopTally(outRows);
      const inStopN = [...inStops.values()].reduce((a, x) => a + x.n, 0);
      const outStopN = [...outStops.values()].reduce((a, x) => a + x.n, 0);
      /* THE JOIN THAT WAS MISSING. The poster already knew where sessions end
       * and, separately, how the application loads — and never put the two
       * together, leaving the reader to assume the first is caused by the
       * second. Measured on this tenant it is not: the four screens where
       * sessions end most run 386–523ms while the slowest screen in the app
       * (1,126ms) is barely an ending at all. The per-view timing is already
       * fetched for the chain, so the join costs nothing. */
      const vp50 = new Map(views.filter((v) => !appId || v.appId === appId)
        .map((v) => [v.view, v.p50]));
      const viewTimes = [...vp50.values()].filter((x) => x > 0).sort((a, b) => a - b);
      const appP50 = viewTimes.length ? viewTimes[Math.floor(viewTimes.length / 2)] : 0;
      setInfoStops(inStopN ? [...inStops.entries()]
        .map(([view, x]) => ({
          view, n: x.n, share: x.n / inStopN,
          rest: outStopN ? (outStops.get(view)?.n ?? 0) / outStopN : 0,
          errShare: x.n ? x.err / x.n : 0,
          p50: vp50.get(view) ?? 0,
          appP50,
        }))
        .sort((a, b) => b.n - a.n).slice(0, 7) : null);
      const inB = bizOf(rows.filter(inCohortOf));
      const outB = bizOf(rows.filter((r) => !inCohortOf(r)));
      // counts scale with the same factor the headline count used; RATES
      // (conv, restConv) are the sample's own and stay untouched
      const rawMatched = rows.filter(inCohortOf).length;
      const kf = sampled && rawMatched > 0 ? cohortN / rawMatched : 1;
      setInfoBiz({ customers: Math.round(inB.customers * kf),
        converted: Math.round(inB.converted * kf), conv: inB.conv,
        hit: Math.round(inB.hit * kf), restConv: outB.conv });
      setInfoIsCohort(mode === "unconverted");
      if (!cohortN) { if (seq === infoSeq.current) setInfo([]); return; }

      // pivot to the long form RouteInfographic reads: one row per
      // (dimension, bucket, in/out) with the measures aggregated. Entry view
      // is a dimension too, keyed on the first view.
      type Acc = { sessions: number; hit: number; fatal: number; durs: number[]; views: number[];
        customers: number; converted: number };
      const key = (d: string, b: string, inC: boolean) => `${d}\u0000${b}\u0000${inC ? 1 : 0}`;
      const acc = new Map<string, Acc>();
      const dimDefs = [...INFO_DIMS.filter((d) => d.expr).map((d) => ({ id: d.id, label: d.label })),
        { id: "entry", label: "entry view" }];
      for (const r of rows) {
        if (!(Number(r.isReal) === 1 || r.isReal === true || r.isReal === "true")) { /* keep all: real flag optional */ }
        const inC = inCohortOf(r);
        // conversion per characteristic rides along on the SAME rows the bars
        // already come from — real customers only, so the segment rates and
        // the route's headline conversion are the one number, not two
        const real = isRealRow(r) ? 1 : 0;
        const conv = real && Number(r.reached) === 1 ? 1 : 0;
        const hit = Number(r.errs) > 0 ? 1 : 0;
        const fatal = Number(r.crash) > 0 ? 1 : 0;
        const dur = Number(r.dur) || 0, vw = Number(r.views) || 0;
        for (const d of dimDefs) {
          const raw = r[d.id];
          if (raw === null || raw === undefined || raw === "") continue;
          const b = String(raw);
          const kk = key(d.label, b, inC);
          const a = acc.get(kk) ?? { sessions: 0, hit: 0, fatal: 0, durs: [], views: [],
            customers: 0, converted: 0 };
          a.sessions++; a.hit += hit; a.fatal += fatal; a.durs.push(dur); a.views.push(vw);
          a.customers += real; a.converted += conv;
          acc.set(kk, a);
        }
      }
      const med = (xs: number[]) => { if (!xs.length) return 0;
        const t = [...xs].sort((x, y) => x - y); const m = Math.floor(t.length / 2);
        return t.length % 2 ? t[m] : (t[m - 1] + t[m]) / 2; };
      const info = [...acc.entries()].map(([kk, a]) => {
        const [dim, bucket, inC] = kk.split("\u0000");
        return { dim, bucket, inCohort: inC === "1",
          sessions: a.sessions, hit: a.hit, fatal: a.fatal,
          customers: a.customers, converted: a.converted,
          p50dur: med(a.durs), p50views: med(a.views) };
      });
      if (seq === infoSeq.current) setInfo(info);
    // a failed scan must SAY so — rendering [] here dressed the failure as
    // an empty poster whose stale header still counted sessions
    } catch { if (seq === infoSeq.current) setInfo("error"); }
  };

  /* the lit-path ids belong to one model; changing mode invalidates them */
  useEffect(() => { setSel(null); setSelNode(null); setFocus(false); }, [appId, mode]);
  /* the no-telemetry card closes on Esc, like every overlay here */
  useEffect(() => {
    if (ntel === null) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setNtel(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ntel]);

  const hitAt = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const c = ref.current; if (!c) return null;
    const r = c.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    // step mode centres its labels, so the hit box is centred too
    /* The routes column used to answer to a click anywhere in 260px around a
     * node — 70 to its left and 190 to its right, most of it empty canvas. In
     * a list whose rows are 26px apart that turns an imprecise click into
     * someone else's route, which is what "it keeps assembling paths at
     * random" was. The box is now the bar and its label, nothing more, and it
     * never overlaps the neighbouring row. */
    /* A FORGIVING TARGET, again. The box was tightened when a stray click
     * PILED another band onto the filter — costly, and hard to notice. Now
     * that the navigation-path column holds one selection at a time, a stray
     * click merely replaces it, so precision stopped being worth the misses:
     * thin ribbons whose label is taller than they are were nearly impossible
     * to hit. The label is the target the reader aims at, so the box covers
     * the label. */
    const [padL, padR] = stepModeRef.current ? [72, 72] : [70, 190];
    return hitRef.current.find(
      (n) => mx > n.x - padL && mx < n.x + padR
        && my >= n.y - 4 && my <= n.y + n.h + 4) ?? null;
  };

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const hit = hitAt(e);
    if (!hit) { setSel(null); setSelNode(null); setFocus(false); return; }
    /* Step mode: a click ADDS the view to the custom path (or removes it) —
     * the reader's ask: pick arbitrary views across columns and isolate the
     * journeys passing through all of them. The folded "N other views" node
     * is not a point on any path, so it only opens its panel. */
    if (stepModeRef.current && !hit.id.startsWith("more-")) {
      setPicks((cur) => {
        if (cur.includes(hit.id)) { setStepHint(null); return cur.filter((x) => x !== hit.id); }
        /* A CUSTOM PATH HAS TO BE A PATH. Waypoints were accepted in any
         * combination, so a reader could start on one route and add a view no
         * session ever reaches from it — the picks were legal, the cohort was
         * empty, and the diagram answered with nothing. The click is now tested
         * before it is taken: if no session walks the whole selection, it is
         * refused and the reason is said, instead of silently emptying the
         * screen. */
        const next = [...cur, hit.id];
        const app0 = appId ? apps.find((a) => a.appId === appId) : undefined;
        const reach = app0
          ? seqs.filter((q) => q.appId === app0.appId && q.journey.length
              && matchesPicks(q.journey, next))
              .reduce((a, q) => a + q.sessions, 0)
          : 1;
        if (!reach) {
          setStepHint(`No session goes through ${hit.nm} after the views you have picked — `
            + "they are not on the same path. Remove a waypoint, or start from this one.");
          return cur;
        }
        setStepHint(null);
        return next;
      });
      setSelNode(hit); setSel(hit.id);
      return;
    }
    /* Route mode: routes (jp-…, the folded remainder) and stages narrow the
     * flow the same way; the poster then reads exactly what is on screen. */
    if (pathsModeRef.current
        && (hit.id.startsWith("jp-") || hit.id.startsWith("jg-")
          || hit.id === "j-rest" || hit.id.startsWith("st-"))) {
      /* ONE PATH AT A TIME. The navigation-path column used to accumulate:
       * three unrelated bands could sit in the filter at once, and their union
       * described no journey anybody walks — "from /logout" OR "from /legal"
       * OR "the remainder" is not a path, it is three. A click in this column
       * now REPLACES whatever was picked there. Stages live in another column
       * and still combine, because route-plus-stage narrows one path instead
       * of adding a second. */
      /* ONE PER COLUMN. Each column asks a different question — which path,
       * and how far they got — so the filter holds one answer to each. Two
       * paths at once described no journey; two stages at once describe no
       * outcome either ("browsed OR showed intent" is just a wider net, not a
       * cohort anyone acts on). A click replaces whatever its own column held
       * and leaves the other column alone, so path-plus-stage still narrows
       * one story. */
      const colOf = (id: string) =>
        id.startsWith("st-") ? "stage"
        : (id.startsWith("jp-") || id.startsWith("jg-") || id === "j-rest") ? "path"
        : "other";
      const col = colOf(hit.id);
      setPicks((cur) => {
        if (cur.includes(hit.id)) return cur.filter((x) => x !== hit.id);
        if (col === "other") return [...cur, hit.id];
        return [...cur.filter((x) => colOf(x) !== col), hit.id];
      });
      setSelNode(hit); setSel(hit.id);
      return;
    }
    const same = sel === hit.id;
    setSel(same ? null : hit.id);
    setSelNode(same ? null : hit);
    if (same) setFocus(false);
    if (hit.appId && onPickApp) onPickApp(hit.appId);
  };

  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const hit = hitAt(e);
    setHover(hit?.id ?? null);
    if (ref.current) ref.current.style.cursor = hit ? "pointer" : "default";
  };

  /**
   * The same model the canvas draws, in a form assistive technology can read.
   *
   * A canvas is a picture: it carries no structure, so nothing in the diagram
   * exists for a screen reader and nothing in it can be reached by keyboard.
   * WCAG 2.2 AA is a release requirement here, and the platform audits it
   * independently, so the flow states itself twice — pixels for the eye, a list
   * for everyone else. Both come from the same build functions, so they cannot
   * drift apart.
   */
  const a11yModel = React.useMemo(() => {
    const app = appId ? apps.find((a) => a.appId === appId) : undefined;
    if (!app) return buildModel(apps, seqs, ux);
    return mode === "steps" ? buildStepModel(app, seqs, transitions)
      : buildAppModel(app, seqs, ux?.get(app.appId)?.fragments ?? 0,
          undefined, ux?.get(app.appId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apps, seqs, appId, mode, transitions, ux, defsKey]);

  /** Selects a node from outside the canvas, exactly as a click would. */
  const pick = (n: Node) => {
    const same = sel === n.id;
    setSel(same ? null : n.id);
    setSelNode(same ? null : n);
    if (same) setFocus(false);
    if (n.appId && onPickApp) onPickApp(n.appId);
  };

  const sum = flowSummary(apps, seqs, appId);
  // the app the selection belongs to: a clicked application node, or the picked one
  const selApp = selNode?.appId ?? appId ?? null;

  return (
    <div className="panel flow-shell">
      {/* One band: what you are asking, and the answer in numbers. */}
      <div className="flow-hd">
        <div className="seg" role="group" aria-label="Question">
          <button className={mode === "paths" ? "on" : ""} aria-pressed={mode === "paths"}
            onClick={() => setMode("paths")}
            title="One ribbon per complete route through the application">
            Which routes they take
          </button>
          <button className={mode === "steps" ? "on" : ""} aria-pressed={mode === "steps"}
            onClick={() => setMode("steps")}
            title="One column per view position — shows the order and where sessions stop">
            Where they drop off
          </button>
        </div>
        {sum && (
          <span className="flow-hd__a"
            title="Journeyed sessions — robots and synthetic included, no-telemetry excluded. Finished = reached the deepest journey, the same depth rule the stage column uses. Business Control's conversion uses its own declared depth (the ConvRule strip states it) over the same mined journeys.">
            {sum.outcomes ? (
              <>
                <b>{fmtN(sum.done)}</b> of {fmtN(sum.measured)} sessions finished
                {" "}(<b className={sum.pct >= 50 ? "ok" : "no"}>{pct100(sum.pct)}</b>)
              </>
            ) : (
              <><b>{fmtN(sum.measured)}</b> sessions with a recorded view</>
            )}
            {sum.dropView && (
              <>
                {" · biggest loss at "}<b className="no">{sum.dropView}</b>
                {", "}{fmtN(sum.dropSessions)} sessions
              </>
            )}
          </span>
        )}
        <div className="spacer" />
        <span className="flow-hd__k">
          <i style={{ background: "var(--good)" }} />finished
          <i style={{ background: "var(--warn)" }} />stopped
          <i style={{ background: "var(--bad)" }} />lost
          <i style={{ background: "var(--info)" }} />other
        </span>
      </div>

      {/* The custom path, stated: each waypoint in order, the isolated
          cohort's size, and the way out. Numbers on the canvas are already
          the cohort's own — the model was rebuilt from matching journeys. */}
      {appId && (() => {
        const app = apps.find((a) => a.appId === appId);
        if (!app) return null;
        const steps = mode === "steps";
        const mine = seqs.filter((q) => q.appId === app.appId && q.journey.length > 0);
        const all = mine.reduce((a, q) => a + q.sessions, 0);
        const iso = mine.filter((q) => (steps ? matchesPicks : matchesRoutePicks)(q.journey, picks))
          .reduce((a, q) => a + q.sessions, 0);
        const names = new Map(a11yModel.nodes.map((n) => [n.id, n.nm]));
        const word = (id: string) => {
          if (!steps) return names.get(id) ?? id.replace(/^jp-/, "").split("\u0001").join(" → ");
          const end = /^(done|exit)-(\d+)$/.exec(id);
          if (end) return end[1] === "done" ? "✓ completed" : "⊗ left";
          const m = /^n(\d+)-([\s\S]*)$/.exec(id);
          // English ordinal, like every other UI string ("1º" leaked in)
          const nth = (n: number) => `${n}${["th", "st", "nd", "rd"][
            (n % 100 > 10 && n % 100 < 14) ? 0 : Math.min(n % 10, 4) % 4] ?? "th"}`;
          return m ? `${nth(Number(m[1]) + 1)} ${m[2]}` : id;
        };
        const orderly = steps ? [...picks].sort((a, b) => {
          const st = (id: string) => Number((/(\d+)/.exec(id) ?? [0, 0])[1]);
          return st(a) - st(b);
        }) : picks;
        if (all === 0) return null;
        /* THE DEFINITION BAR. While the mode is on it replaces the ordinary
         * selection strip: it says what the app is waiting for, shows the
         * journeys chosen so far and the DESTINATIONS it will actually store —
         * because arriving is what converting means, and a reader is owed the
         * difference between what they clicked and what gets saved. */
        return (
          <div className="flow-sel flow-sel--path">
            <span className="flow-sel__nm">
              {picks.length ? (steps ? "custom path" : "custom selection") : "whole flow"}</span>
            {orderly.map((id) => (
              <button key={id} className="flow-pick"
                title="Remove this waypoint"
                onClick={() => setPicks((cur) => cur.filter((x) => x !== id))}>
                {word(id)} ✕
              </button>
            ))}
            {stepHint && (
              <span className="flow-sel__no">{stepHint}</span>
            )}
            <span className="flow-sel__num">
              {picks.length
                ? <>{fmtN(iso)} of {fmtN(all)} sessions{all > 0 ? ` · ${pct100((iso / all) * 100)}` : ""}</>
                : <>{fmtN(all)} sessions on screen · click {mode === "steps" ? "views" : "routes or stages"} to narrow</>}
            </span>
            <div className="spacer" />
            {/* the poster portrays WHAT IS ON SCREEN — the whole flow, or the
                narrowed one; the reader's rule: characteristics refer to
                everything the screen currently shows */}
            {sel === "j-none" && (
              <button className="flow-sel__b"
                onClick={openNoTelemetry} disabled={ntel === "loading"}
                title="What the sessions without a recorded view are made of — measured, not guessed">
                {ntel === "loading" ? "unpacking…" : "what are these? ↗"}
              </button>
            )}
            {picks.length > 0 && onBizScope && (
              <button className="flow-sel__b"
                onClick={() => onBizScope(picks)}
                title="Take this selection to Business Control — it recomputes conversion, customers and what failure costs for exactly these routes">
                business control ↗
              </button>
            )}
            <button className="flow-sel__b flow-sel__b--on"
              onClick={() => openInfographic()}
              disabled={info === "loading"}
              title="Draw the portrait of everything on screen — who these users are, on what, from where, with what outcome">
              {info === "loading" ? "drawing…" : "infographic ↗"}
            </button>
            {(() => {
              /* The customer's "this is what converted means", read from
               * whichever sankey they are on. The reader's design: a GOAL is
               * where the customer ARRIVES, and its natural home is the
               * routes view — pick the successful route(s) and the app
               * learns their DESTINATION as the conversion. The step view
               * keeps its per-view teaching for surgical definitions.
               * Folded/starred names are excluded (they cannot equality-
               * match raw view names). */
              const pickedViews = mode === "steps"
                ? [...new Set(picks
                    .map((id) => /^n\d+-([\s\S]*)$/.exec(id)?.[1])
                    .filter((v): v is string => !!v && !v.includes("*")))]
                : [...new Set(picks
                    .filter((id) => id.startsWith("jp-"))
                    .map((id) => id.replace(/^jp-/, "").split("\u0001").pop() ?? "")
                    .filter((v) => !!v && !v.includes("*")))];

              return (<>
                {/* the taught-conversion controls were removed with the
                    unreachable definition mode (audit) — outcomeDefs still
                    steers the queries and the poster's rule line */}
              </>);
            })()}
            {picks.length > 0 && (
              <button className="flow-sel__b" onClick={() => setPicks([])}>
                {mode === "steps" ? "clear path" : "clear selection"} ✕
              </button>
            )}
          </div>
        );
      })()}


      {/* "No page telemetry", unpacked — the sessions the mining never saw,
          shown for what they are: mostly one stray beacon from a REAL page
          whose navigation fell outside the window; some API-only; some robots.
          Closes on Esc or a click outside. */}
      {ntel !== null && (() => {
        const app = appId ? apps.find((a) => a.appId === appId) : undefined;
        const d = ntel === "loading" ? null : ntel;
        const maxPg = d ? Math.max(...d.pages.map((x) => x.n), 1) : 1;
        return (
          <div className="ovl" onClick={() => setNtel(null)} role="dialog" aria-modal="true"
            aria-label="What the sessions without page telemetry are">
            <div className="ntel" onClick={(e) => e.stopPropagation()}>
              <header className="rinfo__hd">
                <span className="rinfo__eyebrow">WHAT THESE SESSIONS ARE · {app?.name ?? ""}</span>
                <h2 className="rinfo__path"><span>No page telemetry, unpacked</span></h2>
                {d && (
                  <div className="rinfo__cohort">
                    <b className="num">{fmtN(d.sessions)}</b>
                    <span>sessions without a recorded view in this window</span>
                  </div>
                )}
                <button className="drawer__x" onClick={() => setNtel(null)} aria-label="Close">✕</button>
              </header>
              {!d ? <div className="rinfo__loading">unpacking…</div> : (
                <>
                  <section className="rinfo__strip">
                    <div className="rinfo__kpi">
                      <b className="num">{fmtN(d.oneEvent)}</b>
                      <span className="rinfo__kpi-l">one stray beacon</span>
                      <em>a real page, seen for ~{fmtMs(d.p50dur)}</em>
                    </div>
                    <div className="rinfo__kpi">
                      <b className="num">{fmtN(d.reqOnly)}</b>
                      <span className="rinfo__kpi-l">API traffic only</span>
                      <em>requests without any page</em>
                    </div>
                    <div className="rinfo__kpi">
                      <b className="num">{fmtN(d.robots)}</b>
                      <span className="rinfo__kpi-l">robots</span>
                      <em>declared non-human</em>
                    </div>
                    <div className="rinfo__kpi">
                      <b className="num">{fmtN(d.real)}</b>
                      <span className="rinfo__kpi-l">real people</span>
                      <em>of the {fmtN(d.sessions)}</em>
                    </div>
                  </section>
                  {d.pages.length > 0 && (
                    <section className="ntel__pages">
                      <h3>the pages their beacons name</h3>
                      {d.pages.map((x) => (
                        <div className="rinfo__bar" key={x.pg} title={`${fmtN(x.n)} sessions`}>
                          <span className="rinfo__bar-l">{x.pg}</span>
                          <span className="rinfo__bar-t">
                            <i className="rinfo__bar-fill" style={{ width: `${(x.n / maxPg) * 100}%` }} />
                          </span>
                          <b className="rinfo__bar-v">{fmtN(x.n)}</b>
                        </div>
                      ))}
                    </section>
                  )}
                  <footer className="rinfo__ft">
                    most of these sessions were on a real page — their navigation simply happened
                    outside this window (window edges and lone beacons) · they are excluded from
                    journey percentages so the funnel is not understated
                  </footer>
                </>
              )}
            </div>
          </div>
        );
      })()}

      {/* a scan that failed says so, with its retry — never an empty poster */}
      {info === "error" && (
        <div className="rinfo rinfo--err" role="alertdialog"
          aria-label="The portrait failed to load">
          <p>The portrait could not be drawn — a scan behind it failed.</p>
          <div>
            <button className="export-btn"
              onClick={() => void openInfographic(infoIsCohort ? "unconverted" : undefined)}>
              try again
            </button>
            <button className="drawer__x" aria-label="Close"
              onClick={() => { setInfo(null); cohortRef.current = null; }}>✕</button>
          </div>
        </div>
      )}
      {/* the route's portrait, over everything — closes on Esc or outside */}
      {info !== null && info !== "error" && (() => {
        const app = appId ? apps.find((a) => a.appId === appId) : undefined;
        const mine = seqs.filter((q) => q.appId === appId && q.journey.length > 0);
        const all = mine.reduce((a, q) => a + q.sessions, 0);
        const names = new Map(a11yModel.nodes.map((n) => [n.id, n.nm]));
        const word = (id: string) => {
          /* The poster gets the WHOLE route. `names` holds the diagram's
           * display label, which is clipped to 34 characters so the bands stay
           * readable — reusing it here handed the poster a title ending in an
           * ellipsis, hiding the very steps it exists to describe. The id
           * carries the full path, so read it from there. */
          if (mode === "paths") {
            if (id.startsWith("jp-")) return id.replace(/^jp-/, "").split("\u0001").join(" → ");
            return names.get(id) ?? id;
          }
          const end = /^(done|exit)-(\d+)$/.exec(id);
          if (end) return end[1] === "done" ? "✓ completed" : "⊗ left";
          const m = /^n(\d+)-([\s\S]*)$/.exec(id);
          return m ? m[2] : id;
        };
        const orderly = mode === "steps" ? [...picks].sort((a, b) => {
          const st = (id: string) => Number((/(\d+)/.exec(id) ?? [0, 0])[1]);
          return st(a) - st(b);
        }) : picks;
        return (
          <RouteInfographic rows={info}
            path={orderly.length ? orderly.map(word)
              : infoIsCohort ? ["customers who left unconverted"]
              : ["every journey on screen"]}
            key={info === "loading" ? "l" : "d"}
            appName={app?.name ?? ""} cohort={infoCohort} total={all}
            biz={infoBiz} vitals={infoVitals} stops={infoStops} approx={infoApprox}
            /* the rule every rate on the poster rests on, from the same source
               the queries compile from — never a list retyped into the view */
            convDef={appId ? {
              taught: !!outcomeDefs?.[appId]?.length,
              unreadable: false,
              items: outcomeDefs?.[appId]?.length ? outcomeDefs[appId] : [...OUTCOME_WORDS],
            } : null}
            onClose={() => { setInfo(null);
              // closing re-arms the cohort intent: a fresh click on the
              // board's "who they are" fires again (it was dead before)
              cohortRef.current = null; }} />
        );
      })()}

      {/* role="img" plus a summary: the drawing is one image, and its detail
          lives in the list below rather than in an unreadable label. */}
      <canvas ref={ref} onClick={onClick} onMouseMove={onMove}
        onMouseLeave={() => setHover(null)} role="img"
        aria-label={
          `Session flow diagram${sum?.appName ? ` for ${sum.appName}` : ""}. `
          + (sum ? `${fmtN(sum.measured)} sessions with a recorded view` : "")
          + (sum?.dropView ? `, biggest loss at ${sum.dropView} with ${fmtN(sum.dropSessions)} sessions` : "")
          + ". The same figures are listed after this diagram."
        } />

      <div className="sr-only">
        <h3>Session flow, as a list</h3>
        <p>
          Each entry is one node of the diagram, with the sessions it holds.
          Activating an entry selects that node, the same as clicking it.
        </p>
        <ul>
          {a11yModel.nodes.map((n) => (
            <li key={n.id}>
              <button onClick={() => pick(n)} aria-pressed={sel === n.id}>
                {n.full ?? n.nm} — {fmtN(n.v)} {n.v === 1 ? "session" : "sessions"}, {n.sub}
              </button>
            </li>
          ))}
        </ul>
        <h3>Flows between them</h3>
        <ul>
          {a11yModel.links.map((l, i) => {
            const from = a11yModel.nodes.find((n) => n.id === l.s);
            const to = a11yModel.nodes.find((n) => n.id === l.t);
            return (
              <li key={i}>
                {(from?.full ?? from?.nm) ?? l.s} to {(to?.full ?? to?.nm) ?? l.t}:{" "}
                {fmtN(l.v)} {l.v === 1 ? "session" : "sessions"}{l.note ? `, ${l.note}` : ""}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

/**
 * What to fix first. Ranked by the sessions each problem costs, because that is
 * the only ordering the business can act on — a lost session outranks a slow
 * one, and volume breaks the tie.
 */

