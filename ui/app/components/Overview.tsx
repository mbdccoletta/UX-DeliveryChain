// The landing page: one executive heatmap table.
//
// Rows are applications, columns are the numbers an owner actually asks for —
// p50/p90/p95, failure rate, abandonment, conversion, forecast — and every
// cell wears the colour of its own verdict, so the table reads as a heatmap
// before it reads as numbers: scan the red column-wise to see WHAT hurts,
// row-wise to see WHO hurts. Click a header to re-rank 500 applications by
// any measure; click a row to open that application's delivery chain.
//
// Thresholds are stated where they are defined, not hidden in colours.
import React, { useState } from "react";
import { fmtK, fmtMs, fmtN, perfScore } from "../utils/dql";
import type { AppRow, ChainData } from "../hooks/useChainData";
import { useAppForecast } from "../hooks/useForecast";
import { useUxOverview, type UxRow } from "../hooks/useUxOverview";

import { hitTone, verdictOf, VERDICT_LEGEND } from "../utils/verdict";
import { apdexOf, apdexBand, apdexTone, fmtApdex, APDEX_LABEL } from "../utils/apdex";

type Tone = "good" | "warn" | "bad" | "none";
const TVAR: Record<Exclude<Tone, "none">, string> = {
  good: "var(--good)", warn: "var(--warn)", bad: "var(--bad)",
};
/** utils/verdict.ts speaks in "info" for unmeasured; this table draws it blank. */
const asCell = (t: string): Tone => (t === "info" ? "none" : t as Tone);

/** Rows that may fetch a forecast — the analyzer is not a 500-call service. */
const FORECAST_CAP = 24;

/* ── the verdicts, one per measure, stated once ── */
/** View durations judged by the same score the chain uses: ≥75 good, ≥40 warn. */
const durTone = (ns: number): Tone =>
  ns <= 0 ? "none" : perfScore(ns) >= 75 ? "good" : perfScore(ns) >= 40 ? "warn" : "bad";
/** Failure = sessions that saw an error. Thresholds from utils/verdict.ts, the
 *  same ones the landing page and the delivery chain are coloured by. */
const failTone = (rate: number | null): Tone => asCell(hitTone(rate));
/** Abandonment of user actions. <5% good · 5–20% warn · ≥20% bad. */
const abandonTone = (rate: number | null): Tone =>
  rate === null ? "none" : rate < 0.05 ? "good" : rate < 0.2 ? "warn" : "bad";
/** Conversion (past the first view). ≥50% good · <20% warn · between: no colour. */
const convTone = (rate: number | null): Tone =>
  rate === null ? "none" : rate >= 0.5 ? "good" : rate < 0.2 ? "warn" : "none";

interface Scored {
  app: AppRow;
  ux?: UxRow;
  /** The exact per-session count, the one every screen quotes. */
  sessions: number;
  /** Sessions hit by errors / sessions — null while the aggregate loads. */
  fail: number | null;
  abandon: number | null;
  conv: number | null;
  /** Apdex over user actions — speed only, never correctness. */
  apdex: number | null;
  /** Real people hit by errors, and how many there were to hit. */
  realHit: number | null;
  realSessions: number | null;
  problems: number;
  /** The shared verdict — same call the chain and the landing page make. */
  verdict: ReturnType<typeof verdictOf>;
}

type SortKey = "name" | "sessions" | "affected" | "fail" | "apdex"
  | "p50" | "p90" | "p95" | "abandon" | "conv";

