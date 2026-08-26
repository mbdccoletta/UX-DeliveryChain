// The route's infographic — a poster over the screen, by request.
//
// The reader picked a route on the Journeys flow and asked for a chart that
// overlays the page and portrays who walks it: not a table to investigate,
// a picture to read. So this is a poster in the app's own card language —
// big numbers, filled blocks, one hue for identity and colour only for
// verdicts — laid over a veil that keeps the flow visible behind it.
//
// Every figure is the cohort's own, beside everyone else's, from one query
// (qRouteInfographic). Where the two differ, the poster says so with the
// lift; where nothing differs it says "same as everyone", which is a finding.
import React, { useEffect } from "react";
import { fmtMs, fmtN } from "../utils/dql";
import { vitalTitle } from "../utils/vitals";
import { geoName } from "../utils/geoVerdict";
import { exportImage } from "../utils/exportImage";

export interface InfoRow {
  dim: string; bucket: string; inCohort: boolean;
  sessions: number; hit: number; fatal: number; p50dur: number; p50views: number;
  /** Real customers in this bucket, and how many of them reached the goal. */
  customers: number; converted: number;
}

/**
 * WHERE CONVERSION LIVES — AND DIES.
 *
 * The bars below say who WALKS this route. They cannot say who SUCCEEDS on
 * it, and those are different questions: a country can be a third of the
 * traffic and half of the failures. So every characteristic is scored by its
 * own conversion against the route's own average — the same figure printed at
 * the top of the poster, never a second average computed here — and the ones
 * that genuinely differ are named.
 *
 * Three guards keep this from inventing findings. A bucket must carry enough
 * real customers to have a rate at all (twenty, or 2% of the route, whichever
 * is larger), and it must miss the average by more than the app's own
 * materiality band (±15%, the threshold every other lift on this poster uses).
 * When nothing clears both, that is stated as the finding it is.
 *
 * The third guard is the one that matters most, and it was measured rather
 * than foreseen: WHERE a session started is not a characteristic of who is
 * walking, and it is often the outcome itself. Ranked naively on easyTravel,
 * the top "finding" was that sessions entering on /orange-booking-finish.jsf
 * convert 100% — true, circular, and worthless, because entering ON the goal
 * IS converting. Entry view stays in the bars below, where it answers "where
 * do they come in"; it is barred from here, where the claim would be causal.
 */
export interface Segment {
  dim: string; bucket: string; conv: number; lift: number; customers: number;
}

export function convSegments(rows: InfoRow[], base: number, cohortCustomers: number) {
  const floor = Math.max(20, Math.round(cohortCustomers * 0.02));
  const scored: Segment[] = rows
    .filter((r) => r.inCohort && r.customers >= floor && r.dim !== "entry view")
    .map((r) => ({ dim: r.dim, bucket: r.bucket, customers: r.customers,
      conv: r.converted / r.customers, lift: base > 0 ? (r.converted / r.customers) / base : 1 }));
  return {
    floor,
    up: scored.filter((x) => x.lift >= 1.15).sort((a, b) => b.conv - a.conv).slice(0, 4),
    down: scored.filter((x) => x.lift <= 0.87).sort((a, b) => a.conv - b.conv).slice(0, 4),
    tested: scored.length,
  };
}

const fmtPct = (v: number) => `${(v * 100).toFixed(v * 100 < 10 ? 1 : 0)}%`;

/**
 * WHAT STANDS OUT — the poster's insight layer.
 *
 * The grid below draws every characteristic the platform records: a dozen
 * blocks, sixty-odd bars, and on a typical route all but four of them read
 * "same as everyone". That is a data dump wearing the clothes of a finding —
 * the reader has to hunt the five rows that differ. So the difference is
 * computed ACROSS every dimension at once and ranked, and the grid becomes
 * the evidence you open, not the thing you scan.
 *
 * Ranked by IMPACT, not by lift: a bucket at 0.3% of the route that is 4×
 * over-represented moves nothing, while one at 30% that is 1.3× over is the
 * story. Impact is the plain share difference — how many more of these users
 * per hundred — which is also the sentence the reader can act on.
 *
 * The absence of a standout is itself reported, because it answers the
 * question the poster exists to answer: if nobody differs, the route is the
 * cause, not the audience.
 */
/**
 * WHERE THEY STOPPED — the screen each session ended on.
 *
 * The poster could say who these users are and how the page loaded for them,
 * and still leave the reader's real question unanswered: they showed intent
 * and did not advance — WHY. The answer starts with the screen they stopped
 * on, and continues with what happened there. Both come free: the last step of
 * a mined journey, joined to that session's own error count.
 */
