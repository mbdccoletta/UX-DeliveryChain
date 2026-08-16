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
import { fmtN } from "../utils/dql";

type Dir = "good" | "bad" | "flat";
const pct = (v: number) => `${(v * 100).toFixed(v * 100 < 10 ? 1 : 0)}%`;
const money = (v: number, sym: string) =>
  v >= 1e6 ? `${sym}${(v / 1e6).toFixed(1)}M`
  : v >= 1e3 ? `${sym}${(v / 1e3).toFixed(0)}k`
  : `${sym}${Math.round(v)}`;

function trend(cur: number, prev: number, riseIsGood: boolean): { dir: Dir; rel: number | null } {
  if (prev === 0 && cur === 0) return { dir: "flat", rel: 0 };
  const rel = prev === 0 ? null : (cur - prev) / Math.abs(prev);
  if (rel !== null && Math.abs(rel) < 0.03) return { dir: "flat", rel };
  return { dir: (cur > prev) === riseIsGood ? "good" : "bad", rel };
}
const TONE: Record<Dir, string> = { good: "var(--good)", bad: "var(--bad)", flat: "var(--ink-3)" };
const ARROW: Record<Dir, string> = { good: "▲", bad: "▼", flat: "—" };

export function ReportView({ data, onGo }: {
  data: ChainData;
  onGo?: (tab: "chain" | "flow" | "home", appId?: string, hl?: string) => void;
}) {
  const [ticket, setTicket] = useState<string>("");
  const [sym, setSym] = useState("$");
  // always ONE application on this board (no all-applications view, by
  // request) — the busiest until the reader picks another
  const [pickedApp, setPickedApp] = useState<string>("");
  // the share of traffic Dynatrace monitors, per the reader; volumes are
  // extrapolated by 100/cov, rates never are
  const [cov, setCov] = useState<string>("");
  const scopeApp = pickedApp || data.apps[0]?.appId || "";
  const kpis = useBizKpis(data.tf);
  const fc = useBizForecast(data.tf, scopeApp || null);
  const breakdown = useBizBreakdown(data.tf);
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
      engagedShare: (s?.sessions ?? 0) ? (s?.engaged ?? 0) / (s?.sessions ?? 1) : 0,
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
          {ARROW[t.dir]} {t.rel === null ? "new" : t.dir === "flat" ? "steady" : `${Math.abs(t.rel * 100).toFixed(0)}%`}
          <em> vs previous {data.tf.label}</em>
        </span>
        <span className="bc__hero-s">{sub}</span>
      </div>
    );
  };

  const Stat = ({ label, cur: cv, prev: pv, fmt, riseIsGood, tab, mover, coh }: {
    label: string; cur: number; prev: number; fmt: (v: number) => string;
    riseIsGood: boolean; tab: "home" | "flow" | "chain"; mover?: (p: BizPeriod) => number;
    /** A cohort intent passed to the Flow — opens its infographic directly. */
    coh?: string;
  }) => {
    if (!kpis) return <div className="bc__stat bc__stat--load" />;
    const t = trend(cv, pv, riseIsGood);
    const top = mover && coh && scopeApp
      ? { id: scopeApp, v: mover(scoped?.cur ?? {} as BizPeriod) } : null;
    return (
      <div className="bc__stat">
        <span className="bc__stat-l">{label}</span>
        <b className="bc__stat-v num">{fmt(cv)}</b>
        <span className="bc__stat-t" style={{ color: TONE[t.dir] }}>
          {ARROW[t.dir]} {t.rel === null ? "new" : t.dir === "flat" ? "—" : `${Math.abs(t.rel * 100).toFixed(0)}%`}
        </span>
        {top && (
          <button className="bc__stat-mv" onClick={() => onGo?.(tab, top.id, coh)}
            title={coh ? `${nameOf(top.id)} — portrait of who left`
              : `${nameOf(top.id)} — open`}>{nameOf(top.id)}{coh ? " ↗ who they are" : ""}</button>
        )}
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

  // ── the portfolio: every application's own board line, worst risk first —
  //    the one estate-wide glance, and the way between applications
  const portfolio = (() => {
    if (!kpis) return null;
    return [...kpis.byApp.entries()].map(([id, v]) => {
      const real = v.cur.realSessions, conv = real ? v.cur.convertedReal / real : 0;
      const prevReal = v.prev.realSessions;
      const prevConv = prevReal ? v.prev.convertedReal / prevReal : 0;
      return { id, name: nameOf(id), customers: real, conv, convT: trend(conv, prevConv, true),
        atRisk: v.cur.hitReal, riskT: trend(v.cur.hitReal, v.prev.hitReal, false),
        crash: v.cur.fatalSessions };
    }).filter((r) => r.customers > 0)
      .sort((a, b) => (b.atRisk / Math.max(1, b.customers)) - (a.atRisk / Math.max(1, a.customers)));
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
        <select className="bc__scope" value={scopeApp}
          onChange={(e) => setPickedApp(e.target.value)}
          aria-label="Application scope"
          title="The application this board reads">
          {data.apps.filter((a) => !a.entity?.startsWith("MOBILE_APPLICATION-")).length > 0 && (
            <optgroup label="Web">
              {data.apps.filter((a) => !a.entity?.startsWith("MOBILE_APPLICATION-"))
                .map((a) => <option key={a.appId} value={a.appId}>{nameOf(a.appId)}</option>)}
            </optgroup>
          )}
          {data.apps.filter((a) => a.entity?.startsWith("MOBILE_APPLICATION-")).length > 0 && (
            <optgroup label="Mobile">
              {data.apps.filter((a) => a.entity?.startsWith("MOBILE_APPLICATION-"))
                .map((a) => <option key={a.appId} value={a.appId}>{nameOf(a.appId)}</option>)}
            </optgroup>
          )}
        </select>
        <label className="bc__ticket bc__cov"
          title="Share of your traffic Dynatrace monitors. Below 100, every volume on the board is extrapolated to the whole (marked with an approx sign); rates stay as measured — a representative sample carries them unchanged.">
          <input inputMode="numeric" placeholder="100"
            value={cov} onChange={(e) => setCov(e.target.value.replace(/[^\d]/g, "").slice(0, 3))} />
          <span>% monitored</span>
        </label>
        <label className="bc__ticket" title="Value of one conversion — turns customers into revenue. Blank = customers only.">
          <span>{sym}</span>
          <input inputMode="decimal" placeholder="value / conversion"
            value={ticket} onChange={(e) => setTicket(e.target.value.replace(/[^\d.]/g, ""))} />
          <select value={sym} onChange={(e) => setSym(e.target.value)} aria-label="currency">
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
                <b className="num">{tv ? money(sc(fc.conversions.point) * tv, sym)
                  : `≈ ${fmtN(Math.round(sc(fc.conversions.point)))}`}</b>
                {tv ? " revenue expected" : " conversions expected"}
                <em>({tv ? `${money(sc(Math.max(0, fc.conversions.lower)) * tv, sym)}–${money(sc(fc.conversions.upper) * tv, sym)}`
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
              fmt={fmtCount} riseIsGood={false} tab="home" />
            <Stat label="sessions lost to a crash" cur={c.crashed} prev={p.crashed}
              fmt={fmtCount} riseIsGood={false} tab="home" />
            <Stat label="brand health (0–100)" cur={c.reputationIndex} prev={p.reputationIndex}
              fmt={(v) => `${Math.round(v * 100)}`} riseIsGood={true} tab="chain" />
            <Stat label="open incidents"
              cur={scopeApp ? data.problems.filter((pr) => (pr.entityIds ?? [])
                    .some((e) => e.toLowerCase().includes(scopeApp))).length : data.problems.length}
              prev={scopeApp ? data.problems.filter((pr) => (pr.entityIds ?? [])
                    .some((e) => e.toLowerCase().includes(scopeApp))).length : data.problems.length}
              fmt={(v) => fmtN(v)} riseIsGood={false} tab="chain" />
          </div>
        </div>
      </section>

      <section className="bc__front" style={{ ["--fh" as string]: "var(--t-cyan)" }}>
        <h2 className="bc__ftitle">Deliver personalised journeys</h2>
        <div className="bc__row">
          <Hero front="journeys" />
          <div className="bc__stats">
            <Stat label="customers who converted" cur={c.converted} prev={p.converted}
              fmt={fmtCount} riseIsGood={true} tab="flow" />
            <Stat label="customers who left unconverted"
              cur={c.customers - c.converted} prev={p.customers - p.converted}
              fmt={fmtCount} riseIsGood={false} tab="flow"
              mover={(pp) => pp.realSessions - pp.convertedReal} coh="unconverted" />
            {tv ? (
              <Stat label="opportunity on the table"
                cur={(c.customers - c.converted) * c.conversion * tv}
                prev={(p.customers - p.converted) * p.conversion * tv}
                fmt={fmtMoney} riseIsGood={false} tab="flow" />
            ) : (
              <Stat label="reached first screen only" cur={1 - c.engagedShare} prev={1 - p.engagedShare}
                fmt={pct} riseIsGood={false} tab="flow" />
            )}
            <Stat label="customers who bounced"
              cur={c.customers - Math.round(c.engagedShare * (curP?.sessions ?? 0))}
              prev={p.customers - Math.round(p.engagedShare * (prevP?.sessions ?? 0))}
              fmt={fmtCount} riseIsGood={false} tab="flow" />
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
                <>errors cost <b className="num">{tv ? money(sc(errCost.lost) * tv, sym) : `≈ ${fmtN(Math.round(sc(errCost.lost)))}`}</b>
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

      {/* the portfolio: one line per application, worst failure-exposure
          first; a click scopes the whole board to it */}
      {portfolio && portfolio.length > 1 && (
        <section className="bc__front">
          <h2 className="bc__ftitle">Portfolio</h2>
          <div className="bc__pf">
            <div className="bc__pf-r bc__pf-r--hd" aria-hidden="true">
              <span>application</span><span>customers</span><span>conversion</span>
              <span>at risk</span><span>crashes</span>
            </div>
            {portfolio.map((r) => (
              <button className={`bc__pf-r${r.id === scopeApp ? " bc__pf-r--on" : ""}`}
                key={r.id} onClick={() => setPickedApp(r.id)}
                title={`Scope the board to ${r.name}`}>
                <span className="bc__pf-nm">{r.name}</span>
                <span className="num">{fmtCount(r.customers)}</span>
                <span className="num">{pct(r.conv)}
                  <i style={{ color: TONE[r.convT.dir] }}> {ARROW[r.convT.dir]}</i></span>
                <span className="num">{fmtCount(r.atRisk)}
                  <i style={{ color: TONE[r.riskT.dir] }}> {ARROW[r.riskT.dir]}</i></span>
                <span className="num">{r.crash ? fmtCount(r.crash) : "—"}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