export function Overview({ data, onOpen }: {
  data: ChainData;
  /** Opens the application's delivery chain — every row is a door. */
  onOpen: (appId: string) => void;
}) {
  const ux = useUxOverview(data.tf);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: "affected", asc: false });

  const scored: Scored[] = data.apps.map((app) => {
    const u = ux?.get(app.appId);
    const rate = (n: number, d: number) => (d > 0 ? n / d : null);
    const probs = data.problems.filter((p) =>
      (p.entityIds ?? []).includes(app.entity ?? ""));
    const problems = probs.length;
    return {
      app, ux: u, problems,
      // The per-session scan is exact; app.sessions is an approximate distinct
      // count. Showing both made the same application read 11.8k here and
      // 11.9k on its own page — one number, from the scan, everywhere.
      sessions: u?.sessions ?? app.sessions,
      fail: u ? rate(u.hit, u.sessions) : null,
      abandon: u ? rate(u.abandoned, u.actions) : null,
      conv: u ? rate(u.engaged, u.sessions) : null,
      apdex: u ? apdexOf(u) : null,
      // real users affected, and the count that ranks the table
      realHit: u?.hitReal ?? null,
      realSessions: u?.realSessions ?? null,
      verdict: verdictOf({ problems, categories: probs.map((p) => p.category),
        sessions: u?.sessions, hit: u?.hit,
        realSessions: u?.realSessions, realHit: u?.hitReal }),
    };
  });

  const val = (s: Scored, k: SortKey): number | string => ({
    name: s.app.name.toLowerCase(), sessions: s.sessions,
    fail: s.fail ?? -1, p50: s.app.p50View, p90: s.app.p90View, p95: s.app.p95View,
    abandon: s.abandon ?? -1, conv: s.conv ?? -1, apdex: s.apdex ?? -1,
    affected: s.realHit ?? -1,
  }[k]);
  const rows = scored
    .filter((s) => !q || s.app.name.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => {
      const x = val(a, sort.key), y = val(b, sort.key);
      const c = typeof x === "string" ? String(x).localeCompare(String(y)) : Number(x) - Number(y);
      return sort.asc ? c : -c;
    });

  const totals = scored.reduce((acc, s) => {
    acc.sessions += s.sessions; acc.hit += s.ux?.hit ?? 0;
    acc.real += s.realSessions ?? 0; acc.realHit += s.realHit ?? 0;
    return acc;
  }, { sessions: 0, hit: 0, real: 0, realHit: 0 });
  // The headline counts PEOPLE. Measured here, 26k of the estate's 50k sessions
  // are robots and monitors, and they were dragging the number down to 31% —
  // a figure describing mostly machines, printed as if it described customers.
  const people = totals.real > 0;
  const denom = people ? totals.real : totals.sessions;
  const numer = people ? totals.realHit : totals.hit;
  // Floored, never rounded up: one hit session must not display as 100% clean.
  const estateClean = ux && denom > 0
    ? Math.floor((1 - numer / denom) * 100) : null;
  const attention = scored.filter((s) => s.verdict.tone === "bad").length;

  // worst failures first on the forecast budget, whatever the visible sort
  const forecastIds = new Set([...scored]
    .sort((a, b) => (b.fail ?? 0) - (a.fail ?? 0))
    .slice(0, FORECAST_CAP).map((s) => s.app.appId));

  const th = (key: SortKey, label: string, title?: string) => (
    <th aria-sort={sort.key === key ? (sort.asc ? "ascending" : "descending") : undefined}>
      <button className="ovth" title={title}
        onClick={() => setSort((s) =>
          s.key === key ? { key, asc: !s.asc } : { key, asc: key === "name" })}>
        {label}{sort.key === key ? (sort.asc ? " ▲" : " ▼") : ""}
      </button>
    </th>
  );

  return (
    <div className="stack">
      <div className="ovtop">
        <div className="ovbig" style={{ color:
          estateClean === null ? "var(--ink-2)"
          : estateClean < 50 ? "var(--bad)" : estateClean < 90 ? "var(--warn)" : "var(--good)" }}>
          <b className="num">{estateClean === null ? "…" : `${estateClean}%`}</b>
          <span>of {fmtN(denom)} {people ? "real-user" : ""} sessions error-free
            {" · "}{data.tf.label}
            {people && totals.sessions > totals.real && (
              <em style={{ fontStyle: "normal", opacity: 0.65 }}>
                {" · "}{fmtN(totals.sessions - totals.real)} robot/synthetic sessions excluded
              </em>
            )}</span>
        </div>
        <div className="ovcounts">
          <span className="ovpill ovpill--bad">{ux ? attention : "…"} critical</span>
          <span className="ovpill">{data.problems.length} active problems</span>
          {data.apps.length > 8 && (
            <input className="ovq" type="search" placeholder="Filter…"
              value={q} onChange={(e) => setQ(e.target.value)}
              aria-label="Filter applications by name" />
          )}
        </div>
      </div>

      <div className="panel" style={{ overflowX: "auto" }}>
        <table className="ovtbl">
          <thead>
            <tr>
              {th("name", "Application")}
              {th("sessions", "Sessions")}
              {th("affected", "Users affected",
                "Real-user sessions that hit an error — robots and synthetic monitors excluded")}
              {th("fail", "Failure rate", "ALL sessions that saw an error, test traffic included")}
              {th("apdex", "Apdex",
                `(satisfied + tolerating/2) / rated user actions · ${APDEX_LABEL}`)}
              {th("p50", "p50")}
              {th("p90", "p90")}
              {th("p95", "p95")}
              {th("abandon", "Abandonment", "User actions abandoned mid-flight")}
              {th("conv", "Conversion", "Sessions that went past their first view")}
              <th>Forecast 12h</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <AppTr key={s.app.appId} s={s}
                withForecast={forecastIds.has(s.app.appId)}
                onOpen={() => onOpen(s.app.appId)} />
            ))}
          </tbody>
        </table>
      </div>

      <div className="ovlegend">
        <i style={{ background: TVAR.good }} /> Healthy
        <i style={{ background: TVAR.warn }} /> Warning
        <i style={{ background: TVAR.bad }} /> Critical
        <em>{VERDICT_LEGEND} · view times judged at ≤1s good / ≥8s bad ·
          click a column to re-rank · click a row to open the chain</em>
      </div>
    </div>
  );
}