export interface StopRow {
  view: string;
  /** Sessions in the cohort that ended here, and their share of it. */
  n: number; share: number;
  /** The same screen's share among everyone else — is this route's ending unusual? */
  rest: number;
  /** How many of the sessions that stopped here had met an error. */
  errShare: number;
  /** This screen's own p50 load, and the application's median screen, so the
   *  poster can TEST whether the ending is a performance problem. */
  p50: number; appP50: number;
}

export interface Standout {
  dim: string; bucket: string; share: number; rest: number; lift: number; impact: number;
  /** This group's own error rate, and how it compares to the route's. */
  errRate?: number; errLift?: number;
}

export function standouts(rows: InfoRow[], minShare = 0.02, baseConv = 0, custFloor = 20): {
  list: Standout[]; dims: number; buckets: number;
} {
  const dims = [...new Set(rows.map((r) => r.dim))];
  const list: Standout[] = [];
  let buckets = 0;
  for (const d of dims) {
    /* The entry view is barred here for the same reason it is barred from the
     * conversion segments: when the reader picked a route BY where it starts,
     * reporting that its start is over-represented is circular — the selection
     * caused the finding. Measured on angular.easytravel it printed
     * "/easytravel/journeys/* — entry view 9.2× more" for a cohort chosen by
     * that very entry. */
    if (d === "entry view") continue;
    const r = rows.filter((x) => x.dim === d);
    const inTot = r.filter((x) => x.inCohort).reduce((a, x) => a + x.sessions, 0);
    const outTot = r.filter((x) => !x.inCohort).reduce((a, x) => a + x.sessions, 0);
    if (!inTot) continue;
    for (const b of new Set(r.map((x) => x.bucket))) {
      buckets++;
      const i = r.find((x) => x.bucket === b && x.inCohort)?.sessions ?? 0;
      const o = r.find((x) => x.bucket === b && !x.inCohort)?.sessions ?? 0;
      const share = i / inTot;
      const rest = outTot ? o / outTot : 0;
      if (share < minShare) continue;
      const lift = rest > 0 ? share / rest : share > 0 ? Infinity : 1;
      if (lift >= 1.15 || lift <= 0.87) {
        /* THE CONSEQUENCE, not just the presence. "1920×1080 shows up 1.2×
         * more here" is a demographic note; "…and meets four times the errors"
         * is why the reader should care. The error count per bucket rides on
         * the same rows the shares come from, so the join is free — and it
         * works for any application, which the conversion verdict it replaces
         * did not. */
        void baseConv;
        const cell = r.find((x) => x.bucket === b && x.inCohort);
        const enough = !!cell && cell.sessions >= Math.max(20, custFloor / 2);
        const errRate = enough ? cell!.hit / cell!.sessions : undefined;
        const inAll = r.filter((x) => x.inCohort);
        const inN = inAll.reduce((a, x) => a + x.sessions, 0);
        const baseErr = inN > 0 ? inAll.reduce((a, x) => a + x.hit, 0) / inN : 0;
        const errLift = errRate === undefined || baseErr <= 0 ? undefined : errRate / baseErr;
        list.push({ dim: d, bucket: b, share, rest, lift, impact: Math.abs(share - rest),
          errRate, errLift });
      }
    }
  }
  return { list: list.sort((a, b) => b.impact - a.impact).slice(0, 6), dims: dims.length, buckets };
}

/** Does this dimension say anything about the route at all? */
export function dimDiffers(rows: InfoRow[], dim: string, minShare = 0.02): boolean {
  const r = rows.filter((x) => x.dim === dim);
  const inTot = r.filter((x) => x.inCohort).reduce((a, x) => a + x.sessions, 0);
  const outTot = r.filter((x) => !x.inCohort).reduce((a, x) => a + x.sessions, 0);
  if (!inTot) return false;
  return [...new Set(r.map((x) => x.bucket))].some((b) => {
    const i = (r.find((x) => x.bucket === b && x.inCohort)?.sessions ?? 0) / inTot;
    const o = outTot ? (r.find((x) => x.bucket === b && !x.inCohort)?.sessions ?? 0) / outTot : 0;
    if (i < minShare) return false;
    const l = o > 0 ? i / o : i > 0 ? Infinity : 1;
    return l >= 1.15 || l <= 0.87;
  });
}

