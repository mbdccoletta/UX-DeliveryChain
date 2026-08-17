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
import React, { useState } from "react";
import type { ChainData } from "../hooks/useChainData";
import { useBizKpis, type BizPeriod } from "../hooks/useBizKpis";
import { useBizForecast } from "../hooks/useBizForecast";
import { useBizBreakdown } from "../hooks/useBizBreakdown";
import { useDifficulty } from "../hooks/useDifficulty";
import { useAppScope } from "../hooks/useAppScope";
import { fmtN } from "../utils/dql";

type Dir = "good" | "bad" | "flat";
const pct = (v: number) => `${(v * 100).toFixed(v * 100 < 10 ? 1 : 0)}%`;
const money = (v: number, sym: string) =>
  v >= 1e6 ? `${sym}${(v / 1e6).toFixed(1)}M`
  : v >= 1e3 ? `${sym}${(v / 1e3).toFixed(0)}k`
  : `${sym}${Math.round(v)}`;

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

export function ReportView({ data, scopeApp, ticket, sym, onTicket, onGo }: {
  data: ChainData;
  /** The application this board reads — the header's own selector drives it,
   *  the same element every page uses. */
  scopeApp: string;
  /** The value of one conversion and its currency — URL state, shared with
   *  the Journeys route economics, so both pages read the same money. */
  ticket: string; sym: string;
  onTicket: (ticket: string, sym: string) => void;
  onGo?: (tab: "chain" | "flow" | "home", appId?: string, hl?: string) => void;
}) {
  // the share of traffic Dynatrace monitors, per the reader; volumes are
  // extrapolated by 100/cov, rates never are
  const [cov, setCov] = useState<string>("");
  const kpis = useBizKpis(data.tf);
  const fc = useBizForecast(data.tf, scopeApp || null);
  const breakdown = useBizBreakdown(data.tf);
  const difficulty = useDifficulty(data.tf);
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
  const tv = Number(ticket) > 0 ? Number(ticket) : null;
  const covN = Number(cov);
  const factor = covN >= 1 && covN < 100 ? 100 / covN : 1;
  const ex = factor > 1;
  const sc = (v: number) => v * factor;
  const fmtCount = (v: number) => `${ex ? "≈ " : ""}${fmtN(Math.round(sc(v)))}`;
  const fmtMoney = (v: number) => `${ex ? "≈ " : ""}${money(sc(v), sym)}`;

  const f = (s?: BizPeriod) => {
    const real = s?.realSessions ?? 0;
    const convR = s?.convertedReal ?? 0;
    return {
      customersAtRisk: s?.hitReal ?? 0,
      crashed: s?.fatalSessions ?? 0,
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
  // scope: one application's own two periods, or the estate's
  const scoped = scopeApp ? kpis?.byApp.get(scopeApp) : undefined;
  const curP = scopeApp ? scoped?.cur : kpis?.estate.cur;
  const prevP = scopeApp ? scoped?.prev : kpis?.estate.prev;
  const c = f(curP), p = f(prevP);

  const Hero = ({ front }: { front: "brand" | "journeys" }) => {
    if (!kpis) return <div className="bc__hero bc__hero--load" />;
    const isBrand = front === "brand";
    const heroVal = isBrand
      ? (tv ? c.customersAtRisk * c.conversion * tv : c.customersAtRisk)
      : (tv ? c.converted * tv : c.conversion);
    const prevVal = isBrand
      ? (tv ? p.customersAtRisk * p.conversion * tv : p.customersAtRisk)
      : (tv ? p.converted * tv : p.conversion);
    const t = trend(heroVal, prevVal, !isBrand);
    const label = isBrand ? (tv ? "revenue at risk" : "customers at risk")
      : (tv ? "revenue captured" : "conversion rate");
    const fmt = isBrand
      ? (tv ? fmtMoney : fmtCount)
      : (tv ? fmtMoney : pct);
    const sub = isBrand
      ? `${fmtCount(c.customersAtRisk)} customers met a failure · ${pct(1 - c.reputationIndex)} of the base`
      : `${fmtCount(c.converted)} of ${fmtCount(c.customers)} customers reached the goal`;
    return (
      <div className="bc__hero" style={{ ["--ht" as string]: TONE[t.dir] }}>
        <span className="bc__hero-l">{label}</span>
        <b className="bc__hero-v num">{fmt(heroVal)}</b>
        <span className="bc__hero-t" style={{ color: TONE[t.dir] }}>
          {t.arrow} {t.rel === null ? "new" : t.dir === "flat" ? "steady" : `${Math.abs(t.rel * 100).toFixed(0)}%`}
          <em> vs previous {data.tf.label}</em>
        </span>
        <span className="bc__hero-s">{sub}</span>
      </div>
    );
  };

  const Stat = ({ label, cur: cv, prev: pv, fmt, riseIsGood, tab, coh, caption, share, liveOnly }: {
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
  }) => {
    if (!kpis) return <div className="bc__stat bc__stat--load" />;
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
  const errCost = (() => {
    if (!scopedRows) return null;
    const leg = scopedRows.filter((r) => r.d === "__err");
    const agg = (b: string) => leg.filter((r) => r.bucket === b)
      .reduce((a, r) => ({ n: a.n + r.realN, c: a.c + r.realConv }), { n: 0, c: 0 });
    const clean = agg("clean"), hit = agg("hit");
    if (!clean.n || !hit.n) return null;
    const rClean = clean.c / clean.n, rHit = hit.c / hit.n;
    return { rClean, rHit, hitN: hit.n,
      lost: Math.max(0, Math.round(hit.n * (rClean - rHit))) };
  })();

  // ── segments: buckets ranked by conversion lift vs the scope's own rate.
  //    Human sessions only, and only buckets big enough to mean something.
  const segments = (() => {
    if (!scopedRows) return null;
    const base = c.customers ? c.converted / c.customers : 0;
    if (!base) return { best: [], worst: [] };
    const byBucket = new Map<string, { d: string; bucket: string; n: number; conv: number }>();
    for (const r of scopedRows) {
      if (r.d === "__err" || r.d === "user type") continue;
      const k = `${r.d} ${r.bucket}`;
      const a = byBucket.get(k) ?? { d: r.d, bucket: r.bucket, n: 0, conv: 0 };
      a.n += r.realN; a.conv += r.realConv; byBucket.set(k, a);
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
    <div className="stack bc">
      <div className="bc__bar">
        <span className="lbl">Business Control</span>
        <span className="hint">{data.tf.label} vs the {data.tf.label} before ·{" "}
          {ex ? <b className="bc__ex-note">volumes ×{factor.toFixed(1)} — extrapolated from {covN}% monitored; rates as measured</b>
            : "measured, not estimated"}</span>
        <div className="spacer" />
        <label className="bc__ticket bc__cov"
          title="Share of your traffic Dynatrace monitors. Below 100, every volume on the board is extrapolated to the whole (marked with an approx sign); rates stay as measured — a representative sample carries them unchanged.">
          <input inputMode="numeric" placeholder="100"
            value={cov} onChange={(e) => setCov(e.target.value.replace(/[^\d]/g, "").slice(0, 3))} />
          <span>% monitored</span>
        </label>
        <label className="bc__ticket" title="Value of one conversion — turns customers into revenue. Blank = customers only.">
          <span>{sym}</span>
          <input inputMode="decimal" placeholder="value / conversion"
            value={ticket} onChange={(e) => onTicket(e.target.value.replace(/[^\d.]/g, ""), sym)} />
          <select value={sym} onChange={(e) => onTicket(ticket, e.target.value)} aria-label="currency">
            {["$", "€", "£", "R$"].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
      </div>

      {/* Davis's projection of the NEXT window — labeled as forecast, never
          mixed with the measured figures above it */}
      <div className="bc__fc" role="note">
        <span className="bc__fc-l">next {data.tf.label.replace(/^last /i, "")} · Davis forecast</span>
        {!fc ? <span className="bc__fc-wait">projecting…</span> : (
          <>
            {fc.conversions && (
              <span className="bc__fc-item">
                <b className="num">{tv ? `≈ ${money(sc(fc.conversions.point) * tv, sym)}`
                  : `≈ ${fmtN(Math.round(sc(fc.conversions.point)))}`}</b>
                {tv ? " revenue expected" : " conversions expected"}
                <em>({tv ? `≈ ${money(sc(Math.max(0, fc.conversions.lower)) * tv, sym)}–${money(sc(fc.conversions.upper) * tv, sym)}`
                  : range(fc.conversions)})</em>
              </span>
            )}
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
              fmt={fmtCount} riseIsGood={false} tab="home"
              caption={`${pct(c.customers ? c.customersAtRisk / c.customers : 0)} of the customer base`}
              share={c.customers ? c.customersAtRisk / c.customers : 0} />
            <Stat label="sessions lost to a crash or freeze" cur={c.crashed} prev={p.crashed}
              fmt={fmtCount} riseIsGood={false} tab="home"
              caption="crashes and ANRs — ended with no way back" />
            <Stat label="brand health (0–100)" cur={c.reputationIndex} prev={p.reputationIndex}
              fmt={(v) => `${Math.round(v * 100)}`} riseIsGood={true} tab="chain"
              caption="share of customers untouched by any failure"
              share={c.reputationIndex} />
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
        <div className="bc__row">
          <Hero front="journeys" />
          <div className="bc__stats">
            <Stat label="customers who converted" cur={c.converted} prev={p.converted}
              fmt={fmtCount} riseIsGood={true} tab="flow"
              caption={`${pct(c.conversion)} of the customer base reached the goal`}
              share={c.conversion} />
            <Stat label="customers who left unconverted"
              cur={c.customers - c.converted} prev={p.customers - p.converted}
              fmt={fmtCount} riseIsGood={false} tab="flow"
              caption="the growth pool — every one is a winnable sale"
              share={c.customers ? (c.customers - c.converted) / c.customers : 0}
              coh="unconverted" />
            {tv ? (
              <Stat label="opportunity on the table"
                cur={(c.customers - c.converted) * c.conversion * tv}
                prev={(p.customers - p.converted) * p.conversion * tv}
                fmt={fmtMoney} riseIsGood={false} tab="flow"
                caption="if the unconverted converted at today's rate" />
            ) : (
              <Stat label="reached first screen only" cur={1 - c.engagedShare} prev={1 - p.engagedShare}
                fmt={pct} riseIsGood={false} tab="flow"
                caption="never saw a second screen" share={1 - c.engagedShare} />
            )}
            <Stat label="customers who bounced"
              cur={Math.max(0, c.customers - c.realEngaged)}
              prev={Math.max(0, p.customers - p.realEngaged)}
              fmt={fmtCount} riseIsGood={false} tab="flow"
              caption="came, saw one screen, left" />
          </div>
        </div>
      </section>

      {/* what failure costs — the bridge between the two fronts, in the
          board's own currency: conversions (or money, with the ticket set) */}
      {errCost && (
        <section className="bc__front" style={{ ["--fh" as string]: "var(--t-amber, var(--t-pink))" }}>
          <h2 className="bc__ftitle">What failure costs</h2>
          <div className="bc__cost">
            <div className="bc__cost-k">
              <b className="num">{pct(errCost.rClean)}</b>
              <span>conversion, error-free sessions</span>
            </div>
            <i className="bc__cost-vs">vs</i>
            <div className="bc__cost-k bc__cost-k--bad">
              <b className="num">{pct(errCost.rHit)}</b>
              <span>conversion after meeting an error</span>
            </div>
            <div className="bc__cost-verdict">
              {errCost.lost > 0 ? (
                <>errors cost <b className="num">{tv ? `≈ ${money(sc(errCost.lost) * tv, sym)}` : `≈ ${fmtN(Math.round(sc(errCost.lost)))}`}</b>
                  {tv ? "" : " conversions"} this {data.tf.label.replace(/^last /i, "")}
                  <em>{fmtCount(errCost.hitN)} customers met an error and converted
                    {errCost.rClean > 0 ? ` ${(errCost.rHit / errCost.rClean) < 1
                      ? `${(errCost.rClean / Math.max(errCost.rHit, 0.0001)).toFixed(1)}× less`
                      : "no less"} often` : ""}</em></>
              ) : (
                <>errors did not dent conversion this window
                  <em>{fmtCount(errCost.hitN)} customers met an error and converted just as often</em></>
              )}
            </div>
          </div>
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
                  <i style={{ width: `${where.cur.rend * 100}%`, background: "var(--warn, #e8b04b)" }} />
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
                    <i style={{ background: "var(--warn, #e8b04b)" }} />the customer&apos;s device · {ms(where.per(where.d.slow.cur.rend))} per screen</span>
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
          <h2 className="bc__ftitle">Where conversion lives — and dies</h2>
          <div className="bc__segs">
            {([["converts above average", segments.best, "good"],
               ["converts below average", segments.worst, "bad"]] as const)
              .map(([title, rows, tone]) => rows.length > 0 && (
                <div className="bc__seg" key={title}>
                  <h3 className={`bc__seg-h bc__seg-h--${tone}`}>{title}</h3>
                  {rows.map((r) => (
                    <div className="bc__seg-r" key={`${r.d}${r.bucket}`}>
                      <span className="bc__seg-b">{r.bucket}<em>{r.d}</em></span>
                      <b className="num">{pct(r.rate)}</b>
                      <span className="bc__seg-lift" style={{ color: `var(--${tone})` }}>
                        {r.lift >= 1 ? `${r.lift.toFixed(1)}×`
                          : r.rate === 0 ? "none convert" : `${(1 / r.lift).toFixed(1)}× less`}
                      </span>
                      <em className="bc__seg-n">{fmtCount(r.n)} customers</em>
                    </div>
                  ))}
                </div>
              ))}
          </div>
        </section>
      )}
    </div>
  );
}
