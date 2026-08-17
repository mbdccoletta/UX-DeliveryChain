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

export interface InfoRow {
  dim: string; bucket: string; inCohort: boolean;
  sessions: number; hit: number; fatal: number; p50dur: number; p50views: number;
}

const fmtPct = (v: number) => `${(v * 100).toFixed(v * 100 < 10 ? 1 : 0)}%`;

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

const money = (v: number, sym: string) =>
  v >= 1e6 ? `${sym}${(v / 1e6).toFixed(1)}M`
  : v >= 1e3 ? `${sym}${(v / 1e3).toFixed(0)}k`
  : `${sym}${Math.round(v)}`;

export function RouteInfographic({ rows, path, appName, cohort, total, biz, ticket, sym, approx, onClose }: {
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
  ticket?: number | null;
  sym?: string;
  /** Figures were scaled from capped samples — worn as ≈ and said in the foot. */
  approx?: boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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
          <h2 className="rinfo__path">
            {path.map((p, i) => (
              <React.Fragment key={i}>
                {i > 0 && <i className="rinfo__arrow" aria-hidden="true">→</i>}
                <span>{p}</span>
              </React.Fragment>
            ))}
          </h2>
          <div className="rinfo__cohort">
            <b className="num">{approx ? "≈ " : ""}{fmtN(cohort)}</b>
            <span>{cohort >= total ? "sessions — the whole flow"
              : `sessions on this route · ${total ? fmtPct(cohort / total) : "—"} of ${fmtN(total)}`}</span>
          </div>
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
                    <b className="num">{fmtPct(biz.conv)}</b>
                    <span className="rinfo__kpi-l">conversion</span>
                    <em>{biz.restConv > 0
                      ? (biz.conv / biz.restConv >= 1.15
                          ? `${(biz.conv / biz.restConv).toFixed(1)}× everyone else's ${fmtPct(biz.restConv)}`
                          : biz.conv / biz.restConv <= 0.87
                            ? `${(biz.restConv / Math.max(biz.conv, 0.0001)).toFixed(1)}× below everyone's ${fmtPct(biz.restConv)}`
                            : `same as everyone's ${fmtPct(biz.restConv)}`)
                      : "no one else converted"}</em>
                  </div>
                  <div className="rinfo__kpi rinfo__kpi--worth">
                    <b className="num">{fmtN(biz.customers)}</b>
                    <span className="rinfo__kpi-l">customers</span>
                    <em>{fmtN(biz.converted)} reached the goal</em>
                  </div>
                  {ticket ? (
                    <>
                      <div className="rinfo__kpi rinfo__kpi--worth">
                        <b className="num">{money(biz.converted * ticket, sym ?? "$")}</b>
                        <span className="rinfo__kpi-l">revenue carried</span>
                        <em>at {sym}{ticket} per conversion</em>
                      </div>
                      <div className={`rinfo__kpi rinfo__kpi--worth${biz.hit > 0 ? " rinfo__kpi--bad" : ""}`}>
                        <b className="num">{money(biz.hit * biz.conv * ticket, sym ?? "$")}</b>
                        <span className="rinfo__kpi-l">at risk</span>
                        <em>{fmtN(biz.hit)} customers met an error</em>
                      </div>
                    </>
                  ) : (
                    <div className={`rinfo__kpi rinfo__kpi--worth${biz.hit > 0 ? " rinfo__kpi--bad" : ""}`}>
                      <b className="num">{fmtN(biz.hit)}</b>
                      <span className="rinfo__kpi-l">met an error</span>
                      <em>set a conversion value in Business Control for money</em>
                    </div>
                  )}
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

            {/* the portrait blocks: one per dimension, filled bars — cohort share
                solid, everyone else as a ghost behind it, so the eye reads the
                over-representation as the solid bar outrunning its shadow */}
            <section className="rinfo__grid">
              {/* every characteristic the application records, in the platform's
                  own order; one it does not record has no rows and is not drawn.
                  A dimension with a single bucket on both sides says nothing
                  about THIS route — it is stated once, compactly, not as a bar. */}
              {dims.filter((d) => d !== "entry view").concat(dims.includes("entry view") ? ["entry view"] : [])
                .map((d) => {
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
