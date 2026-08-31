// Business Control — the board a C-level reader opens.
//
// Not product metrics (apdex, abandoned actions) — those are for the team.
// This speaks the board's language: customers, revenue, conversion, risk;
// each front leads with one HERO number and its trend against the previous
// window of the same length, with a supporting row beneath. Revenue is
// optional and honest: the platform does not know what a conversion is worth,
// so the reader supplies the ticket value and every money figure derives from
// it live; with the field blank the board speaks in customers, which needs no
// assumption. Coverage works the same way: where Dynatrace monitors only part
// of the traffic, the reader states the monitored share and every VOLUME is
// extrapolated to the whole (marked with an approx sign and a bar notice);
// RATES are untouched — a representative sample carries them as they are.
import React from "react";
import type { ChainData } from "../hooks/useChainData";
import { useBizKpis, type BizPeriod } from "../hooks/useBizKpis";
import { useBizForecast } from "../hooks/useBizForecast";
import { useBizBreakdown } from "../hooks/useBizBreakdown";
import { useDifficulty } from "../hooks/useDifficulty";
import { useAppScope } from "../hooks/useAppScope";
import { useRouteCohort, type CohortFacts } from "../hooks/useRouteCohort";
import { deepestOf, routeCtxOf } from "./FlowSankey";
import { fmtMs, fmtN, fmtPct, type OutcomeDefs } from "../utils/dql";
import { useGeo } from "../hooks/useGeo";
import { GEO_WORD, geoBecause, geoJudge, geoName } from "../utils/geoVerdict";
import { exportImage } from "../utils/exportImage";
import { ExplainButton } from "./ExplainButton";

type Dir = "good" | "bad" | "flat";
/** the shared share formatter (utils/dql) — three copies had drifted */
const pct = fmtPct;

/** The ARROW is the direction the number moved; the COLOUR is whether that
 *  was good for the business. Risk rising = ▲ in red; risk falling = ▼ in
 *  green. Conflating the two once made a 60% RISE in customers at risk wear
 *  a down-arrow — the reader caught it. */
function trend(cur: number, prev: number, riseIsGood: boolean):
  { dir: Dir; rel: number | null; arrow: string } {
  if (prev === 0 && cur === 0) return { dir: "flat", rel: 0, arrow: "—" };
  const rel = prev === 0 ? null : (cur - prev) / Math.abs(prev);
  if (rel !== null && Math.abs(rel) < 0.03) return { dir: "flat", rel, arrow: "—" };
  return { dir: (cur > prev) === riseIsGood ? "good" : "bad", rel,
    arrow: cur > prev ? "▲" : "▼" };
}
const TONE: Record<Dir, string> = { good: "var(--good)", bad: "var(--bad)", flat: "var(--ink-3)" };