/** The most-over-represented buckets of one dimension, cohort share vs rest. */
function topBuckets(rows: InfoRow[], dim: string, n = 5) {
  const r = rows.filter((x) => x.dim === dim);
  const inTot = r.filter((x) => x.inCohort).reduce((a, x) => a + x.sessions, 0) || 1;
  const outTot = r.filter((x) => !x.inCohort).reduce((a, x) => a + x.sessions, 0) || 1;
  const buckets = [...new Set(r.map((x) => x.bucket))].map((b) => {
    const i = r.find((x) => x.bucket === b && x.inCohort)?.sessions ?? 0;
    const o = r.find((x) => x.bucket === b && !x.inCohort)?.sessions ?? 0;
    return { b, i, si: i / inTot, so: o / outTot };
  }).filter((x) => x.i > 0).sort((a, b) => b.si - a.si).slice(0, n);
  return { buckets, inTot, outTot };
}

/** A rate over both sides, from any one dimension's rows. */
function rate(rows: InfoRow[], k: "hit" | "fatal", inCohort: boolean) {
  const dim = rows[0]?.dim;
  const r = rows.filter((x) => x.dim === dim && x.inCohort === inCohort);
  const n = r.reduce((a, x) => a + x.sessions, 0);
  return n ? r.reduce((a, x) => a + x[k], 0) / n : 0;
}
function median(rows: InfoRow[], k: "p50dur" | "p50views", inCohort: boolean) {
  const dim = rows[0]?.dim;
  const r = rows.filter((x) => x.dim === dim && x.inCohort === inCohort);
  const n = r.reduce((a, x) => a + x.sessions, 0);
  return n ? r.reduce((a, x) => a + x[k] * x.sessions, 0) / n : 0;
}