function AppTr({ s, withForecast, onOpen }: {
  s: Scored; withForecast: boolean; onOpen: () => void;
}) {
  const fc = useAppForecast(withForecast ? s.app.appId : undefined);
  const { app, problems } = s;
  const pct = (r: number | null) => (r === null ? "…" : `${Math.round(r * 100)}%`);

  return (
    <tr className="ovtr" tabIndex={0} onClick={onOpen}
      onKeyDown={(e) => { if (e.key === "Enter") onOpen(); }}
      aria-label={`${app.name} — open its delivery chain`}>
      <td className="ovtd-nm" title={`${s.verdict.label} — ${s.verdict.reason}`}>
        {/* the row's own verdict, from the same call the chain colours by */}
        <i className="ovtd-sig" style={{ background: s.verdict.tone === "info"
          ? "var(--ink-3)" : TVAR[s.verdict.tone as Exclude<Tone, "none">] }} />
        {app.name}
        <em>{app.entity?.startsWith("MOBILE_APPLICATION-") ? "mobile" : "web"}</em>
        {problems > 0 && <b className="ovtd-prob">{problems}⚠</b>}
      </td>
      <td className="num">{fmtN(s.sessions)}</td>
      {/* People first. An application whose robots all fail is a finding;
          it is not the same finding as one hurting its actual users, and
          this column is what separates them. */}
      <Hm tone={s.realHit === null ? "none" : asCell(hitTone(
            s.realSessions ? s.realHit / s.realSessions : 0))}
        v={s.realHit === null ? "…" : s.realSessions === 0 ? "no users" : fmtN(s.realHit)}
        title={s.realSessions === 0
          ? "Every session here is a robot or a synthetic monitor"
          : `${fmtN(s.realHit ?? 0)} of ${fmtN(s.realSessions ?? 0)} real-user sessions`} />
      <Hm tone={failTone(s.fail)} v={pct(s.fail)} />
      <Hm tone={asCell(apdexTone(s.apdex))} v={fmtApdex(s.apdex)}
        title={s.apdex === null ? undefined
          : `${apdexBand(s.apdex)} · ${fmtN(s.ux?.satisfied ?? 0)} satisfied · `
            + `${fmtN(s.ux?.tolerating ?? 0)} tolerating · ${fmtN(s.ux?.frustrated ?? 0)} frustrated`} />
      <Hm tone={durTone(app.p50View)} v={fmtMs(app.p50View)} />
      <Hm tone={durTone(app.p90View)} v={fmtMs(app.p90View)} />
      <Hm tone={durTone(app.p95View)} v={fmtMs(app.p95View)} />
      <Hm tone={abandonTone(s.abandon)} v={pct(s.abandon)} />
      <Hm tone={convTone(s.conv)} v={pct(s.conv)} />
      <Hm tone={fc && fc.slope > 0 ? "warn" : "none"}
        v={withForecast ? (fc ? `≈ ${fmtK(Math.round(fc.total))} ${fc.slope > 0 ? "↗" : "↘"}` : "…") : "—"} />
    </tr>
  );
}

/** One heatmap cell: the value on its own verdict's colour. */
function Hm({ tone, v, title }: { tone: Tone; v: string; title?: string }) {
  return (
    <td className="num ovhm" title={title} style={tone === "none" ? undefined : {
      background: `color-mix(in srgb, ${TVAR[tone]} 16%, transparent)`,
      color: tone === "good" ? "var(--ink)" : TVAR[tone],
      boxShadow: `inset 3px 0 0 ${TVAR[tone]}`,
    }}>{v}</td>
  );
}
