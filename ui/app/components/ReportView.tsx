// Business Control — the board a C-level reader opens.
//
// Not product metrics (apdex, abandoned actions) — those are for the team.
// This speaks the board's language: customers, revenue, conversion, risk;
// each front leads with one HERO number and its trend against the previous
// window of the same length, with a supporting row beneath. Revenue is
// optional and honest: the platform does not know what a conversion is worth,
// so the reader supplies the ticket value and every money figure derives from
// it live; with the field blank the board speaks in customers, which needs no
// assumption. Anonymised by default so it can leave the building.
import React, { useMemo, useState } from "react";
import type { ChainData } from "../hooks/useChainData";
import { useBizKpis, type BizPeriod } from "../hooks/useBizKpis";
import { aliasMap } from "../utils/appAlias";
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
  const [anon, setAnon] = useState(true);
  const [ticket, setTicket] = useState<string>("");
  const [sym, setSym] = useState("$");
  // the whole estate by default; one application when the reader narrows it
  const [scopeApp, setScopeApp] = useState<string>("");
  const kpis = useBizKpis(data.tf);
  const aliases = useMemo(() => aliasMap(data), [data]);
  const nameOf = (id: string) => {
    const a = data.apps.find((x) => x.appId === id);
    if (!a) return id.slice(0, 8);
    return anon ? aliases.get(a.name) ?? a.name : a.name;
  };
  const tv = Number(ticket) > 0 ? Number(ticket) : null;

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
      ? (tv ? (v: number) => money(v, sym) : (v: number) => fmtN(Math.round(v)))
      : (tv ? (v: number) => money(v, sym) : pct);
    const sub = isBrand
      ? `${fmtN(c.customersAtRisk)} customers met a failure · ${pct(1 - c.reputationIndex)} of the base`
      : `${fmtN(c.converted)} of ${fmtN(c.customers)} customers reached the goal`;
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
    const top = (mover && !scopeApp) ? [...kpis.byApp.entries()]
      .map(([id, v]) => ({ id, v: mover(v.cur) }))
      .filter((m) => m.v > 0).sort((a, b) => b.v - a.v)[0]
      : (mover && scopeApp) ? { id: scopeApp, v: mover(scoped?.cur ?? {} as BizPeriod) } : null;
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

  const cSess = kpis?.estate.cur, pSess = kpis?.estate.prev;

  return (
    <div className="stack bc">
      <div className="bc__bar">
        <span className="lbl">Business Control</span>
        <span className="hint">{data.tf.label} vs the {data.tf.label} before · measured, not estimated</span>
        <div className="spacer" />
        <select className="bc__scope" value={scopeApp}
          onChange={(e) => setScopeApp(e.target.value)}
          aria-label="Application scope"
          title="Scope the whole board to one application, or the whole estate">
          <option value="">All applications</option>
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
        <label className="bc__ticket" title="Value of one conversion — turns customers into revenue. Blank = customers only.">
          <span>{sym}</span>
          <input inputMode="decimal" placeholder="value / conversion"
            value={ticket} onChange={(e) => setTicket(e.target.value.replace(/[^\d.]/g, ""))} />
          <select value={sym} onChange={(e) => setSym(e.target.value)} aria-label="currency">
            {["$", "€", "£", "R$"].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <div className="seg" role="group" aria-label="Identity">
          <button className={anon ? "on" : ""} aria-pressed={anon} onClick={() => setAnon(true)}
            title="Application names replaced by aliases — safe to share">anonymized</button>
          <button className={!anon ? "on" : ""} aria-pressed={!anon} onClick={() => setAnon(false)}
            title="Real names — internal use">named</button>
        </div>
      </div>

      <section className="bc__front" style={{ ["--fh" as string]: "var(--t-pink)" }}>
        <h2 className="bc__ftitle">Protect the brand</h2>
        <div className="bc__row">
          <Hero front="brand" />
          <div className="bc__stats">
            <Stat label="customers hit by a failure" cur={c.customersAtRisk} prev={p.customersAtRisk}
              fmt={(v) => fmtN(Math.round(v))} riseIsGood={false} tab="home" mover={(pp) => pp.hitReal} />
            <Stat label="sessions lost to a crash" cur={c.crashed} prev={p.crashed}
              fmt={(v) => fmtN(Math.round(v))} riseIsGood={false} tab="home" mover={(pp) => pp.fatalSessions} />
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
              fmt={(v) => fmtN(Math.round(v))} riseIsGood={true} tab="flow" mover={(pp) => pp.convertedReal} />
            <Stat label="customers who left unconverted"
              cur={c.customers - c.converted} prev={p.customers - p.converted}
              fmt={(v) => fmtN(Math.round(v))} riseIsGood={false} tab="flow"
              mover={(pp) => pp.realSessions - pp.convertedReal} coh="unconverted" />
            {tv ? (
              <Stat label="opportunity on the table"
                cur={(c.customers - c.converted) * c.conversion * tv}
                prev={(p.customers - p.converted) * p.conversion * tv}
                fmt={(v) => money(v, sym)} riseIsGood={false} tab="flow" />
            ) : (
              <Stat label="reached first screen only" cur={1 - c.engagedShare} prev={1 - p.engagedShare}
                fmt={pct} riseIsGood={false} tab="flow" />
            )}
            <Stat label={scopeApp ? "customers who bounced" : "active applications"}
              cur={scopeApp ? (c.customers - Math.round(c.engagedShare * (curP?.sessions ?? 0))) : data.apps.length}
              prev={scopeApp ? (p.customers - Math.round(p.engagedShare * (prevP?.sessions ?? 0))) : data.apps.length}
              fmt={(v) => fmtN(v)} riseIsGood={false} tab={scopeApp ? "flow" : "home"} />
          </div>
        </div>
      </section>
    </div>
  );
}