export function RouteInfographic({ rows, path, appName, cohort, total, biz, vitals,
  convDef, savedJourneys, onAddJourney, stops, approx, onClose }: {
  rows: InfoRow[] | "loading";
  /** The picked waypoints, in order, in words. */
  path: string[];
  appName: string;
  cohort: number; total: number;
  /** WHAT THE ROUTE IS WORTH — the cohort's business line: real customers,
   *  their conversion beside everyone else's, and the error-touched. */
  biz?: { customers: number; converted: number; conv: number;
    restConv: number; hit: number } | null;
  /** Business Control's value-of-one-conversion, shared via url state. */
  /** HOW THIS ROUTE LOADS — the technical vitals of the cohort beside
   *  everyone else's, p75 over each session's worst measured load. Null when
   *  the platform timed none of these sessions (a route made only of soft
   *  navigations carries no first byte and no paint). */
  vitals?: null | { n: number; rest: number; lcp: number; lcpRest: number;
    ttfb: number; ttfbRest: number; fcp: number; fcpRest: number };
  /** WHAT COUNTS AS A CONVERSION here — the taught definition when the customer
   *  set one, the app's own vocabulary otherwise. The poster printed "17%
   *  conversion" without ever saying 17% of WHAT; a rate whose rule is invisible
   *  is a number nobody can check. */
  convDef?: { taught: boolean; unreadable?: boolean; items: string[] } | null;
  /** The journeys defined for this application — the same list the board
   *  shows, so a reader checking a conversion figure on the poster does not
   *  have to leave it to learn what conversion means here. */
  savedJourneys?: string[][];
  onAddJourney?: () => void;
  /** The screens this cohort ended on, busiest first. */
  stops?: StopRow[] | null;
  /** Figures were scaled from capped samples — worn as ≈ and said in the foot. */
  approx?: boolean;
  onClose: () => void;
}) {
  /* The characteristics that say nothing start folded. Sixty bars of "same as
   * everyone" is not evidence the reader is reading — it is evidence they are
   * scrolling past. They stay one click away, never deleted. */
  const [exporting, setExporting] = React.useState(false);
  const [showFlat, setShowFlat] = React.useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /** No waypoints picked: the poster describes the whole flow, and says so. */
  const whole = path.length === 1
    && (path[0] === "every journey on screen" || path[0] === "customers who left unconverted");
  const dims = rows === "loading" ? [] : [...new Set(rows.map((r) => r.dim))];
  const lift = (a: number, b: number) => (b > 0 ? a / b : a > 0 ? Infinity : 1);
  const liftWord = (l: number) =>
    l === Infinity ? "only on this route" : l >= 1.15 ? `${l.toFixed(1)}× more`
    : l <= 0.87 ? `${(1 / l).toFixed(1)}× less` : "same as everyone";

  return (
    <div className="ovl" onClick={onClose} role="dialog" aria-modal="true"
      aria-label={`Who takes this route through ${appName}`}>
      <div className="rinfo" onClick={(e) => e.stopPropagation()}>
        <header className="rinfo__hd">
          <span className="rinfo__eyebrow">
            {path.length === 1 && path[0] === "every journey on screen"
              ? "WHO THESE USERS ARE" : "WHO TAKES THIS ROUTE"} · {appName}</span>
          {/* The title NAMES the subject; the panel beside it spells the routes
              out in full. Printing the whole path here as well turned a heading
              into fifteen lines of 22px type in a narrow column — the same
              information twice, once unreadably. */}
          {/* NOT A COUNT OF JOURNEYS. The picks are a route AND its qualifiers
              — a stage, or the waypoints that build one path — so counting
              them said "2 journeys on screen" for a single journey narrowed by
              a stage. The title names the route; the band below carries the
              rest of the selection. */}
          <h2 className="rinfo__path">
            {(() => {
              const head = whole ? path[0] : path[0] ?? "";
              const cut = head.length > 46 ? head.slice(0, 45) + "…" : head;
              return whole ? head : path.length > 1 ? `${cut} · narrowed` : cut;
            })()}
          </h2>
          {/* THE MINI FLOW — what is being evaluated, drawn rather than read.
              The title states the route in words; a reader landing on a poster
              full of percentages still had to parse a string of arrows to know
              WHICH sessions those percentages describe. Here it is as a shape:
              one step per waypoint, in order. With nothing picked, the shape
              says so — every entry, every path, every outcome, nothing
              filtered — because "the whole flow" is also an answer. */}
          {/* THE JOURNEYS THIS POSTER IS ABOUT. Nothing picked means nothing
              to draw: three pills reading "every entry / every path / every
              outcome" claimed to be a diagram while saying only that no
              filter was on — the header already says that in words. With
              journeys picked, each one is listed, in full, numbered. */}
          {!whole && (
            <div className="rinfo__mini" role="group"
              aria-label={`Analysing ${path.length} journey${path.length === 1 ? "" : "s"}: ${path.join("; ")}`}>
              <span className="rinfo__mini-l">
                {/* Not "2 journeys": what is picked is ONE cohort described in
                    steps — a path and how far it got, or waypoints in order.
                    Numbering them without joining them read as a list of
                    separate things, which is why the sequence needed saying. */}
                analysing {path.length === 1 ? "this journey" : "this journey, narrowed"}
              </span>
              {path.map((p, i) => (
                <span className="rinfo__mini-r" key={i}>
                  {path.length > 1 && <b>{i + 1}</b>}
                  <span className="rinfo__mini-n" title={p}>{p}</span>
                  {i < path.length - 1 && (
                    <i className="rinfo__mini-seq" aria-hidden="true">→</i>
                  )}
                </span>
              ))}
              <em className="rinfo__mini-c">
                {path.length === 1 ? "every figure below is measured on this journey"
                  : "every figure below is measured on this selection"}
              </em>
            </div>
          )}
          <div className="rinfo__cohort">
            <b className="num">{approx ? "≈ " : ""}{fmtN(cohort)}</b>
            <span>{cohort >= total ? "sessions — the whole flow"
              : `sessions on this route · ${total ? fmtPct(cohort / total) : "—"} of ${fmtN(total)}`}</span>
          </div>
          {/* the poster is MADE for pasting into decks and tickets — export
              the whole of it at 2×, chrome (this button, the ✕) excluded */}
          <button className="drawer__x noexport" disabled={exporting}
            style={{ marginLeft: 0 }}
            title="Download this poster as a PNG (2×)"
            onClick={async () => {
              const el = document.querySelector(".rinfo") as HTMLElement | null;
              if (!el) return;
              setExporting(true);
              try { await exportImage(el, "journey-poster"); }
              finally { setExporting(false); }
            }}>
            {exporting ? "…" : "⬇"}
          </button>
          <button className="drawer__x" onClick={onClose} aria-label="Close">✕</button>
        </header>

        {rows === "loading" ? (
          <div className="rinfo__loading">drawing the route&apos;s portrait…</div>
        ) : (
          <>
            {/* what the route is worth — the business line first: conversion
                beside everyone else's, and with the ticket set, the money the
                route carries and the money error-touched customers put at risk */}
            {biz && biz.customers > 0 && (
              <section className="rinfo__worth">
                <span className="rinfo__worth-l">WHAT THIS ROUTE IS WORTH</span>
                <div className="rinfo__worth-row">
                  <div className="rinfo__kpi rinfo__kpi--worth">
                    <b className="num">{fmtN(biz.customers)}</b>
                    <span className="rinfo__kpi-l">customers</span>
                    <em>{fmtN(biz.converted)} reached the goal</em>
                  </div>
                  <div className={`rinfo__kpi rinfo__kpi--worth${biz.hit > 0 ? " rinfo__kpi--bad" : ""}`}>
                    <b className="num">{fmtN(biz.hit)}</b>
                    <span className="rinfo__kpi-l">met an error</span>
                    <em>{biz.hit > 0 ? "customers whose session hit a failure" : "a clean route"}</em>
                  </div>
                </div>
              </section>
            )}

            {/* the outcome strip: what happens to these users vs everyone else */}
            <section className="rinfo__strip">
              {([
                ["hit by errors", rate(rows, "hit", true), rate(rows, "hit", false), fmtPct, true],
                ["crash / ANR", rate(rows, "fatal", true), rate(rows, "fatal", false), fmtPct, true],
                ["median session", median(rows, "p50dur", true), median(rows, "p50dur", false), fmtMs, false],
                ["median views", median(rows, "p50views", true), median(rows, "p50views", false),
                  (v: number) => v.toFixed(1), false],
              ] as Array<[string, number, number, (v: number) => string, boolean]>)
                .map(([label, a, b, f, isRate]) => {
                  const l = lift(a, b);
                  const bad = isRate && l >= 1.15 && a > 0;
                  const good = isRate && l <= 0.87;
                  return (
                    <div className={`rinfo__kpi${bad ? " rinfo__kpi--bad" : good ? " rinfo__kpi--good" : ""}`}
                      key={label}>
                      <b className="num">{f(a)}</b>
                      <span className="rinfo__kpi-l">{label}</span>
                      <em>{isRate ? liftWord(l) : `everyone: ${f(b)}`}</em>
                    </div>
                  );
                })}
            </section>

            {/* WHERE THEY ARE. The route walked from a map: which countries
                carry it, and — the finding, stated either way — whether one
                of them concentrates the failures. Country is safe from the
                entry-view circularity: no route is picked BY where its users
                live. */}
            {(() => {
              const geo = rows.filter((r) => r.dim === "country" && r.inCohort && r.bucket);
              const tot = geo.reduce((a, r) => a + r.sessions, 0);
              if (!tot) return null;
              const outRows = rows.filter((r) => r.dim === "country" && !r.inCohort);
              const outTot = outRows.reduce((a, r) => a + r.sessions, 0);
              const baseErr = geo.reduce((a, r) => a + r.hit, 0) / tot;
              const top = [...geo].sort((a, b) => b.sessions - a.sessions).slice(0, 4);
              /* substance before speech, the map's own floors: ≥20 sessions
                 and ≥5 errored before a country may be named the carrier */
              const carrier = geo.filter((r) => r.sessions >= 20 && r.hit >= 5
                && baseErr > 0 && r.hit / r.sessions >= baseErr * 2)
                .sort((a, b) => b.hit - a.hit)[0];
              return (
                <section className="rinfo__geo">
                  <span className="rinfo__geo-l">Where they are</span>
                  <p className={`rinfo__geo-v${carrier ? " rinfo__geo-v--bad" : ""}`}>
                    {carrier ? (<>
                      the route&apos;s failures concentrate in <b>{geoName(carrier.bucket)}</b> —{" "}
                      {fmtPct(carrier.hit / carrier.sessions)} of its sessions met an error,
                      against {fmtPct(baseErr)} for the route as a whole
                    </>) : baseErr > 0
                      ? <>failures spread evenly across countries — the route carries them, not a region</>
                      : <>a clean route in every country it is walked from</>}
                  </p>
                  <div className="rinfo__geo-rows">
                    {top.map((r) => {
                      const share = r.sessions / tot;
                      const restShare = outTot
                        ? (outRows.find((x) => x.bucket === r.bucket)?.sessions ?? 0) / outTot : 0;
                      const l = restShare > 0 ? share / restShare : share > 0 ? Infinity : 1;
                      const er = r.sessions ? r.hit / r.sessions : 0;
                      const hot = baseErr > 0 && r.hit >= 5 && er >= baseErr * 2;
                      return (
                        <div className="rinfo__geo-r" key={r.bucket}
                          title={`${fmtN(r.sessions)} of these sessions come from ${geoName(r.bucket)} — ${fmtPct(share)} of the cohort${outTot ? ` against ${fmtPct(restShare)} of everyone else` : ""}.${r.hit > 0 ? ` ${fmtN(r.hit)} met an error (${fmtPct(er)}).` : " None met an error."}`}>
                          <span className="rinfo__geo-c">{geoName(r.bucket)}</span>
                          <b className="num">{fmtPct(share)}</b>
                          <i className={l >= 1.15 && outTot > 0 ? "rinfo__geo-x rinfo__geo-x--odd" : "rinfo__geo-x"}>
                            {outTot === 0 ? ""
                              : l === Infinity ? "only on this route"
                              : l >= 1.15 ? `${l.toFixed(1)}× more than everyone else`
                              : l <= 0.87 ? `${(1 / l).toFixed(1)}× less` : "as common elsewhere"}
                          </i>
                          <em className={hot ? "rinfo__geo-e rinfo__geo-e--bad" : "rinfo__geo-e"}>
                            {r.hit > 0 ? `${fmtPct(er)} met an error` : "no errors"}
                          </em>
                        </div>
                      );
                    })}
                  </div>
                </section>
              );
            })()}

            {/* WHERE THEY STOPPED. First question after "who are they": on which
                screen did this end, and was anything wrong there. The lift says
                whether the ending is peculiar to this cohort; the error share
                says whether the screen misbehaved for the people who stopped. */}
            {stops && stops.length > 0 && (
              <section className="rinfo__stop">
                <span className="rinfo__stop-l">Where they stopped</span>
                <div className="rinfo__stop-rows">
                  {/* With the whole flow on screen there IS no "everyone else",
                      and reading that absence as exclusivity printed "only
                      here" against every row — a comparison claimed where none
                      was possible. When no rest exists, the column stays
                      quiet. */}
                  {stops.map((s) => {
                    const comparable = stops.some((x) => x.rest > 0);
                    const l = s.rest > 0 ? s.share / s.rest : s.share > 0 ? Infinity : 1;
                    const odd = l >= 1.15;
                    const hurt = s.errShare >= 0.15;
                    return (
                      <div className="rinfo__stop-r" key={s.view}
                        title={`${fmtN(s.n)} of these sessions ended on ${s.view} — `
                          + `${fmtPct(s.share)} of the cohort against ${fmtPct(s.rest)} of everyone else.`
                          + (s.errShare > 0
                            ? `\n\n${fmtPct(s.errShare)} of them had met an error by then.`
                            : "\n\nNone of them had met an error.")}>
                        <span className="rinfo__stop-v">{s.view}</span>
                        <b className="num">{fmtPct(s.share)}</b>
                        <i className={comparable && odd ? "rinfo__stop-x rinfo__stop-x--odd" : "rinfo__stop-x"}>
                          {!comparable ? ""
                            : l === Infinity ? "only here"
                            : odd ? `${l.toFixed(1)}× more than the rest`
                            : l <= 0.87 ? `${(1 / l).toFixed(1)}× less` : "as common elsewhere"}
                        </i>
                        <em className={hurt ? "rinfo__stop-e rinfo__stop-e--bad" : "rinfo__stop-e"}>
                          {s.errShare > 0 ? `${fmtPct(s.errShare)} met an error` : "no errors"}
                        </em>
                      </div>
                    );
                  })}
                </div>
                {/* THE VERDICT. The poster showed endings and timings in two
                    separate blocks and never joined them, so a reader could
                    only assume the first was caused by the second. Now it is
                    TESTED: the screens people actually stop on are weighed
                    against the application's median screen, and the answer is
                    stated either way — because "these are not slow screens"
                    is the finding that stops a team optimising the wrong
                    thing. Errors are tested the same way. */}
                {(() => {
                  const rated = stops.filter((x) => x.p50 > 0 && x.appP50 > 0);
                  if (!rated.length) return null;
                  const worst = [...rated].sort((a, b) => b.p50 - a.p50)[0];
                  const slow = rated.filter((x) => x.p50 >= x.appP50 * 1.5);
                  const slowShare = slow.reduce((a, x) => a + x.share, 0);
                  const errShare = stops.filter((x) => x.errShare >= 0.02)
                    .reduce((a, x) => a + x.share, 0);
                  const technical = slowShare >= 0.25 || errShare >= 0.25;
                  return (
                    <div className={`rinfo__stopv${technical ? " rinfo__stopv--tech" : ""}`}>
                      <b>{technical
                        ? "This looks technical."
                        : "This is not a speed problem."}</b>{" "}
                      {technical
                        ? `${fmtPct(Math.max(slowShare, errShare))} of the sessions end on screens that are `
                          + `${slowShare >= errShare ? "slower than the rest of the application"
                            : "carrying errors"} — fix the screen and the ending may go with it.`
                        : `The screens people stop on run ${fmtMs(worst.p50)} at worst, against `
                          + `${fmtMs(worst.appP50)} for the median screen here. They leave because of what `
                          + "the page ASKS of them, not how fast it arrives — look at the content and the "
                          + "next step, not at performance."}
                    </div>
                  );
                })()}
                <span className="rinfo__stop-ft">
                  the last screen of each session
                  {stops.some((x) => x.rest > 0)
                    ? " · a screen that is both over-represented here AND carrying errors is where to look first"
                    : " · narrow the flow to a route to see which of these endings are peculiar to it"}
                </span>
              </section>
            )}

            {/* WHAT STANDS OUT — the findings, ranked across every characteristic
                at once, before any bar is drawn. Ranked by how much of the
                route each one covers, not by the size of the lift: a 4× on 0.3%
                of the traffic is arithmetic, not a finding. */}
            {(() => {
              const so = standouts(rows, 0.02, biz?.conv ?? 0,
                Math.max(20, Math.round((biz?.customers ?? 0) * 0.02)));
              return (
                <section className="rinfo__so">
                  <span className="rinfo__so-l">WHAT STANDS OUT</span>
                  {so.list.length ? (
                    <div className="rinfo__so-rows">
                      {so.list.map((x) => {
                        const up = x.lift >= 1.15;
                        return (
                          <div className={`rinfo__so-r${up ? " rinfo__so-r--up" : " rinfo__so-r--dn"}`}
                            key={`${x.dim}/${x.bucket}`}
                            title={`${fmtPct(x.share)} of this route's sessions against `
                              + `${fmtPct(x.rest)} of everyone else's.`}>
                            <b>{x.bucket}</b>
                            <span className="rinfo__so-d">{x.dim}</span>
                            {/* Infinity is not a multiplier a reader can use:
                                a bucket absent from the rest is "only here",
                                and one absent from the cohort is "gone here". */}
                            <i>{!Number.isFinite(x.lift) ? "only on this route"
                              : x.lift === 0 ? "absent here"
                              : up ? `${x.lift.toFixed(1)}× more` : `${(1 / x.lift).toFixed(1)}× less`}</i>
                            <em>{fmtPct(x.share)} here <u>vs</u> {fmtPct(x.rest)} elsewhere</em>
                            {x.errLift !== undefined && (x.errLift >= 1.5 || x.errLift <= 0.5) && (
                              <span className={x.errLift >= 1.5 ? "rinfo__so-e rinfo__so-e--bad" : "rinfo__so-e"}>
                                {x.errLift >= 1.5
                                  ? (Number.isFinite(x.errLift)
                                      ? `and meets ${x.errLift.toFixed(1)}× the errors — ${fmtPct(x.errRate ?? 0)} of them hit one`
                                      : `and is the only group here meeting errors — ${fmtPct(x.errRate ?? 0)} of them hit one`)
                                  : (x.errLift === 0
                                      ? "and meets none of the errors"
                                      : `and meets ${(1 / x.errLift).toFixed(1)}× fewer errors`)}
                              </span>
                            )}

                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="rinfo__so-none">
                      <b>Nobody stands out.</b> Across {so.dims} characteristics and{" "}
                      {so.buckets} groups, these users look like everyone else — so what
                      happens on this route is the ROUTE, not who walks it. Fix the path,
                      not the audience.
                    </div>
                  )}
                </section>
              );
            })()}

            {/* HOW IT LOADS — the same cohort-vs-rest grammar, in the
                engineer's units. The reader asked for the technical reading
                here, where the filters already scope everything; the panels
                on the chain and the flow describe the whole application,
                this describes the route on screen. p75 is the Web Vitals
                standard's own percentile, applied to each session's worst
                measured load; sessions the platform never timed are left out
                rather than counted as zero. */}
            {vitals && vitals.n > 0 && (
              <section className="rinfo__worth rinfo__vit">
                <span className="rinfo__worth-l">HOW THIS ROUTE LOADS</span>
                <div className="rinfo__worth-row">
                  {([["LCP", vitals.lcp, vitals.lcpRest],
                     ["TTFB", vitals.ttfb, vitals.ttfbRest],
                     ["FCP", vitals.fcp, vitals.fcpRest]] as const)
                    .filter(([, v]) => v > 0)
                    .map(([k, v, r]) => {
                      const l = r > 0 ? v / r : 1;
                      const worse = l >= 1.15, better = l <= 0.87;
                      return (
                        <div className={`rinfo__kpi rinfo__kpi--worth${worse ? " rinfo__kpi--bad" : better ? " rinfo__kpi--good" : ""}`}
                          key={k}
                          title={`${vitalTitle(k)}\n\nOver ${fmtN(vitals.n)} timed sessions on this route.`}>
                          <b className="num">{v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v)}ms`}</b>
                          <span className="rinfo__kpi-l">{k} p75</span>
                          <em>{r <= 0 ? "no comparison"
                            : worse ? `${l.toFixed(1)}× slower than the rest`
                            : better ? `${(1 / l).toFixed(1)}× faster than the rest`
                            : "same as everyone"}</em>
                        </div>
                      );
                    })}
                  <div className="rinfo__kpi rinfo__kpi--worth">
                    <b className="num">{fmtN(vitals.n)}</b>
                    <span className="rinfo__kpi-l">timed sessions</span>
                    <em>{vitals.rest > 0 ? `${fmtN(vitals.rest)} elsewhere` : "the only ones timed"}</em>
                  </div>
                </div>
              </section>
            )}

            {/* the portrait blocks: one per dimension, filled bars — cohort share
                solid, everyone else as a ghost behind it, so the eye reads the
                over-representation as the solid bar outrunning its shadow */}
            <section className="rinfo__grid">
              {/* every characteristic the application records, in the platform's
                  own order; one it does not record has no rows and is not drawn.
                  A dimension with a single bucket on both sides says nothing
                  about THIS route — it is stated once, compactly, not as a bar.
                  Characteristics that differ come first and alone; the ones that
                  match everyone else fold away behind their own count. */}
              {(() => {
                const ordered = dims.filter((d) => d !== "entry view")
                  .concat(dims.includes("entry view") ? ["entry view"] : []);
                /* THE WHOLE PORTRAIT IS EVIDENCE, NOT THE ANSWER. Even the
                 * dimensions that carry a difference spend four of their five
                 * rows saying "same as everyone" — the reader asked not to be
                 * shown data that answers nothing. The findings live above, in
                 * words; every bar is one click away, and none is deleted. */
                return (<>
                {(showFlat ? ordered : []).map((d) => {
                  const { buckets } = topBuckets(rows, d);
                  if (!buckets.length) return null;
                  const max = Math.max(...buckets.map((x) => Math.max(x.si, x.so)), 0.01);
                  const uniform = buckets.length === 1 && buckets[0].si >= 0.99 && buckets[0].so >= 0.99;
                  if (uniform) {
                    return (
                      <div className="rinfo__blk rinfo__blk--flat" key={d}>
                        <h3>{d}</h3>
                        <span className="rinfo__flat">{buckets[0].b}<em> · everyone</em></span>
                      </div>
                    );
                  }
                  return (
                    <div className="rinfo__blk" key={d}>
                      <h3>{d === "entry view" ? "where they enter" : d}</h3>
                      {buckets.map((x) => {
                        const l = lift(x.si, x.so);
                        return (
                          <div className="rinfo__bar" key={x.b} title={`${fmtN(x.i)} sessions on the route`}>
                            <span className="rinfo__bar-l">{x.b}</span>
                            <span className="rinfo__bar-t">
                              <i className="rinfo__bar-ghost" style={{ width: `${(x.so / max) * 100}%` }} />
                              <i className={`rinfo__bar-fill${l >= 1.15 ? " rinfo__bar-fill--up" : ""}`}
                                style={{ width: `${(x.si / max) * 100}%` }} />
                            </span>
                            <b className="rinfo__bar-v">{fmtPct(x.si)}</b>
                            <em className="rinfo__bar-d">{liftWord(l)}</em>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
                {ordered.length > 0 && (
                  <button className="rinfo__fold" onClick={() => setShowFlat((v) => !v)}>
                    {showFlat
                      ? "hide the full portrait"
                      : `see the evidence — all ${ordered.length} characteristics, bar by bar ↗`}
                  </button>
                )}
                </>);
              })()}
            </section>
            <footer className="rinfo__ft">
              solid bar = share of the route&apos;s sessions · ghost bar = share of everyone else
              · lift compares the two
              {approx && <> · counts scaled from a capped sample (rates are the sample&apos;s own)</>}
              {" "}· click outside or press Esc to close
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
