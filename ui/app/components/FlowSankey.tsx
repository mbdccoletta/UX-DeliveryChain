// Session flow: application → furthest stage reached → outcome.
// Ribbon width is the measured session count; the flow conserves volume, so
// wherever a ribbon narrows is literally where the business loses users.
import React, { useEffect, useRef, useState } from "react";
import { DONE, INFO_DIMS, INTENT, fmtMs, fmtN, normalizeView, qNoTelemetry, qPathSessions,
  qCohortSessions, reachesOutcome, runDql, type Timeframe } from "../utils/dql";
import { RouteInfographic, type InfoRow } from "./RouteInfographic";
import type { AppRow, FrictionRow, SeqRow, TransitionRow, ViewRow } from "../hooks/useChainData";
import { edgeHealth, frictionFor, priorities } from "../utils/friction";

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
  if (outcomes) {
    if (path.some((v) => DONE.test(v))) return "st-order";
    if (path.some((v) => INTENT.test(v))) return "st-cart";
    return path.length > 1 ? "st-prod" : "st-home";
  }
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
  if (outcomes) {
    if (id === "st-order") return { id, nm: "Completed", tone: "good", sub: "reached a final step" };
    if (id === "st-cart") return { id, nm: "Showed intent", tone: "warn", sub: "started but did not finish" };
    if (id === "st-prod") return { id, nm: "Browsed", tone: "warn", sub: "explored without intent" };
    return { id, nm: "Entry view only", tone: "warn", sub: "immediate bounce" };
  }
  if (id === "st-order") return { id, nm: "Reached the deepest journey", tone: "good", sub: `${deepest} views` };
  if (id === "st-cart") return { id, nm: "Went deep", tone: "warn", sub: "3+ views" };
  if (id === "st-prod") return { id, nm: "Two views in", tone: "warn", sub: "2 views" };
  return { id, nm: "Entry view only", tone: "warn", sub: "immediate bounce" };
}

const stageOf = (path: string[], outcomes = true, deepest = 0): Stage =>
  stageMeta(stageIdOf(path, outcomes, deepest), outcomes, deepest);

/** The longest journey observed, used when depth is the only signal. */
const deepestOf = (seqs: SeqRow[]) =>
  seqs.reduce((m, s) => Math.max(m, s.journey.length), 0);

const OUTCOME: Record<string, { id: string; nm: string; tone: Tone; sub: string }> = {
  "st-order": { id: "o-conv", nm: "Converted", tone: "good", sub: "flow with a measured order" },
  "st-cart": { id: "o-cart", nm: "Stopped before the end", tone: "bad", sub: "started and abandoned" },
  "st-prod": { id: "o-browse", nm: "Left without starting", tone: "warn", sub: "no intent recorded" },
  "st-home": { id: "o-browse", nm: "Left without starting", tone: "warn", sub: "no intent recorded" },
  "st-none": { id: "o-blind", nm: "Invisible to the business", tone: "bad", sub: "instrumentation gap" },
};

/** A route node's id IS its journey — stable across model rebuilds, so a
 *  picked route stays ringed when the diagram is re-mined from the cohort. */
const routeId = (journey: string[]) => "jp-" + journey.join("\u0001");