export function ReportView({ data, scopeApp, cov, onCov, outcomeDefs,
  routePicks, onClearRoutes, onGo }: {
  data: ChainData;
  /** The application this board reads — the header's own selector drives it,
   *  the same element every page uses. */
  scopeApp: string;
  /** The value of one conversion and its currency — URL state, shared with
   *  the Journeys route economics, so both pages read the same money. */
  /** Monitored share (coverage %) — url state, like the ticket, so a shared
   *  link carries the same extrapolated figures. */
  cov: string;
  onCov: (cov: string) => void;
  /** Customer-taught conversion definitions — they replace the keyword
   *  heuristic per application, and the hero says so. */
  outcomeDefs?: OutcomeDefs;
  /* six props (defsUnreadable, savedJourneys, onDropJourney, onEditJourney,
     onStartDefine, onRoutePicks) were declared, documented, passed — and
     never read in the body. They belonged to the unreachable definition
     mode; removed with it (audit). */
  /** Routes picked on Journeys — the board recomputes its journey and brand
   *  figures for exactly those sessions. */
  routePicks?: string[] | null;
  onClearRoutes?: () => void;
  onGo?: (tab: "chain" | "flow" | "home", appId?: string, hl?: string) => void;
}) {
  const kpis = useBizKpis(data.tf, outcomeDefs, scopeApp || null);
  const bcRef = React.useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = React.useState(false);
  /* Access and health by location — the same rows and the same three-arm
   * verdict the Overview map speaks (utils/geoVerdict), memoised per app and
   * window, so opening the board after the map costs no second scan. */
  const geoRows = useGeo(data.tf, scopeApp || null);
  const fc = useBizForecast(data.tf, scopeApp || null, outcomeDefs);
  const breakdown = useBizBreakdown(data.tf, outcomeDefs, scopeApp || null);
  const difficulty = useDifficulty(data.tf, scopeApp || null);
  // the SAME closure the delivery chain resolves — so "incidents in your
  // systems" counts exactly what a click on the button will show lit
  const chainScope = useAppScope(scopeApp || undefined,
    data.apps.find((a) => a.appId === scopeApp)?.entity ?? undefined);
  /** Problems touching THIS application's chain — the board's ONE problem
   *  definition, shared by the open-incidents tile and the Davis button.
   *  (The tile once matched entity ids by substring: zero for every app,
   *  forever, while the header said 24 — three auditors caught it.) */
  const chainProblems = (() => {
    if (!chainScope.resolved) return null;
    const entity = data.apps.find((a) => a.appId === scopeApp)?.entity ?? "";
    return data.problems.filter((pr) => (pr.entityIds ?? [])
      .some((e) => chainScope.services.has(e) || chainScope.runtime.has(e)
        || e === entity)).length;
  })();
  const nameOf = (id: string) =>
    data.apps.find((x) => x.appId === id)?.name ?? id.slice(0, 8);
  /* ROUTE SCOPE — the reader picked routes on Journeys and asked this board
   * to calculate on them. The cohort is reproduced with the same rule that
   * drew it there (matchesRoutes over the same mined journeys), for this
   * window and the previous one, so the trends survive the narrowing. */
  const routeCtx = React.useMemo(
    () => (routePicks?.length && scopeApp ? routeCtxOf(data.sequences, scopeApp) : null),
    [data.sequences, scopeApp, routePicks]);
  const cohort = useRouteCohort(data.tf, scopeApp, routePicks ?? null, routeCtx, outcomeDefs);
  /* NOTHING PICKED — OR NOTHING FOUND — IS THE WHOLE APPLICATION.
   *
   * A board narrowed to journeys nobody walked in this window printed zero
   * everywhere and called it a measurement. Zero customers, zero revenue, zero
   * at risk: a reader is entitled to read that as "we measured, and it was
   * nothing". It was not a measurement, it was an empty cohort. So the board
   * falls back to the whole application and says why it did — the finding
   * ("these journeys had no traffic") is kept as a sentence, not staged as a
   * page of noughts. */
  const emptyPick = !!routePicks?.length && cohort !== null && cohort.cur.sessions === 0;
  const scoped = !!routePicks?.length && !emptyPick;
  const covN = Number(cov);
  const factor = covN >= 1 && covN < 100 ? 100 / covN : 1;
  const ex = factor > 1;
  const sc = (v: number) => v * factor;
  const fmtCount = (v: number) => `${ex ? "≈ " : ""}${fmtN(Math.round(sc(v)))}`;

  /**
   * ROUTE COMPLETENESS — the journey metric that needs no vocabulary.
   *
   * Conversion was read off view NAMES, which fits one demo application and
   * misses every customer whose screens are named otherwise, or whose ending
   * is not a screen. Completeness asks something every application answers:
   * of the routes this application actually has, how deep is the deepest, and
   * what share of sessions got that far. It is the SAME rule the flow draws as
   * "Reached the deepest journey", computed from the same mined routes, so the
   * board and the diagram cannot disagree.
   */
  const completeness = React.useMemo(() => {
    const mine = data.sequences.filter((q) => (!scopeApp || q.appId === scopeApp) && q.journey.length > 0);
    const total = mine.reduce((a, q) => a + q.sessions, 0);
    /* THE SAME FUNCTION the diagram draws with (FlowSankey.deepestOf) — the
     * rule lived twice, and the flow's copy was the naive maximum, so one
     * 9-screen outlier made its header read "2 of 1,171 finished (0.2%)"
     * beside a board saying 49%. */
    const reach = (d: number) =>
      mine.filter((q) => q.journey.length >= d).reduce((a, q) => a + q.sessions, 0);
    const deepest = deepestOf(mine);
    const full = deepest > 1 ? reach(deepest) : 0;
    return { deepest, total, full, share: total ? full / total : 0 };
  }, [data.sequences, scopeApp]);

  /**
   * WHAT DESTOA — the outlier hunter.
   *
   * Every list in this product ranks by VOLUME, so the screen that is broken
   * but small never surfaces. Measured on this tenant: /special-offers.jsp
   * runs 1,126ms against ~450ms for every other screen — the only real
   * performance target in the application, and invisible on every page
   * because it carries 80 views.
   *
   * So this ranks by DEVIATION, and guards it two ways: a screen must carry
   * enough traffic to have a stable timing at all, and it must miss the
   * median by half again before it is called out. Ranked by deviation TIMES
   * the people who meet it, because a screen twice as slow that nobody opens
   * is arithmetic, not a finding.
   */
  const outliers = React.useMemo(() => {
    const mine = data.views.filter((v) => (!scopeApp || v.appId === scopeApp) && v.p50 > 0);
    if (mine.length < 4) return { list: [], median: 0 };
    const sorted = [...mine].map((v) => v.p50).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const floor = Math.max(20, mine.reduce((a, v) => a + v.views, 0) * 0.005);
    const list = mine
      .filter((v) => v.views >= floor && v.p50 >= median * 1.5)
      .map((v) => ({ ...v, times: v.p50 / median, impact: (v.p50 - median) * v.views }))
      .sort((a, b) => b.impact - a.impact)
      .slice(0, 4);
    return { list, median };
  }, [data.views, scopeApp]);

  /**
   * THE BIGGEST SINGLE LOSS, SIZED IN JOURNEYS.
   *
   * "26% end at /logout.jsf" is a share; it does not say what it is worth.
   * The mined routes already know where each journey ends and the board
   * already knows the rate at which journeys complete, so the loss can be
   * expressed in the board's own unit: had those endings behaved like the
   * rest, this many journeys would have completed. No query, no new
   * vocabulary — two things the app already holds, multiplied.
   */
  const biggestLoss = React.useMemo(() => {
    const mine = data.sequences.filter((q) =>
      (!scopeApp || q.appId === scopeApp) && q.journey.length > 0);
    if (!mine.length) return null;
    const byEnd = new Map<string, number>();
    for (const q of mine) {
      const end = q.journey[q.journey.length - 1];
      if (end) byEnd.set(end, (byEnd.get(end) ?? 0) + q.sessions);
    }
    const top = [...byEnd.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!top) return null;
    const total = mine.reduce((a, q) => a + q.sessions, 0);
    return { view: top[0], n: top[1], share: total ? top[1] / total : 0 };
  }, [data.sequences, scopeApp]);

  /**
   * WHERE THEY COME IN DECIDES HOW FAR THEY GO.
   *
   * The mined routes know both ends of every journey — the screen it started
   * on and the depth it reached — and the board never crossed them. Crossed,
   * they answer the one question whose action is cheap: a team cannot easily
   * change what a page asks of a customer, but it CAN change where customers
   * are sent in from. An entry that completes three times better than another
   * is a campaign target, a link, a redirect.
   *
   * Guarded like every other ranking here: an entry needs enough traffic to
   * carry a rate, and the spread has to be worth naming.
   */
  const entries = React.useMemo(() => {
    const mine = data.sequences.filter((q) =>
      (!scopeApp || q.appId === scopeApp) && q.journey.length > 0);
    const total = mine.reduce((a, q) => a + q.sessions, 0);
    if (!total || !completeness.deepest) return null;
    const by = new Map<string, { n: number; full: number }>();
    for (const q of mine) {
      const start = q.journey[0];
      if (!start) continue;
      const cur = by.get(start) ?? { n: 0, full: 0 };
      cur.n += q.sessions;
      if (q.journey.length >= completeness.deepest) cur.full += q.sessions;
      by.set(start, cur);
    }
    const floor = Math.max(30, total * 0.02);
    const rated = [...by.entries()]
      .filter(([, v]) => v.n >= floor)
      .map(([view, v]) => ({ view, n: v.n, rate: v.full / v.n }))
      .sort((a, b) => b.rate - a.rate);
    if (rated.length < 2) return null;
    const best = rated[0], worst = rated[rated.length - 1];
    if (best.rate <= 0 || best.rate < worst.rate * 1.3) return null;
    return { best, worst, times: worst.rate > 0 ? best.rate / worst.rate : Infinity };
  }, [data.sequences, scopeApp, completeness.deepest]);

  const f = (s?: BizPeriod) => {
    const real = s?.realSessions ?? 0;
    const convR = s?.convertedReal ?? 0;
    return {
      customersAtRisk: s?.hitReal ?? 0,
      crashed: s?.fatalSessions ?? 0,
      waited: s?.waitedReal ?? 0,
      reputationIndex: real ? 1 - (s?.hitReal ?? 0) / real : 1,
      customers: real,
      conversion: real ? convR / real : 0,
      converted: convR,
      // REAL people only — engaged over all sessions once mixed with the
      // real customer base and understated bounces by 15% (audit-measured)
      realEngaged: s?.realEngaged ?? 0,
      engagedShare: real ? (s?.realEngaged ?? 0) / real : 0,
    };
  };
  // one application's own two periods — the board has had no estate view
  // since "All applications" was removed, and the query is scoped to match
  const appPeriods = kpis?.byApp.get(scopeApp);
  const curP = appPeriods?.cur;
  const prevP = appPeriods?.prev;
  /** The route cohort wears the same shape the app figures do. */
  const asFacts = (x?: CohortFacts) => ({
    customersAtRisk: x?.hit ?? 0, crashed: x?.crashed ?? 0,
    waited: x?.waited ?? 0,
    reputationIndex: x?.customers ? 1 - (x.hit / x.customers) : 1,
    customers: x?.customers ?? 0,
    conversion: x?.customers ? (x.converted / x.customers) : 0,
    converted: x?.converted ?? 0,
    realEngaged: x?.engaged ?? 0,
    engagedShare: x?.customers ? (x.engaged / x.customers) : 0,
  });
  /* CONVERSION = THE SHARE OF JOURNEYS THAT COMPLETE. One definition, and it
   * needs no vocabulary: a journey is complete when it reaches the depth this
   * application's own traffic still reaches. Every conversion figure on the
   * board is derived from it, so "converted", "left unconverted" and the
   * failure cost can no longer disagree with the diagram. */
  const withCompleteness = (x: ReturnType<typeof asFacts>) => ({
    ...x,
    conversion: completeness.share,
    converted: completeness.full,
  });
  const c = withCompleteness(scoped ? asFacts(cohort?.cur) : f(curP));
  const p = withCompleteness(scoped ? asFacts(cohort?.prev) : f(prevP));
  /* EMPTY IS NOT ZERO. With no real customers in the window (a robot-only
   * tenant, or no traffic at all) every people-based figure divides by
   * nothing — the board once printed "reached first screen only 100%",
   * "bounced 0" and "0 customers at risk" as if they were measurements.
   * The people tiles say "•••" and why, exactly as the Apdex card does. */
  const noPeople = c.customers === 0;
  const NO_PEOPLE = "No real customers in this window — every session on record is "
    + "robot or synthetic traffic (or none exists), so a people-based figure "
    + "has nothing to measure.";

  /**
   * WHAT CHANGED — the first question anyone opens a monitoring app with, and
   * the one this board never answered. Everything here was a photograph of the
   * window; a reader had to hold the previous one in their head.
   *
   * It costs nothing: the board already fetches BOTH windows for its KPIs, so
   * the comparison is arithmetic on numbers in hand. What would cost is
   * comparing ROUTES and SCREENS across windows — a second mining pass — and
   * that is deliberately not done here.
   *
   * Ranked by relative move, floored twice: a fact must be big enough to
   * matter (a jump from one to three is +200% and means nothing) and must
   * have moved more than noise before it is called a change.
   */
  const changed = React.useMemo(() => {
    if (scoped || !curP || !prevP) return null;
    const facts: Array<[string, number, number, boolean]> = [
      ["customers", curP.realSessions, prevP.realSessions, true],
      ["customers at risk", curP.hitReal, prevP.hitReal, false],
      ["customers made to wait", curP.waitedReal, prevP.waitedReal, false],
      ["sessions lost to a crash", curP.fatalSessions, prevP.fatalSessions, false],
      ["customers who bounced",
        Math.max(0, curP.realSessions - curP.realEngaged),
        Math.max(0, prevP.realSessions - prevP.realEngaged), false],
    ];
    const moves = facts
      .filter(([, cur, prev]) => Math.max(cur, prev) >= 20 && prev > 0)
      .map(([label, cur, prev, riseIsGood]) => ({
        label, cur, prev, riseIsGood,
        rel: (cur - prev) / prev,
      }))
      .filter((m) => Math.abs(m.rel) >= 0.15)
      .sort((a, b) => Math.abs(b.rel) - Math.abs(a.rel))
      .slice(0, 3);
    return moves.length ? moves : null;
  }, [scoped, curP, prevP]);

  /**
   * THE DEPTH LADDER — the funnel behind the conversion number.
   *
   * "17%" alone is a verdict without a trial: it does not say WHERE the other
   * 83% fell away. The mined routes already carry every journey's depth, so
   * the hero can show survival step by step — how many journeys reach 1, 2,
   * 3 … views, down to the completion bar. The narrowest drop between two
   * steps is the funnel's real story, and it is named. Zero queries.
   */
  const ladder = React.useMemo(() => {
    const mine = data.sequences.filter((q) =>
      (!scopeApp || q.appId === scopeApp) && q.journey.length > 0);
    const total = mine.reduce((a, q) => a + q.sessions, 0);
    const deep = completeness.deepest;
    if (!total || deep < 2) return null;
    /* EVERY RUNG NAMES ITS SCREEN. "saw 2 screens" is a position, not a
     * place: it tells a reader nothing they can open, act on, or recognise.
     * The mine already knows WHICH screen the journeys at that depth are on,
     * so the rung wears it — but only when one screen actually dominates the
     * depth; naming a spread would be a lie with a majority's confidence. */
    const steps: Array<{ d: number; n: number; view: string | null }> = [];
    for (let d = 1; d <= deep; d++) {
      const at = mine.filter((q) => q.journey.length >= d);
      const n = at.reduce((a, q) => a + q.sessions, 0);
      const byView = new Map<string, number>();
      for (const q of at) {
        const v = q.journey[d - 1];
        if (v) byView.set(v, (byView.get(v) ?? 0) + q.sessions);
      }
      const top = [...byView.entries()].sort((x, y) => y[1] - x[1])[0];
      steps.push({ d, n, view: top && n > 0 && top[1] / n >= 0.5 ? top[0] : null });
    }
    /* A RUNG NOBODY LEFT IS NOT A STEP. Measured on this board: "saw 2
     * screens 860 · 76%" sat directly above "saw 3 screens 860 · 76%" — the
     * identical number twice, because not one journey ended between those
     * depths. It is one step wearing two names, so it is drawn as one row
     * carrying both screens. Only exact zero-loss rungs merge, and never the
     * arrival or the completion bar: a measured loss is never absorbed. */
    const rows: Array<{ dFrom: number; dTo: number; n: number; views: string[];
      absorbed: number }> = [];
    /* Not "zero loss" but "no loss worth a row": measured here, one single
     * journey ended between two rungs and bought itself a whole line —
     * "↓ 1 leave here" between 861 and 860. Half a percent of arrivals is
     * the floor, and whatever it absorbs is stated on the row rather than
     * quietly dropped. */
    const IMMATERIAL = Math.max(1, Math.round(total * 0.005));
    steps.forEach((s, i) => {
      const prev = rows[rows.length - 1];
      const mergeable = i > 0 && i < steps.length - 1 && prev && rows.length > 1
        && prev.n - s.n <= IMMATERIAL;
      if (prev && mergeable) {
        prev.absorbed += prev.n - s.n;
        prev.dTo = s.d;
        prev.n = s.n;
        if (s.view && !prev.views.includes(s.view)) prev.views.push(s.view);
      } else {
        rows.push({ dFrom: s.d, dTo: s.d, n: s.n, views: s.view ? [s.view] : [],
          absorbed: 0 });
      }
    });
    /* WHERE THEY LEFT, on every drop and not just the worst one — that is
     * the question the funnel exists to answer. A journey lost between two
     * rungs ended on its own last screen, which the mine carries. */
    const whereBetween = (dFrom: number, dTo: number) => {
      const at = new Map<string, number>();
      for (const q of mine) {
        if (q.journey.length < dFrom || q.journey.length >= dTo) continue;
        const v = q.journey[q.journey.length - 1];
        if (v) at.set(v, (at.get(v) ?? 0) + q.sessions);
      }
      return [...at.entries()].sort((x, y) => y[1] - x[1]).slice(0, 2)
        .map(([v, n]) => ({ v, n }));
    };
    // the worst drop, measured over the rows actually drawn
    let worst = 0, worstLost = -1;
    for (let i = 1; i < rows.length; i++) {
      const lost = rows[i - 1].n - rows[i].n;
      if (lost > worstLost) { worstLost = lost; worst = i; }
    }
    const where = rows.length > 1
      ? whereBetween(rows[worst - 1]?.dTo ?? 1, rows[worst]?.dFrom ?? 2) : [];
    /* THE SEQUENCES THEMSELVES. The funnel compresses journeys into counts,
     * and the reader's next question is always "which pages, in which order".
     * The mine already has them — the busiest few, spelled out, completed
     * ones marked, are the evidence behind every row above. */
    const top = [...mine].sort((x, y) => y.sessions - x.sessions).slice(0, 5)
      .map((q) => ({ path: q.journey, n: q.sessions,
        done: q.journey.length >= deep }));
    return { rows, whereBetween, total, worst, worstLost, where, top };
  }, [data.sequences, scopeApp, completeness.deepest]);

  const Hero = ({ front }: { front: "brand" | "journeys" }) => {
    if (!kpis) return <div className="bc__hero bc__hero--load" />;
    const isBrand = front === "brand";
    /* Money is back, on a base that holds: a completed journey is a business
     * event the reader can point at in the diagram, so pricing it is honest
     * where pricing a keyword guess was not. */
    if (isBrand && noPeople) return (
      <div className="bc__hero" style={{ ["--ht" as string]: "var(--ink-2)" }}>
        <span className="bc__hero-l">customers at risk</span>
        <b className="bc__hero-v num" title={NO_PEOPLE}>•••</b>
        <span className="bc__hero-s">{NO_PEOPLE}</span>
      </div>
    );
    const heroVal = isBrand ? c.customersAtRisk : c.conversion;
    const prevVal = isBrand ? p.customersAtRisk : c.conversion;
    const t = isBrand ? trend(heroVal, prevVal, false)
      /* Journeys are mined for the window on screen only, so there is no
       * previous window to compare a completion rate against. Printing
       * "steady" would be inventing one. */
      : { dir: "flat" as Dir, rel: null, arrow: "—" };
    const label = isBrand ? "customers at risk" : "conversion";
    const fmt = isBrand ? fmtCount : pct;
    const sub = isBrand
      ? `${fmtCount(c.customersAtRisk)} customers met a failure · ${pct(1 - c.reputationIndex)} of the base`
      /* THE RULE IS STATED ONCE. The ConvRule strip sits directly above this
       * card and spells out what counts as converted; repeating it here put
       * two paragraphs of prose between the reader and the funnel, for a
       * definition they had just read. The card says the count, and nothing
       * the line above it already said. */
      : `${fmtCount(completeness.full)} of ${fmtCount(completeness.total)} journeys completed`
        // the journeys figures are mined per APPLICATION — a route pick does
        // not narrow them, and hiding that read as if it did
        + (scoped ? " · whole application, not the picked routes" : "");
    return (
      <div className="bc__hero" style={{ ["--ht" as string]: TONE[t.dir] }}>
        <span className="bc__hero-l">{label}</span>
        <b className="bc__hero-v num">{fmt(heroVal)}</b>
        <span className="bc__hero-t" style={{ color: TONE[t.dir] }}>
          {isBrand ? <>
            {t.arrow} {t.rel === null ? "new" : t.dir === "flat" ? "steady" : `${Math.abs(t.rel * 100).toFixed(0)}%`}
            <em> vs the previous {data.tf.label.replace(/^last /i, "")}</em>
          </> : <em>no previous window — journeys are mined per window</em>}
        </span>
        <span className="bc__hero-s">{sub}</span>
        {/* the funnel, drawn: one bar per depth, the completion bar marked,
            and the step that loses the most journeys called out in words */}
        {/* THE FUNNEL, AS ROWS. Two rounds of labels could not save the
            vertical bars — the FORM was the problem: tiny columns with tiny
            numbers is an analyst's chart. Rows read like a story: each one a
            sentence with its own bar, and the loss between two rows written
            where it happens, with the screens responsible named. */}
        {!isBrand && ladder && (
          <div className="bc__fun">
            {ladder.rows.map((x, i) => {
              const share = x.n / ladder.total;
              const prevRow = i > 0 ? ladder.rows[i - 1] : null;
              const lost = prevRow ? prevRow.n - x.n : 0;
              const last = i === ladder.rows.length - 1;
              /* the screens the leavers stopped on, named on EVERY drop —
                 "271 leave here" without a place is half an answer */
              const gone = prevRow && lost > 0
                ? ladder.whereBetween(prevRow.dTo, x.dFrom) : [];
              /* THE RUNG IS A PLACE, not a count of screens. Where the depth
                 has no dominant screen the count is the honest fallback. */
              const label = i === 0 ? "arrived"
                : last ? (x.views[0] ? `completed at ${x.views[0]}` : "completed")
                : x.views.length ? x.views.join(" → ")
                : x.dFrom === x.dTo ? `saw ${x.dFrom} screens`
                : `saw ${x.dFrom}–${x.dTo} screens`;
              return (
                <React.Fragment key={`${x.dFrom}-${x.dTo}`}>
                  {i > 0 && lost > 0 && (
                    <div className={i === ladder.worst ? "bc__fun-d bc__fun-d--worst" : "bc__fun-d"}>
                      ↓ {fmtCount(lost)} leave here{gone.length
                        ? <> — most on <b>{gone[0].v}</b></> : null}
                    </div>
                  )}
                  <div className="bc__fun-r">
                    <span className="bc__fun-l" title={[
                      x.views.length
                        ? `Journeys still going at ${x.dFrom === x.dTo ? `screen ${x.dFrom}`
                          : `screens ${x.dFrom}–${x.dTo}`} — most of them on ${x.views.join(", ")}`
                        : null,
                      x.absorbed > 0
                        ? `${fmtCount(x.absorbed)} left between these screens — too few to`
                          + " draw as a step of its own, and counted in the drop below"
                        : null,
                    ].filter(Boolean).join(". ") || undefined}>
                      {label}
                    </span>
                    <span className="bc__fun-t">
                      <i className={last ? "bc__fun-b bc__fun-b--goal" : "bc__fun-b"}
                        style={{ width: `${Math.max(2, share * 100)}%` }} />
                    </span>
                    <b className="num">{fmtCount(x.n)}</b>
                    <em className="num">{pct(share)}</em>
                  </div>
                </React.Fragment>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  /**
   * WHAT THIS BOARD CALLS A CONVERSION — said out loud, above the number.
   *
   * Every figure on this front rests on one predicate, and until now the
   * board only whispered "· your definition" when the reader had taught one,
   * and said nothing at all when it had not. A C-level reader was being shown
   * a conversion rate without being told what counts as converting.
   *
   * So the rule is stated from the SAME constants the queries are compiled
   * from — never a list retyped into the markup, which is how a screen and
   * its query drift apart — and the taught definition is named view by view.
   */
  /* The strip DECLARES the rule the numbers actually use. Its previous body
   * still recited the keyword vocabulary ("any screen named like checkout…")
   * while every figure below had long moved to completeness — a reader asked
   * "would this work for any application?" about a rule the board was not
   * even using. It would not have; this one does, and it needs no vocabulary,
   * no configuration and no language. */
  const ConvRule = () => (
    <div className="bc__rule bc__rule--taught"
      title={"A journey is COMPLETE when it reaches the depth this application's own "
        + "traffic still reaches — the deepest screen count that at least a tenth of "
        + "journeys get to (here: " + completeness.deepest + " screens).\n\nNo screen "
        + "names, no keywords, no setup: the bar is derived from each application's own "
        + "traffic, so it holds for any product, in any language, including apps whose "
        + "completion is not a named screen at all."}>
      <span className="bc__rule-k">counts as converted</span>
      <span className="bc__rule-v">
        a journey that reaches <b>{completeness.deepest} screens</b> — the depth a tenth
        of this application&apos;s own traffic still gets to
      </span>
      <span className="bc__rule-src">derived from the traffic · works for any application</span>
    </div>
  );

  const Stat = ({ label, cur: cv, prev: pv, fmt, riseIsGood, tab, coh, caption, share,
    liveOnly, unmeasured }: {
    label: string; cur: number; prev: number; fmt: (v: number) => string;
    riseIsGood: boolean; tab: "home" | "flow" | "chain";
    /** A cohort intent passed to the Flow — opens its infographic directly. */
    coh?: string;
    /** One line of meaning under the number — what this counts, in words. */
    caption?: string;
    /** Share of the customer base (0..1): drawn as a thin proportion bar. */
    share?: number;
    /** A live-only fact (open problems): no honest previous value exists. */
    liveOnly?: boolean;
    /** The fact could not be measured (e.g. zero real users in the window) —
     *  renders "•••" with this sentence, never a fabricated 0% or 100%. */
    unmeasured?: string;
  }) => {
    if (!kpis) return <div className="bc__stat bc__stat--load" />;
    if (unmeasured) return (
      // no caption here — captions carry percentages of the very base that
      // could not be measured, and "0.0% of the customer base" under "•••"
      // is the fabrication this branch exists to prevent
      <div className="bc__stat" title={unmeasured}>
        <span className="bc__stat-l">{label}</span>
        <div className="bc__stat-row"><b className="bc__stat-v num">•••</b></div>
        <div className="bc__stat-ft">
          <span className="bc__stat-prev" title={unmeasured}>not measurable</span>
        </div>
      </div>
    );
    const t = trend(cv, pv, riseIsGood);
    const drill = coh && scopeApp;
    return (
      <div className="bc__stat">
        <span className="bc__stat-l">{label}</span>
        <div className="bc__stat-row">
          <b className="bc__stat-v num">{fmt(cv)}</b>
          {!liveOnly && (
            <span className="bc__stat-t" style={{ color: TONE[t.dir] }}>
              {t.arrow} {t.rel === null ? "new" : t.dir === "flat" ? "—" : `${Math.abs(t.rel * 100).toFixed(0)}%`}
            </span>
          )}
        </div>
        {caption && <span className="bc__stat-cap">{caption}</span>}
        {share !== undefined && Number.isFinite(share) && (
          <span className="bc__stat-bar" role="img"
            aria-label={`${pct(Math.max(0, Math.min(1, share)))} of customers`}>
            <i style={{ width: `${Math.max(0, Math.min(1, share)) * 100}%` }} />
          </span>
        )}
        <div className="bc__stat-ft">
          <span className="bc__stat-prev"
            title={liveOnly ? "Only live problems are known — there is no honest previous value"
              : `Previous ${data.tf.label}`}>
            {liveOnly ? "live now" : `was ${fmt(pv)}`}</span>
          {drill && (
            <button className="bc__stat-mv" onClick={() => onGo?.(tab, scopeApp, coh)}
              title="Portrait of who left — country, device, browser, where they enter">
              ↗ who they are</button>
          )}
        </div>
      </div>
    );
  };

  // ── what failure costs: conversion of error-free vs error-touched sessions,
  //    from the breakdown's "__err" leg, cut to the scope. The gap × the hit
  //    sessions is the conversions the errors cost — arithmetic on measured
  //    rates, stated as such.
  const scopedRows = breakdown?.filter((r) => !scopeApp || r.appId === scopeApp) ?? null;

  // ── segments: buckets ranked by ERROR lift against the application's own
  //    rate. Human sessions only, and only buckets big enough to mean
  //    something. The baseline is the same population the buckets come from,
  //    so a group is compared with its peers and not with a different scan.
  const segments = (() => {
    if (!scopedRows) return null;
    const bAll = scopedRows.filter((r) => r.d !== "__err" && r.d !== "user type");
    const bN = bAll.reduce((a, r) => a + r.realN, 0);
    const base = bN ? bAll.reduce((a, r) => a + r.realHit, 0) / bN : 0;
    if (!base) return { best: [], worst: [] };
    const byBucket = new Map<string, { d: string; bucket: string; n: number; conv: number }>();
    for (const r of scopedRows) {
      if (r.d === "__err" || r.d === "user type") continue;
      const k = `${r.d}\u0000${r.bucket}`;
      const a = byBucket.get(k) ?? { d: r.d, bucket: r.bucket, n: 0, conv: 0 };
      /* ERROR, not the keyword conversion this used to rank on. The bucket
       * rows already carry realHit — sessions in the group that met an error —
       * so the same section answers "where does failure concentrate" without
       * the vocabulary the product abandoned, and works for any application. */
      a.n += r.realN; a.conv += r.realHit; byBucket.set(k, a);
    }
    const rows = [...byBucket.values()]
      .filter((x) => x.n >= 50 && x.n < (c.customers || Infinity))
      .map((x) => ({ ...x, rate: x.conv / x.n, lift: (x.conv / x.n) / base }))
      .filter((x) => Math.abs(x.lift - 1) >= 0.15);
    return {
      best: rows.filter((x) => x.lift > 1).sort((a, b) => b.lift - a.lift).slice(0, 4),
      worst: rows.filter((x) => x.lift < 1).sort((a, b) => a.lift - b.lift).slice(0, 4),
    };
  })();

  // ── where the difficulty lives: inside the backend or outside it.
  //    Time evidence: each view's wait decomposed by the agent. Error
  //    evidence: each error's origin. Differential: does the suffering
  //    concentrate in one segment (points outside) or hit all alike
  //    (points inside)? Davis corroborates from the chain's own problems.
  const where = (() => {
    const d = scopeApp ? difficulty?.get(scopeApp) : undefined;
    if (!d) return null;
    const sh = (x: { net: number; srv: number; rend: number }) => {
      const tot = x.net + x.srv + x.rend;
      return tot ? { srv: x.srv / tot, net: x.net / tot, rend: x.rend / tot } : null;
    };
    const cur = sh(d.slow.cur), prev = sh(d.slow.prev);
    const per = (v: number) => d.slow.cur.meas ? v / d.slow.cur.meas : 0; // ns per measured view
    const err = d.err.cur;
    const errN = (b: string) => err.get(b as never) ?? 0;
    const outErr = errN("frontend") + errN("third_party") + errN("device")
      + errN("connection") + errN("request_4xx") + errN("other");
    // differential: does the error-hit concentrate in one segment?
    let conc: { bucket: string; dim: string; lift: number } | null = null;
    if (scopedRows) {
      const overallN = scopedRows.filter((r) => r.d === "__err")
        .reduce((a, r) => a + r.realN, 0);
      const overallHit = scopedRows.filter((r) => r.d === "__err")
        .reduce((a, r) => a + r.realHit, 0);
      const base = overallN ? overallHit / overallN : 0;
      if (base > 0) {
        for (const r of scopedRows) {
          if (r.d === "__err" || r.d === "user type" || r.realN < 50 || r.realHit < 20) continue;
          const lift = (r.realHit / r.realN) / base;
          if (lift >= 2 && (!conc || lift > conc.lift)) conc = { bucket: r.bucket, dim: r.d, lift };
        }
      }
    }
    // ONE problem definition on this board: chainProblems (chain-scoped),
    // shared with the open-incidents tile above.
    const errTotal = ["backend", "frontend", "policy", "third_party", "device",
      "connection", "request_4xx", "other"].reduce((a, b) => a + errN(b), 0);
    return { cur, prev, per, d, errN, outErr, errTotal, conc,
      backendProblems: chainProblems };
  })();

  const range = (pj: { lower: number; upper: number }) =>
    `${fmtN(Math.round(sc(Math.max(0, pj.lower))))}–${fmtN(Math.round(sc(pj.upper)))}`;

  return (
    <div className="stack bc" ref={bcRef}>
      <div className="bc__bar">
        <span className="lbl">Business Control</span>
        <span className="hint">{data.tf.label} vs the {data.tf.label} before ·{" "}
          {ex ? <b className="bc__ex-note">volumes ×{factor.toFixed(1)} — extrapolated from {covN}% monitored; rates as measured</b>
            : "measured, not estimated"}</span>
        <div className="spacer" />
        <label className="bc__ticket bc__cov"
          title="Share of your traffic Dynatrace monitors. Below 100, every volume on the board is extrapolated to the whole (marked with an approx sign); rates stay as measured — a representative sample carries them unchanged.">
          <input inputMode="numeric" placeholder="100"
            value={cov} onChange={(e) => onCov(e.target.value.replace(/[^\d]/g, "").slice(0, 3))} />
          <span>% monitored</span>
        </label>
        {/* the board is a thing people paste into decks — export the whole
            of it, not a viewport crop */}
        <button className="export-btn noexport" disabled={exporting}
          title="Download this board as a PNG (2×) — the export button itself stays out of the picture"
          onClick={async () => {
            if (!bcRef.current) return;
            setExporting(true);
            try { await exportImage(bcRef.current, `business-control-${data.tf.label.replace(/\W+/g, "-")}`); }
            finally { setExporting(false); }
          }}>
          {exporting ? "rendering…" : "export image ↓"}
        </button>
        {/* THE BOARD, READ BACK IN WORDS. Built at click time from the same
            figures the tiles render — including the ones that could NOT be
            measured, stated as such, so Assist never fills a gap with a
            plausible number. */}
        <ExplainButton subject="board" className="export-btn noexport"
          facts={() => {
            const lines = [
              `Application: ${nameOf(scopeApp) || "unknown"}`,
              `Window: ${data.tf.label} (compared with the window of the same`
                + " length immediately before it)",
              scoped ? "The reader has narrowed the brand figures to picked routes"
                : "Scope: the whole application",
              "",
              "PROTECT THE BRAND",
              noPeople
                ? `  NOT MEASURABLE: ${NO_PEOPLE}`
                : `  Customers (real users): ${fmtCount(c.customers)}\n`
                  + `  Customers hit by a failure: ${fmtCount(c.customersAtRisk)}`
                  + ` (was ${fmtCount(p.customersAtRisk)})\n`
                  + `  Customers made to wait (an action over 3s): ${fmtCount(c.waited)}`
                  + ` (was ${fmtCount(p.waited)})\n`
                  + `  Customers who bounced: ${fmtCount(Math.max(0, c.customers - c.realEngaged))}`,
              `  Sessions lost to a crash or freeze: ${fmtCount(c.crashed)}`,
              `  Open incidents on this application's chain: ${
                chainProblems === null ? "still resolving" : fmtN(chainProblems)}`,
              "",
              "DELIVER PERSONALISED JOURNEYS",
              `  Conversion: ${pct(completeness.share)} — ${fmtCount(completeness.full)} of`
                + ` ${fmtCount(completeness.total)} mined journeys completed`,
              `  A journey counts as complete when it reaches ${completeness.deepest} screens,`
                + " the depth a tenth of this application's own traffic still reaches",
              "  (journeys are mined per window, so there is no previous window to compare)",
              ladder ? "  The funnel, rung by rung:" : "",
              ...(ladder ? ladder.rows.map((x, i) => {
                const prev = i > 0 ? ladder.rows[i - 1] : null;
                const lost = prev ? prev.n - x.n : 0;
                const where = prev && lost > 0 ? ladder.whereBetween(prev.dTo, x.dFrom) : [];
                const name = i === 0 ? "arrived"
                  : x.views.length ? x.views.join(" -> ")
                  : `${x.dFrom} screens`;
                return `    ${name}: ${fmtCount(x.n)}`
                  + (lost > 0 ? ` (${fmtCount(lost)} left before this`
                    + (where.length ? `, most on ${where[0].v}` : "") + ")" : "");
              }) : []),
              "",
              geoRows && geoRows.length ? "WHERE THE CUSTOMERS ARE" : "",
              ...(geoRows ?? []).slice(0, 6).map((g) => {
                const tot = (geoRows ?? []).reduce((a, x) => a + x.sessions, 0) || 1;
                const base = (geoRows ?? []).reduce((a, x) => a + x.hit, 0) / tot;
                return `  ${geoName(g.country)}: ${fmtN(g.sessions)} sessions,`
                  + ` ${GEO_WORD[geoJudge(g, base)]} — ${geoBecause(g, base)}`;
              }),
            ];
            return lines.filter(Boolean).join("\n");
          }} />
      </div>

      {/* WHAT CHANGED — first, because it is the first question. */}
      {changed && (
        <div className="bc__chg">
          <span className="bc__chg-l">what changed vs the previous {data.tf.label.replace(/^last /i, "")}</span>
          <div className="bc__chg-rows">
            {changed.map((m) => {
              const up = m.rel > 0;
              const good = up === m.riseIsGood;
              return (
                <span className={`bc__chg-r${good ? "" : " bc__chg-r--bad"}`} key={m.label}>
                  <i>{up ? "▲" : "▼"}</i>
                  <b className="num">{Math.abs(m.rel * 100).toFixed(0)}%</b>
                  <span>{m.label}</span>
                  <em>{fmtCount(m.prev)} → {fmtCount(m.cur)}</em>
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* THE ROUTE SCOPE, stated. A board quietly narrowed is a board that
          lies by omission: this says what it is calculating on, how many
          sessions that is, and hands back the whole application in one click. */}
      {emptyPick && (
        <div className="bc__scoped">
          <span className="bc__scoped-l">showing the whole application</span>
          <span className="bc__scoped-none">
            nobody walked {routePicks && routePicks.length > 1 ? "those journeys" : "that journey"}
            {" "}in this window, so the board fell back to everything rather than printing a
            {" "}page of zeros. Widen the timeframe to see them.
          </span>
          <button className="bc__scoped-x" onClick={() => onClearRoutes?.()}>
            forget the selection ✕
          </button>
        </div>
      )}
      {scoped && (
        <div className="bc__scoped">
          <span className="bc__scoped-l">calculating on picked routes</span>
          <span className="bc__scoped-v">
            {cohort === null ? "reading the cohort…"
              : `${fmtN(cohort.cur.sessions)} sessions · ${fmtN(cohort.cur.customers)} customers`}
            {cohort?.sampled && " · scaled from a capped sample"}
          </span>
          {/* (an empty cohort never reaches here — emptyPick catches it above
              and its banner carries the "EMPTY, not zero" sentence) */}
          <button className="bc__scoped-x" onClick={() => onClearRoutes?.()}>
            whole application ✕
          </button>
        </div>
      )}

      {/* Davis's projection of the NEXT window — labeled as forecast, never
          mixed with the measured figures above it */}
      <div className="bc__fc" role="note">
        <span className="bc__fc-l">next {data.tf.label.replace(/^last /i, "")} · Davis forecast
          {scoped && " · whole application"}</span>
        {!fc ? <span className="bc__fc-wait">projecting…</span> : (
          <>
            {/* The conversion leg is gone. It projected the keyword predicate
                the product no longer uses, and the honest replacement —
                projecting completed journeys — is not worth its cost:
                completeness is a ratio derived in the browser from mined
                routes, with no timeseries behind it, so forecasting it would
                need a two-stage query to produce a number carrying more
                uncertainty than value. Volume IS directly projectable, so the
                board projects volume. One fewer analyzer leg, measured
                earlier as the heaviest scan in the product. */}
            {fc.sessions && (
              <span className="bc__fc-item">
                <b className="num">≈ {fmtN(Math.round(sc(fc.sessions.point)))}</b> sessions
                <em>({range(fc.sessions)})</em>
              </span>
            )}
            {!fc.sessions && !fc.conversions && (
              <span className="bc__fc-wait">not enough history to project</span>
            )}
          </>
        )}
      </div>

      <section className="bc__front" style={{ ["--fh" as string]: "var(--t-pink)" }}>
        <h2 className="bc__ftitle">Protect the brand</h2>
        <div className="bc__row">
          <Hero front="brand" />
          <div className="bc__stats">
            <Stat label="customers hit by a failure" cur={c.customersAtRisk} prev={p.customersAtRisk}
              unmeasured={noPeople ? NO_PEOPLE : undefined}
              fmt={fmtCount} riseIsGood={false} tab="home"
              caption={`${pct(c.customers ? c.customersAtRisk / c.customers : 0)} of the customer base`}
              share={c.customers ? c.customersAtRisk / c.customers : 0} />
            <Stat label="sessions lost to a crash or freeze" cur={c.crashed} prev={p.crashed}
              fmt={fmtCount} riseIsGood={false} tab="home"
              caption="crashes and ANRs — ended with no way back" />
            {/* This slot held "brand health (0–100)": the share of customers
                untouched by a failure, printed as an integer. Measured on
                easytravel it read 100 against a previous 100 — and so would
                every variant of it, because 5 harmed customers in 5,380 is
                99.91%. Widening the harm did not help either: errors OR waits
                over 12s gave 99.78, over 3s gave 99.57. Both round to 100.
                An index over a rare event has no resolution left to show.
                So the slot now carries the harm the board was missing, as the
                count it is — 18 customers waited where 5 met a failure, two
                different harms that no longer hide inside one saturated 100. */}
            <Stat label="customers made to wait" cur={c.waited} prev={p.waited}
              unmeasured={noPeople ? NO_PEOPLE : undefined}
              fmt={fmtCount} riseIsGood={false} tab="chain"
              caption="an action took longer than 3s — the platform's own satisfaction threshold"
              share={c.customers ? c.waited / c.customers : 0} />
            <Stat label="open incidents"
              cur={chainProblems ?? 0} prev={chainProblems ?? 0}
              fmt={(v) => (chainProblems === null ? "…" : fmtN(v))}
              riseIsGood={false} tab="chain" liveOnly
              caption="on this application's chain — confirmed by AI monitoring" />
          </div>
        </div>
      </section>

      <section className="bc__front" style={{ ["--fh" as string]: "var(--t-cyan)" }}>
        <h2 className="bc__ftitle">Deliver personalised journeys</h2>
        <ConvRule />

        <div className="bc__row">
          <Hero front="journeys" />
          <div className="bc__stats">
            {/* The unit is the JOURNEY, not the customer: completeness is
                measured on the mined routes, and calling those sessions
                "customers" would mix two populations in one sentence. */}
            <Stat label="journeys completed" cur={c.converted} prev={p.converted}
              fmt={fmtCount} riseIsGood={true} tab="flow" liveOnly
              caption={`${pct(c.conversion)} of journeys reached the full depth`}
              share={c.conversion} />
            <Stat label="journeys cut short"
              cur={completeness.total - completeness.full}
              prev={completeness.total - completeness.full}
              fmt={fmtCount} riseIsGood={false} tab="flow" liveOnly
              caption="stopped before the depth the rest of the traffic reaches"
              share={completeness.total
                ? (completeness.total - completeness.full) / completeness.total : 0}
              coh="unconverted" />
            {/* "Opportunity on the table" was `(customers − converted) × rate
                × ticket`. Once converted became a count of JOURNEYS and
                customers stayed a count of PEOPLE, that subtraction mixed two
                populations and the money it produced meant nothing. There is
                no money figure without a conversion to price, so the slot
                carries a fact the board can actually stand behind. */}
            <Stat label="reached first screen only" cur={1 - c.engagedShare} prev={1 - p.engagedShare}
              unmeasured={noPeople ? NO_PEOPLE : undefined}
              fmt={pct} riseIsGood={false} tab="flow"
              caption="never saw a second screen" share={1 - c.engagedShare} />
            <Stat label="customers who bounced"
              cur={Math.max(0, c.customers - c.realEngaged)}
              prev={Math.max(0, p.customers - p.realEngaged)}
              unmeasured={noPeople ? NO_PEOPLE : undefined}
              fmt={fmtCount} riseIsGood={false} tab="flow"
              caption="came, saw one screen, left" />
            {entries && (
              <div className="bc__entry">
                <span className="bc__entry-l">where they come in decides how far they go</span>
                <div className="bc__entry-r">
                  <span className="bc__entry-w">
                    <b className="num">{entries.best.view}</b>
                    <em>{pct(entries.best.rate)} complete · {fmtCount(entries.best.n)} journeys</em>
                  </span>
                  <i className="bc__entry-x">
                    {entries.times === Infinity ? "the only entry that completes"
                      : `${entries.times.toFixed(1)}× better`}
                  </i>
                  <span className="bc__entry-w bc__entry-w--bad">
                    <b className="num">{entries.worst.view}</b>
                    <em>{pct(entries.worst.rate)} complete · {fmtCount(entries.worst.n)} journeys</em>
                  </span>
                </div>
                <span className="bc__entry-ft">
                  the screen a journey STARTS on, against how far it gets. Changing where
                  customers are sent in is cheaper than changing what a page asks of them.
                </span>
              </div>
            )}
            {biggestLoss && completeness.share > 0 && (
              <div className="bc__loss">
                <span className="bc__loss-l">biggest single loss</span>
                <b className="num">{biggestLoss.view}</b>
                <span className="bc__loss-v">
                  {fmtCount(biggestLoss.n)} journeys end here ({pct(biggestLoss.share)}) ·
                  {" "}at this application&apos;s completion rate that is{" "}
                  <b>≈ {fmtCount(Math.round(biggestLoss.n * completeness.share))}</b>
                  {" "}completions never reached
                </span>
              </div>
            )}

            {/* the busiest sequences, spelled out — the pages in the order people
            actually walk them, completions marked */}
            {ladder && ladder.top.length > 0 && (
              <div className="bc__seqs bc__seqs--cell">
            <span className="bc__seqs-l">the busiest sequences</span>
            {ladder.top.map((q) => (
              <div className={q.done ? "bc__seqs-r bc__seqs-r--done" : "bc__seqs-r"}
                key={q.path.join("\u0001")}
                title={`${fmtN(q.n)} journeys walk exactly this sequence${q.done
                  ? " — and it reaches the completion depth" : ""}`}>
                <b className="num">{fmtCount(q.n)}</b>
                <span className="bc__seqs-p">
                  {q.path.map((v, i) => (
                    <React.Fragment key={i}>
                      {i > 0 && <i aria-hidden="true">→</i>}
                      <span>{v}</span>
                    </React.Fragment>
                  ))}
                </span>
                {q.done && <em>✓ completes</em>}
              </div>
            ))}
            {onGo && (
              <button className="bc__seqs-go" onClick={() => onGo("flow", scopeApp || undefined)}>
                every sequence, on the flow →
              </button>
            )}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* WHAT FAILURE COSTS lived here. It compared the rate at which
          error-free and error-hit sessions reached the goal — and "the goal"
          was the keyword predicate the product no longer uses anywhere else.
          It was the last consumer of that vocabulary.

          Rebasing it onto completeness needs per-session DEPTH and per-session
          ERROR STATE together. The board holds each separately — depth from the
          mined routes, errors from the KPI scan — and joining them means
          fetching the per-session query on every board load, a real scan the
          block does not earn. So it is removed rather than left quietly
          measuring a definition the rest of the product abandoned. The failure
          cost still shows up where it is honest: customers at risk on the
          brand front, and the error lift per segment on the poster. */}

      {/* WHAT DESTOA — ranked by deviation, never by size. */}
      {outliers.list.length > 0 && (
        <section className="bc__front" style={{ ["--fh" as string]: "var(--t-violet, var(--accent))" }}>
          <h2 className="bc__ftitle">What stands out as slow</h2>
          <div className="bc__out">
            {outliers.list.map((v) => (
              <div className="bc__out-r" key={v.view}>
                <span className="bc__out-n">{v.view}</span>
                <b className="num">{fmtMs(v.p50)}</b>
                <i className={v.times >= 2.5 ? "bc__out-x bc__out-x--bad" : "bc__out-x"}>
                  {v.times.toFixed(1)}× the median screen
                </i>
                <em>{fmtN(v.views)} views · {fmtN(v.sessions)} sessions meet it</em>
                <span className="bc__out-bar">
                  <i style={{ width: `${Math.min(100, (v.p50 / (outliers.median * 4)) * 100)}%` }} />
                </span>
              </div>
            ))}
          </div>
          <span className="bc__out-ft">
            ranked by how far each screen sits from this application&apos;s median of{" "}
            {fmtMs(outliers.median)} — times the people who meet it. A screen twice as slow that
            nobody opens is arithmetic, not a finding; every list that ranks by traffic hides these.
          </span>
        </section>
      )}

      {/* where the difficulty lives — inside the backend, or outside it */}
      {/* the section stands on EITHER evidence: mobile screens carry no TTFB
          (measured: 100% null), and hiding the whole section hid the error
          origins and the Davis corroboration exactly where crash/device
          evidence matters most */}
      {where && (where.cur || where.errTotal > 0) && (() => {
        const t = where.cur
          ? trend(where.cur.srv, where.prev?.srv ?? where.cur.srv, false)
          : trend(0, 0, false);
        const ms = (ns: number) => ns >= 1e9 ? `${(ns / 1e9).toFixed(1)}s` : `${Math.round(ns / 1e6)}ms`;
        // what the reader sees is business language; the measurement behind
        // each phrase stays one hover away in the tooltip
        const ERR_LBL: Array<[string, string, string, boolean]> = [
          ["backend", "let down by your service", "server errors (HTTP 5xx)", true],
          ["frontend", "hit a defect in the app", "JavaScript exceptions in your frontend code", false],
          ["policy", "blocked by your own security policy",
            "CSP violations on first-party resources — a configuration fix, not a code fix", true],
          ["third_party", "hit a partner's service", "content-security violations naming the third party", false],
          ["device", "let down by their own phone", "app crashes and freezes (crash / ANR)", false],
          ["connection", "lost their own connection", "requests that never got a response (status 0)", false],
          ["request_4xx", "asked for something unavailable", "HTTP 4xx — missing content or sign-in required", false],
        ];
        return (
          <section className="bc__front" style={{ ["--fh" as string]: "var(--t-violet, var(--accent))" }}>
            <h2 className="bc__ftitle">Where the difficulty lives</h2>
            <div className="bc__diff">
              {where.cur ? (
              <div className="bc__diff-hero">
                <b className="num">{pct(where.cur.srv)}</b>
                <span className="bc__diff-hl">of your customers&apos; waiting is caused by your systems</span>
                <span className="bc__stat-t" style={{ color: TONE[t.dir] }}>
                  {t.arrow} {t.rel === null ? "new" : t.dir === "flat" ? "steady"
                    : `${Math.abs(t.rel * 100).toFixed(0)}%`} vs previous {data.tf.label}
                </span>
                <span className="bc__diff-money">
                  Your systems answer in {ms(where.per(where.d.slow.cur.srv))} — the rest of the
                  wait happens on the customer&apos;s side.
                </span>
              </div>
              ) : (
              <div className="bc__diff-hero">
                <span className="bc__diff-hl">no time decomposition on these screens</span>
                <span className="bc__diff-money">
                  Mobile screens carry no first-byte breakdown — the verdict below
                  reads from the errors alone.
                </span>
              </div>
              )}
              <div className="bc__diff-body">
                {/* time evidence: the split bar (only where it was measured) */}
                {where.cur && (
                <div className="bc__diff-bar" role="img"
                  aria-label={`server ${pct(where.cur.srv)}, network ${pct(where.cur.net)}, download and render ${pct(where.cur.rend)}`}>
                  <i style={{ width: `${where.cur.srv * 100}%`, background: "var(--bad)" }} />
                  <i style={{ width: `${where.cur.net * 100}%`, background: "var(--t-cyan)" }} />
                  <i style={{ width: `${where.cur.rend * 100}%`, background: "var(--warn)" }} />
                </div>
                )}
                {where.cur && (
                <div className="bc__diff-leg">
                  {where.d.slow.cur.views > 0 && (
                    <span className="bc__diff-cov"
                      title="TTFB decomposition exists only on hard navigations — SPA soft routes and mobile screens carry none">
                      measured on {pct(where.d.slow.cur.meas / Math.max(1, where.d.slow.cur.views))} of screens
                    </span>
                  )}
                  <span title="Server processing — time to first byte, waiting portion">
                    <i style={{ background: "var(--bad)" }} />your systems · {ms(where.per(where.d.slow.cur.srv))} per screen</span>
                  <span title="The customer's network — DNS lookup + connection time">
                    <i style={{ background: "var(--t-cyan)" }} />the customer&apos;s internet · {ms(where.per(where.d.slow.cur.net))} per screen</span>
                  <span title="After the first byte: downloading and drawing the screen on the customer's device">
                    <i style={{ background: "var(--warn)" }} />the customer&apos;s device · {ms(where.per(where.d.slow.cur.rend))} per screen</span>
                </div>
                )}
                {/* error evidence: origin chips */}
                <div className="bc__diff-errs">
                  <span className="bc__diff-el">customers who…</span>
                  {ERR_LBL.filter(([b]) => where.errN(b) > 0).map(([b, lbl, tech, inside]) => (
                    <span key={b} className={`bc__diff-e${inside ? " bc__diff-e--in" : ""}`}
                      title={tech}>
                      <b className="num">{fmtCount(where.errN(b))}</b> {lbl}
                    </span>
                  ))}
                </div>
                {/* the two corroborations */}
                <div className="bc__diff-verdict">
                  <span>
                    {where.conc
                      ? <>the pain concentrates on customers using <b>{where.conc.bucket}</b>
                          {" "}({where.conc.lift.toFixed(1)}× the average) — a sign the cause is on
                          {" "}<b>their side</b>, not yours</>
                      : <>the pain touches every kind of customer alike — when it grows, the cause
                          is usually on <b>your side</b></>}
                  </span>
                  <button className="bc__diff-dv" onClick={() => onGo?.("chain", scopeApp)}
                    title="Davis AI's open problems on THIS application's chain — opens the delivery chain, where each one is lit on its component">
                    {where.backendProblems === null
                      ? "AI monitoring · resolving this application's chain… ↗"
                      : where.backendProblems
                        ? `AI monitoring confirms ${fmtN(where.backendProblems)} live incident${where.backendProblems > 1 ? "s" : ""} in this application's chain ↗`
                        : "AI monitoring sees no live incident in this application's chain ↗"}
                  </button>
                </div>
              </div>
            </div>
          </section>
        );
      })()}

      {/* where conversion lives and dies — the segments to personalise for */}
      {segments && (segments.best.length > 0 || segments.worst.length > 0) && (
        <section className="bc__front" style={{ ["--fh" as string]: "var(--t-cyan)" }}>
          <h2 className="bc__ftitle">Where failure concentrates
            {scoped && <em className="bc__ftitle-note"> · whole application</em>}</h2>
          <div className="bc__segs">
            {/* `best` is the HIGHER lift, which under an error metric is the
                worse outcome — the names come from the ranking, the tone from
                what the ranking now means. */}
            {([["meets more errors than average", segments.best, "bad"],
               ["meets fewer errors than average", segments.worst, "good"]] as const)
              .map(([title, rows, tone]) => rows.length > 0 && (
                <div className="bc__seg" key={title}>
                  <h3 className={`bc__seg-h bc__seg-h--${tone}`}>{title}</h3>
                  {rows.map((r) => (
                    <div className="bc__seg-r" key={`${r.d}${r.bucket}`}>
                      <span className="bc__seg-b">{r.bucket}<em>{r.d}</em></span>
                      <b className="num">{pct(r.rate)}</b>
                      <span className="bc__seg-lift" style={{ color: `var(--${tone})` }}>
                        {r.lift >= 1 ? `${r.lift.toFixed(1)}× the errors`
                          : r.rate === 0 ? "no errors at all" : `${(1 / r.lift).toFixed(1)}× fewer`}
                      </span>
                      <em className="bc__seg-n">{fmtCount(r.n)} customers</em>
                    </div>
                  ))}
                </div>
              ))}
          </div>
        </section>
      )}

      {/* WHERE THE CUSTOMERS ARE — the map's verdict, spoken in the board's
          language. Same rows, same three-arm rule (utils/geoVerdict); the
          headline is the worst location or the negative finding, because "no
          region stands out" is also an answer the owner needs stated. */}
      {geoRows && geoRows.length > 0 && (() => {
        const tot = geoRows.reduce((a, g) => a + g.sessions, 0) || 1;
        const base = geoRows.reduce((a, g) => a + g.hit, 0) / tot;
        const judged = geoRows.map((g) => ({ g, tone: geoJudge(g, base) }));
        const hurt = judged.filter((x) => x.tone !== "good")
          .sort((a, b) => (a.tone === b.tone ? b.g.sessions - a.g.sessions
            : a.tone === "bad" ? -1 : 1));
        const lead = hurt[0];
        return (
          <section className="bc__front" style={{ ["--fh" as string]: "var(--t-cyan)" }}>
            <h2 className="bc__ftitle">Where the customers are</h2>
            <div className="bc__seg">
              {/* the heading wears the LEAD'S OWN tone — painting a merely
                  tolerating country red contradicted its row two lines down */}
              <h3 className={`bc__seg-h bc__seg-h--${lead ? lead.tone : "good"}`}>
                {lead
                  ? `${geoName(lead.g.country)} is ${GEO_WORD[lead.tone]} — ${geoBecause(lead.g, base)}`
                  : "no location stands out — every country reads satisfied under the map's own rule"}
              </h3>
              {judged.slice(0, 6).map(({ g, tone }) => (
                <div className="bc__seg-r" key={g.country}
                  title={`${fmtN(g.sessions)} sessions from ${geoName(g.country)} — ${GEO_WORD[tone]}: ${geoBecause(g, base)}`}>
                  <span className="bc__seg-b">{geoName(g.country)}<em>{pct(g.sessions / tot)} of sessions</em></span>
                  <b className="num">{fmtN(g.sessions)}</b>
                  <span className="bc__seg-lift" style={{ color: `var(--${tone})` }}>
                    {GEO_WORD[tone]}
                  </span>
                  <em className="bc__seg-n">
                    {g.hit > 0 ? `${pct(g.hit / Math.max(g.sessions, 1))} met an error` : "no errors"}
                  </em>
                </div>
              ))}
            </div>
          </section>
        );
      })()}
    </div>
  );
}