/** Builds nodes and ribbons from sessions per application and mined sequences. */
export function buildModel(apps: AppRow[], seqs: SeqRow[]) {
  const nodes: Node[] = [];
  const links: Link[] = [];
  const stageTot = new Map<string, { nm: string; tone: Tone; sub: string; v: number }>();
  const outTot = new Map<string, { nm: string; tone: Tone; sub: string; v: number }>();
  const envTotal = Math.max(1, apps.reduce((acc, a) => acc + a.sessions, 0));
  const share = (v: number) => fmtPct((v / envTotal) * 100);
  // Decided once for the whole environment: the stage map is shared, so per-app
  // vocabularies would overwrite each other's labels and the column would mix
  // "Completed" with "Reached the deepest journey".
  const envOutcomes = seqs.some((s) => reachesOutcome(s.journey));
  const envDeepest = deepestOf(seqs);

  for (const a of apps) {
    // tone states measured health, never size: errors per view decides it
    const ratio = a.views ? a.errors / a.views : 0;
    const tone: Tone = ratio > 1 ? "bad" : ratio > 0.5 ? "warn" : "good";
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

const fmtPct = (v: number) => `${v.toFixed(v < 10 ? 1 : 0)}%`;

/** True when a mined path never reaches an instrumented checkout view. */
const abandons = (journey: string[]) =>
  journey.length > 0 && !reachesOutcome(journey);

/**
 * Single-application mode: one ribbon per discovered navigation path, sized by
 * sessions, labeled with count and share of the application's sessions.
 */
export function buildAppModel(app: AppRow, seqs: SeqRow[], fragments = 0) {
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

  const ratio = app.views ? app.errors / app.views : 0;
  nodes.push({ id: "a-" + app.appId, c: 0, nm: app.name, v: journeyable,
    tone: ratio > 1 ? "bad" : ratio > 0.5 ? "warn" : "good",
    sub: `${fmtN(mine.length)} paths discovered`
      + (fragments > 0 ? ` · ${fmtN(fragments)} window fragments excluded` : ""),
    appId: app.appId });

  const outcomes = mine.some((s) => reachesOutcome(s.journey));
  const deepest = deepestOf(mine);
  const stageTot = new Map<string, { nm: string; tone: Tone; sub: string; v: number }>();
  const addStage = (path: string[], v: number, from: string) => {
    const st = stageOf(path, outcomes, deepest);
    const cur = stageTot.get(st.id) ?? { nm: st.nm, tone: st.tone, sub: st.sub, v: 0 };
    stageTot.set(st.id, { ...cur, v: cur.v + v });
    links.push({ s: from, t: st.id, v, tone: st.tone });
  };

  const MAX = 9;
  const worst = mine.filter((s) => abandons(s.journey)).sort((a, b) => b.sessions - a.sessions)[0];
  let covered = 0;
  mine.slice(0, MAX).forEach((s) => {
    const id = routeId(s.journey);
    const label = s.journey.join(" → ");
    nodes.push({ id, c: 1, nm: label.length > 34 ? label.slice(0, 33) + "…" : label,
      full: label.length > 34 ? label : undefined,
      v: s.sessions, tone: stageOf(s.journey, outcomes, deepest).tone,
      sub: `${fmtPct((s.sessions / total) * 100)} of sessions`,
      ab: s === worst });
    links.push({ s: "a-" + app.appId, t: id, v: s.sessions, tone: stageOf(s.journey, outcomes, deepest).tone });
    addStage(s.journey, s.sessions, id);
    covered += s.sessions;
  });
  const rest = mine.slice(MAX);
  if (rest.length) {
    const v = rest.reduce((a, s) => a + s.sessions, 0);
    nodes.push({ id: "j-rest", c: 1, nm: `${rest.length} other paths`, v, tone: "info",
      sub: `${fmtPct((v / total) * 100)} of sessions` });
    links.push({ s: "a-" + app.appId, t: "j-rest", v, tone: "info" });
    for (const s of rest) addStage(s.journey, s.sessions, "j-rest");
    covered += v;
  }
  const orphan = Math.max(0, journeyable - covered);
  if (orphan) {
    // what remains after the fragments left: real sessions with no page
    // telemetry — request-only monitors, probes, sessions cut mid-load
    nodes.push({ id: "j-none", c: 1, nm: "No page telemetry", v: orphan, tone: "warn",
      sub: `${fmtPct((orphan / total) * 100)} of sessions · click to see what they are` });
    links.push({ s: "a-" + app.appId, t: "j-none", v: orphan, tone: "bad" });
    addStage([], orphan, "j-none");
  }

  for (const [id, s] of stageTot) {
    nodes.push({ id, c: 2, nm: s.nm, v: s.v, tone: s.tone,
      sub: `${fmtPct((s.v / total) * 100)} of sessions` });
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
  const pctOf = (v: number) => fmtPct((v / total) * 100);

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
        const done = DONE.test(j[i]);
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
      tone: DONE.test(view) ? "good" : INTENT.test(view) ? "warn" : "info",
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
  const measured = scope.reduce((a, s) => a + s.sessions, 0);
  const done = scope.filter((s) => reachesOutcome(s.journey))
    .reduce((a, s) => a + s.sessions, 0);
  // where the biggest group of unfinished sessions gave up
  const byLast = new Map<string, number>();
  for (const s of scope) {
    if (reachesOutcome(s.journey) || !s.journey.length) continue;
    const last = s.journey[s.journey.length - 1];
    byLast.set(last, (byLast.get(last) ?? 0) + s.sessions);
  }
  const worst = [...byLast].sort((a, b) => b[1] - a[1])[0];
  const outcomes = scope.some((s) => reachesOutcome(s.journey));
  return {
    measured, done, outcomes,
    pct: measured ? (done / measured) * 100 : 0,
    dropView: worst?.[0] ?? null,
    dropSessions: worst?.[1] ?? 0,
    appName: appId ? apps.find((a) => a.appId === appId)?.name ?? appId : null,
  };
}

export function FlowSankey({
  apps, seqs, appId, transitions = [], friction = [], views = [], ux, tf,
  cohort, onCohortConsumed, onPickApp, onOpen,
}: {
  apps: AppRow[]; seqs: SeqRow[]; appId?: string | null;
  /** The window on screen — the matching-sessions fetch scans exactly it. */
  tf?: Timeframe;
  /** A cohort intent from Business Control: "unconverted" opens the
   *  infographic on the journeys that reached no goal, no picks required. */
  cohort?: "unconverted" | null;
  onCohortConsumed?: () => void;
  transitions?: TransitionRow[]; friction?: FrictionRow[];
  /** Per-app UX aggregate — the funnel reads window-fragment counts from it. */
  ux?: Map<string, { fragments: number }> | null;
  /** Per-view measurement from view_summary — the only event that knows how
   *  long a view actually took, because it is emitted when the view ends. */
  views?: ViewRow[];
  onPickApp?: (appId: string) => void;
  /** Cross-tab hand-off: open the given app in another view of this app. */
  onOpen?: (tab: "chain" | "journey", appId: string) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [selNode, setSelNode] = useState<Node | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [focus, setFocus] = useState(false);
  /* THE CUSTOM PATH: node ids picked across arbitrary columns of step mode.
   * Each id already encodes its meaning — `n<step>-<view>` is "this view at
   * this position", `done-<n>` / `exit-<n>` an ending — so the picks ARE a
   * sequence predicate: a session matches when its journey satisfies every
   * pick. The model is then REBUILT from only the matching sessions, so
   * every number on screen is the isolated cohort's own, not a lit subset
   * of the old ones. */
  const [picks, setPicks] = useState<string[]>([]);
  /* The route's INFOGRAPHIC — the poster the reader asked for, opened by the
   * button on the path band and laid over the screen. null = closed;
   * "loading" while the two scans run (the cohort's ids, then its portrait). */
  const [info, setInfo] = useState<null | "loading" | InfoRow[]>(null);
  const [infoCohort, setInfoCohort] = useState(0);
  /* "No page telemetry", unpacked on click: what those sessions are made of
   * and which pages their stray beacons name. null = closed. */
  const [ntel, setNtel] = useState<null | "loading" | {
    sessions: number; real: number; robots: number; oneEvent: number;
    reqOnly: number; p50dur: number; pages: Array<{ pg: string; n: number }>;
  }>(null);
  // "paths" (Which routes they take) is the default view by request — the
  // step drop-off is one click away; a custom path or a cohort intent still
  // forces "steps" when it needs the positional columns.
  const [mode, setMode] = useState<"steps" | "paths">("paths");
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
  const pathCtx = React.useMemo(() => {
    const app = appId ? apps.find((a) => a.appId === appId) : undefined;
    if (!app) return null;
    const mine = seqs.filter((q) => q.appId === app.appId)
      .sort((a, b) => b.sessions - a.sessions);
    return {
      top: new Set(mine.slice(0, 9).map((q) => routeId(q.journey))),
      outcomes: mine.some((q) => reachesOutcome(q.journey)),
      deepest: deepestOf(mine),
    };
  }, [apps, seqs, appId]);

  const matchesRoutePicks = (journey: string[], pk: string[]): boolean => {
    if (!pk.length) return true;
    const routes = pk.filter((id) => id.startsWith("jp-") || id === "j-rest");
    const stages = pk.filter((id) => id.startsWith("st-"));
    if (routes.length) {
      const key = routeId(journey);
      const inTop = pathCtx?.top.has(key) ?? false;
      if (!routes.some((id) => (id === "j-rest" ? !inTop : id === key))) return false;
    }
    if (stages.length) {
      const st = stageOf(journey, pathCtx?.outcomes ?? true, pathCtx?.deepest ?? 0).id;
      if (!stages.includes(st)) return false;
    }
    return true;
  };

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
        const done = DONE.test(j[j.length - 1] ?? "");
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
    const seqsIn = app && picks.length
      ? seqs.filter((q) => q.appId !== app.appId ||
          (stepMode ? matchesPicks(q.journey, picks) : matchesRoutePicks(q.journey, picks)))
      : seqs;
    // route mode + picks: the model is remined from the matching journeys
    // only, and the application node shrinks to the isolated cohort — no
    // remainder is invented for the sessions filtered away
    const isoApp = app && !stepMode && picks.length
      ? { ...app, sessions: seqsIn.filter((q) => q.appId === app.appId)
            .reduce((a, q) => a + q.sessions, 0) + fragmentsOf(app.appId) }
      : app;
    const built = !app ? { ...buildModel(apps, seqs),
                           cols: ["Application", "Furthest stage reached", "Session outcome"] }
      : stepMode ? buildStepModel(app, seqsIn, transitions)
      : { ...buildAppModel(isoApp!, seqsIn, fragmentsOf(app.appId)),
          cols: ["Application", "Navigation path", "Furthest stage reached"] };
    const { nodes, links, cols } = built;

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
      const placed: Array<Node & { x: number; y: number; h: number; inY: number; outY: number }> = [];
      byCol.forEach((arr, ci) => {
        let y = padT;
        for (const n of arr) {
          const hh = Math.max(5, (n.v / total) * avail);
          placed.push({ ...n, x: colX[ci], y, h: hh, inY: y, outY: y });
          y += hh + gap;
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
      const down = new Set<string>(), up = new Set<string>();
      if (sel) {
        down.add(sel); up.add(sel);
        let changed = true;
        while (changed) {
          changed = false;
          for (const l of links) {
            if (down.has(l.s) && !down.has(l.t)) { down.add(l.t); changed = true; }
            if (up.has(l.t) && !up.has(l.s)) { up.add(l.s); changed = true; }
          }
        }
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
        const dim = sel && !litLink(l);
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
        const dim = sel && !lit.has(n.id);
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
        const subCol = n.ab ? cssVar("--bad") : cssVar("--ink-2");
        const NM_F = "600 12px sans-serif", SUB_F = "500 11px monospace";

        if (stepMode) {
          // a label needs its own vertical room; below that the tail would
          // overprint itself, so those nodes speak through hover instead
          if (n.h < 17 && n.id !== hover && n.id !== sel) { ctx.globalAlpha = 1; continue; }
          ctx.font = NM_F; const w1 = ctx.measureText(n.nm).width;
          ctx.font = SUB_F; const w2 = ctx.measureText(subTxt).width;
          const bw = Math.max(w1, w2), cy = n.y + n.h / 2;
          ctx.globalAlpha = dim ? 0.4 : 0.88;
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
          ctx.globalAlpha = dim ? 0.4 : 0.82;
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
  }, [apps, seqs, transitions, sel, appId, hover, focus, mode, ux, picks, pathCtx]);

  // a custom path belongs to one application's step view — changing either
  // dissolves it, because the picked positions mean nothing elsewhere
  useEffect(() => { setPicks([]); }, [appId, mode]);
  // Business Control sends "unconverted": land in step mode and open the
  // portrait of who left without converting, then drop the intent so a manual
  // mode switch does not reopen it.
  const cohortRef = useRef<string | null>(null);
  useEffect(() => {
    // fire once per (intent, app) arrival — not cleared from the url here, so a
    // dev-server hiccup or a re-render cannot lose it; a manual mode switch
    // already closes the poster, and re-firing is blocked by the key match
    const kk = cohort && appId ? `${cohort}|${appId}` : null;
    if (!kk || !tf || cohortRef.current === kk) return;
    cohortRef.current = kk;
    setMode("steps"); setPicks([]);
    void openInfographic("unconverted");
    onCohortConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cohort, appId, tf]);
  // the fetched list describes ONE set of picks over one window
  // the poster describes one path over one window — a change closes it
  useEffect(() => { setInfo(null); }, [picks.join("|"), appId, tf?.from, tf?.to]);

  const openInfographic = async (mode?: "unconverted") => {
    if (!appId || !tf) return;
    setInfo("loading");
    try {
      // ONE per-session scan: attributes, whether it reached a goal, outcomes.
      const rows = await runDql<Record<string, unknown>>(qCohortSessions(tf, appId), 5000);
      // membership. "unconverted" is a predicate on the row (reached no goal);
      // otherwise the picked path, matched through the same mining the diagram
      // used, so the cohort is provably the ribbon's.
      const pickIds = mode === "unconverted" ? null : await (async () => {
        const pr = await runDql<Record<string, unknown>>(qPathSessions(tf, appId), 2000);
        const set = new Set<string>();
        for (const r of pr) {
          const journey = (Array.isArray(r.path) ? (r.path as string[]) : [])
            .map(normalizeView).filter((v, k, a) => k === 0 || v !== a[k - 1]);
          if (journey.length && matchesMode(journey, picks)) set.add(String(r.sid));
        }
        return set;
      })();
      const inCohortOf = (r: Record<string, unknown>) =>
        mode === "unconverted" ? Number(r.reached) === 0
        : pickIds ? pickIds.has(String(r.sid)) : true;
      const cohortN = rows.filter(inCohortOf).length;
      setInfoCohort(cohortN);
      if (!cohortN) { setInfo([]); return; }

      // pivot to the long form RouteInfographic reads: one row per
      // (dimension, bucket, in/out) with the measures aggregated. Entry view
      // is a dimension too, keyed on the first view.
      type Acc = { sessions: number; hit: number; fatal: number; durs: number[]; views: number[] };
      const key = (d: string, b: string, inC: boolean) => `${d}\u0000${b}\u0000${inC ? 1 : 0}`;
      const acc = new Map<string, Acc>();
      const dimDefs = [...INFO_DIMS.filter((d) => d.expr).map((d) => ({ id: d.id, label: d.label })),
        { id: "entry", label: "entry view" }];
      for (const r of rows) {
        if (!(Number(r.isReal) === 1 || r.isReal === true || r.isReal === "true")) { /* keep all: real flag optional */ }
        const inC = inCohortOf(r);
        const hit = Number(r.errs) > 0 ? 1 : 0;
        const fatal = Number(r.crash) > 0 ? 1 : 0;
        const dur = Number(r.dur) || 0, vw = Number(r.views) || 0;
        for (const d of dimDefs) {
          const raw = r[d.id];
          if (raw === null || raw === undefined || raw === "") continue;
          const b = String(raw);
          const kk = key(d.label, b, inC);
          const a = acc.get(kk) ?? { sessions: 0, hit: 0, fatal: 0, durs: [], views: [] };
          a.sessions++; a.hit += hit; a.fatal += fatal; a.durs.push(dur); a.views.push(vw);
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
          p50dur: med(a.durs), p50views: med(a.views) };
      });
      setInfo(info);
    } catch { setInfo([]); }
  };

  /* the lit-path ids belong to one model; changing mode invalidates them */
  useEffect(() => { setSel(null); setSelNode(null); setFocus(false); }, [appId]);
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
    const [padL, padR] = stepModeRef.current ? [72, 72] : [70, 190];
    return hitRef.current.find(
      (n) => mx > n.x - padL && mx < n.x + padR && my >= n.y - 4 && my <= n.y + n.h + 4) ?? null;
  };

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const hit = hitAt(e);
    if (!hit) { setSel(null); setSelNode(null); setFocus(false); return; }
    /* Step mode: a click ADDS the view to the custom path (or removes it) —
     * the reader's ask: pick arbitrary views across columns and isolate the
     * journeys passing through all of them. The folded "N other views" node
     * is not a point on any path, so it only opens its panel. */
    if (stepModeRef.current && !hit.id.startsWith("more-")) {
      setPicks((cur) => cur.includes(hit.id)
        ? cur.filter((x) => x !== hit.id) : [...cur, hit.id]);
      setSelNode(hit); setSel(hit.id);
      return;
    }
    /* "No page telemetry" is a question, not a waypoint — clicking it opens
     * the card that unpacks what those sessions are. */
    if (hit.id === "j-none" && appId && tf) {
      setNtel("loading");
      void (async () => {
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
      })();
      return;
    }
    /* Route mode: routes (jp-…, the folded remainder) and stages narrow the
     * flow the same way; the poster then reads exactly what is on screen. */
    if (pathsModeRef.current
        && (hit.id.startsWith("jp-") || hit.id === "j-rest" || hit.id.startsWith("st-"))) {
      setPicks((cur) => cur.includes(hit.id)
        ? cur.filter((x) => x !== hit.id) : [...cur, hit.id]);
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
    if (!app) return buildModel(apps, seqs);
    return mode === "steps" ? buildStepModel(app, seqs, transitions)
      : buildAppModel(app, seqs, ux?.get(app.appId)?.fragments ?? 0);
  }, [apps, seqs, appId, mode, transitions, ux]);

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
          <span className="flow-hd__a">
            {sum.outcomes ? (
              <>
                <b>{fmtN(sum.done)}</b> of {fmtN(sum.measured)} sessions finished
                {" "}(<b className={sum.pct >= 50 ? "ok" : "no"}>{fmtPct(sum.pct)}</b>)
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
          return m ? `${Number(m[1]) + 1}º ${m[2]}` : id;
        };
        const orderly = steps ? [...picks].sort((a, b) => {
          const st = (id: string) => Number((/(\d+)/.exec(id) ?? [0, 0])[1]);
          return st(a) - st(b);
        }) : picks;
        if (all === 0) return null;
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
            <span className="flow-sel__num">
              {picks.length
                ? <>{fmtN(iso)} of {fmtN(all)} sessions{all > 0 ? ` · ${fmtPct((iso / all) * 100)}` : ""}</>
                : <>{fmtN(all)} sessions on screen · click {mode === "steps" ? "views" : "routes or stages"} to narrow</>}
            </span>
            <div className="spacer" />
            {/* the poster portrays WHAT IS ON SCREEN — the whole flow, or the
                narrowed one; the reader's rule: characteristics refer to
                everything the screen currently shows */}
            <button className="flow-sel__b flow-sel__b--on"
              onClick={() => openInfographic()}
              disabled={info === "loading"}
              title="Draw the portrait of everything on screen — who these users are, on what, from where, with what outcome">
              {info === "loading" ? "drawing…" : "infographic ↗"}
            </button>
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

      {/* the route's portrait, over everything — closes on Esc or outside */}
      {info !== null && (() => {
        const app = appId ? apps.find((a) => a.appId === appId) : undefined;
        const mine = seqs.filter((q) => q.appId === appId && q.journey.length > 0);
        const all = mine.reduce((a, q) => a + q.sessions, 0);
        const names = new Map(a11yModel.nodes.map((n) => [n.id, n.nm]));
        const word = (id: string) => {
          if (mode === "paths") return names.get(id) ?? id.replace(/^jp-/, "").split("\u0001").join(" → ");
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
              : cohortRef.current ? ["customers who left unconverted"]
              : ["every journey on screen"]}
            key={info === "loading" ? "l" : "d"}
            appName={app?.name ?? ""} cohort={infoCohort} total={all}
            onClose={() => { setInfo(null); }} />
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
      <Priorities list={priorities(transitions, friction, appId, apps)} />
    </div>
  );
}

/**
 * What to fix first. Ranked by the sessions each problem costs, because that is
 * the only ordering the business can act on — a lost session outranks a slow
 * one, and volume breaks the tie.
 */
function Priorities({ list }: { list: ReturnType<typeof priorities> }) {
  if (!list.length) return null;
  return (
    <div className="prio">
      <div className="prio__t">Fix first</div>
      {list.map((p) => (
        <div className="prio__r" key={p.rank}
          style={{ ["--h" as string]: p.health === "losing" ? "var(--bad)" : "var(--warn)" }}>
          <span className="prio__n">{p.rank}</span>
          <span className="prio__w">
            {p.app && <em className="prio__a">{p.app}</em>}{p.where}
          </span>
          <span className="prio__d">{p.what}</span>
          {p.cause && <span className="prio__c">{p.cause}</span>}
        </div>
      ))}
    </div>
  );
}
