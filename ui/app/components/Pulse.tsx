// The landing page: the application as a living river.
//
// Traffic flows. Literally: every session that touched the application in the
// window is on this stage as a current — real users, robots and synthetic
// monitors pour in from the left, pass through the application's gate, and
// come out on the right in one of two measured arms: clean, or hit by an
// error. Nothing here is choreography: each of the six streams' width and
// particle density is the measured joint distribution — the error split per
// origin comes from the same per-session scan the drawer trusts.
//
// Below the river, the counters climb to their measured values and the last
// hours beat as an ECG. Colour stays signal-only: origins are neutral light,
// green is a session that made it, red is one that did not.
import React, { useEffect, useRef, useState } from "react";
import { fmtK, fmtMs, fmtN } from "../utils/dql";
import type { ChainData } from "../hooks/useChainData";
import type { Timeframe as TimeframeT } from "../utils/dql";
import { useAppForecast } from "../hooks/useForecast";
import { useImpacted } from "../hooks/useImpacted";
import { usePulse } from "../hooks/usePulse";
import { useAppScope } from "../hooks/useAppScope";
import { useMetricForecast, METRIC_LABEL, type Metric } from "../hooks/useEcgForecast";
import { useServiceForecasts, SERVICE_FORECAST_CAP,
  type ServiceAhead } from "../hooks/useServiceForecasts";
import { useServiceSeries } from "../hooks/useServiceSeries";
import { useServiceVitals, type ServiceVitals } from "../hooks/useServiceVitals";
import type { Forecast } from "../utils/forecast";
import { useUxOverview } from "../hooks/useUxOverview";
import { originOf } from "./DeliveryChain";
import {
  AnalyticsIcon, CriticalIcon, DesktopIcon, GroupIcon, HttpIcon, InternetIcon,
  MobileIcon, ServicesIcon, UserSessionsIcon, WarningIcon,
} from "@dynatrace/strato-icons";

import { verdictOf, VERDICT_LEGEND, HIT_WARN, davisCategory,
  type Tone } from "../utils/verdict";
import { errorsExplorerHref, servicesExplorerHref, rowDrilldown, open,
  intentsAvailable, appEntityOf } from "../utils/links";
import type { DeepLink } from "../utils/links";
import { apdexOf, apdexBand, apdexTone, fmtApdex, APDEX_LABEL, APDEX_T_MS } from "../utils/apdex";
import { useCardDetail, type DetailRow, type DetailMetric } from "../hooks/useCardDetail";
import { useDomainTraces } from "../hooks/useDomainTraces";

const TVAR: Record<Tone, string> = {
  good: "var(--good)", warn: "var(--warn)", bad: "var(--bad)", info: "var(--info)",
};

/** A number that climbs to its value — the page arrives moving. */
function useCountUp(target: number, ms = 1100): number {
  const [v, setV] = useState(0);
  const seen = useRef(-1);
  useEffect(() => {
    if (seen.current === target) return;
    seen.current = target;
    const t0 = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const f = Math.min(1, (t - t0) / ms);
      setV(Math.round(target * (1 - Math.pow(1 - f, 3))));
      if (f < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}

export function Pulse({ data, appId, onOpenChain, onAnalyze, onSeeEstate }: {
  data: ChainData;
  appId: string;
  onOpenChain: () => void;
  /** "Analyze user sessions", answered inside this app: the Journey tab. */
  onAnalyze: () => void;
  onSeeEstate: () => void;
}) {
  const app = data.apps.find((a) => a.appId === appId);
  const impacted = useImpacted(appId, data.tf, true);
  const pulse = usePulse(appId, data.tf);
  const fc = useAppForecast(appId);
  const ux = useUxOverview(data.tf);
  const scope = useAppScope(appId, data.apps.find((a) => a.appId === appId)?.entity);
  /* The page opens on sessions. Clicking a card opens that card's evidence
   * BELOW the grid — the chart and its breakdown — and clicking the open card
   * closes it. Only what is on screen costs an analyzer run. */
  const [detail, setDetail] = useState<DetailMetric | "services" | null>("sessions");

  const mfc = useMetricForecast(appId, data.tf,
    detail && detail !== "services" ? detail : null);
  /* One projection per card, because every card now draws one. They read the
   * metric store, measured at 0 scanned bytes, so this is four API calls
   * rather than four scans. */
  const fcSessions = useMetricForecast(appId, data.tf, "sessions");
  const fcErrors = useMetricForecast(appId, data.tf, "errors");
  const fcRequests = useMetricForecast(appId, data.tf, "requests");
  const svcSeries = useServiceSeries([...scope.services], data.tf);
  const detailRows = useCardDetail(appId, data.tf,
    detail && detail !== "services" ? detail : null);
  // which of the listed domains are served by instrumented code — one scan,
  // only while the requests panel is open
  const domainTraces = useDomainTraces(
    detail === "requests" ? (detailRows ?? []).map((r) => r.name) : [],
    data.tf, detail === "requests");
  // the services drill-down: the busiest first, capped, and only once opened
  const svcTop = [...scope.traces.entries()]
    .map(([id, traces]) => ({ id, traces, name: scope.names.get(id) ?? id }))
    .sort((a, b) => b.traces - a.traces)
    .slice(0, SERVICE_FORECAST_CAP);
  const svcAhead = useServiceForecasts(svcTop, detail === "services");
  // measured now, beside the projections — one read for every service at once
  const svcVitals = useServiceVitals(svcTop.map((x) => x.id), data.tf,
    detail === "services");
  const scopeCount = scope.resolved ? scope.services.size : null;
  const svcNames = [...scope.services]
    .map((id) => scope.names.get(id)).filter(Boolean) as string[];
  // The domains this application actually calls, busiest first. Rows arrive
  // split by origin, so they are aggregated per domain before ranking —
  // otherwise one domain contacted from two origins would appear twice and
  // rank below a quieter one.
  const domNames = Object.entries(
    data.domains.filter((r) => r.appId === appId)
      .reduce<Record<string, number>>((acc, r) => {
        acc[r.domain] = (acc[r.domain] ?? 0) + r.reqs; return acc;
      }, {}))
    .sort((a, b) => b[1] - a[1])
    .map(([d, n]) => `${d} · ${fmtK(n)}`);

  if (!app) return null;
  const isMobile = app.entity?.startsWith("MOBILE_APPLICATION-");
  const problems = data.problems.filter((p) =>
    (p.entityIds ?? []).includes(app.entity ?? ""));
  const clean = impacted && impacted.sessions > 0
    ? 1 - impacted.hit / impacted.sessions : null;
  // Problems anywhere in this application's delivery scope count against it —
  // the same set the chain rolls up into its layer captions.
  const scopeProbs = data.problems.filter((pr) =>
    (pr.entityIds ?? []).some((id) => scope.services.has(id)));
  const scopeProblems = scopeProbs.length;
  /* Anomalies, counted by the SAME rule that turns a chain card amber:
   * BASELINING signals bound to this application's entity or anything in its
   * delivery scope. The Overview never read data.signals before — the card
   * knocked and the legend said "anomaly" while the number behind both was
   * the problem count wearing the wrong name. */
  const scopeIds = new Set<string>([
    ...(app.entity ? [app.entity] : []),
    ...scope.services, ...scope.runtime,
  ]);
  /* Counted by the chain's own rule (BASELINING signals on the app's
   * delivery scope). Their one surface on this page is the header button,
   * which opens the chain — where each is amber on its component. */
  const anomalyRows = data.signals.filter((sg) =>
    sg.provider === "BASELINING" && scopeIds.has(sg.entityId));
  const anomalies = anomalyRows.length;
  // ONE verdict, from utils/verdict.ts, shared with the chain, the estate
  // table and the report — so no two screens can disagree about this app.
  const verdict = verdictOf({
    problems: problems.length + scopeProblems,
    anomalies,
    categories: [...problems, ...scopeProbs].map((p) => p.category),
    sessions: impacted?.sessions, hit: impacted?.hit,
    // the population that can actually be harmed decides the verdict
    realSessions: impacted?.realSessions, realHit: impacted?.hitReal,
    forecastRising: !!fc && fc.slope > 0,
  });
  const tone: Tone = verdict.tone;
  // Real people, the same population the estate table's headline counts — the
  // two lines quote the same estate and must not disagree about it.
  const estate = ux ? [...ux.values()].reduce((acc, u) => {
    acc.s += u.sessions; acc.h += u.hit;
    acc.real += u.realSessions; acc.realHit += u.hitReal; return acc;
  }, { s: 0, h: 0, real: 0, realHit: 0 }) : null;
  const uxRow = ux?.get(appId);

  /* ── the measured joint distribution the river obeys ──
   * Origin totals come from the device rows; the hit side of each origin from
   * the per-session impact scan. Clean is the remainder, floored at zero. */
  // origin rows, not device profiles: the profile query is a top-20 over the
  // environment and silently omits the smaller applications entirely
  const devOrigin = data.origins.filter((d) => d.appId === appId)
    .reduce((acc, d) => {
      const o = originOf(d.agent, d.utype);
      const k = o === "Robots" ? "robot" : o === "Synthetic" ? "synth" : "real";
      acc[k] += d.sessions; return acc;
    }, { real: 0, robot: 0, synth: 0 });
  // The device rows give the origin PROPORTIONS; the per-session scan gives
  // the true total. Scaled together, so the river's arms sum to the same
  // number the gate's verdict was computed from — one page, one truth.
  const devSum = devOrigin.real + devOrigin.robot + devOrigin.synth;
  const trueTotal = impacted?.sessions ?? devSum;
  const scale = devSum > 0 ? trueTotal / devSum : 0;
  const byOrigin = {
    real: Math.round(devOrigin.real * scale),
    robot: Math.round(devOrigin.robot * scale),
    synth: Math.round(devOrigin.synth * scale),
  };
  const hits = {
    real: impacted?.hitReal ?? 0, robot: impacted?.hitRobot ?? 0,
    synth: impacted?.hitSynth ?? 0,
  };
  const springs = ([
    ["real", "Real users"], ["robot", "Robots"], ["synth", "Synthetic"],
  ] as const).map(([k, label]) => ({
    k, label, total: byOrigin[k],
    hit: Math.min(hits[k], byOrigin[k]),
    ok: Math.max(byOrigin[k] - hits[k], 0),
  })).filter((s) => s.total > 0);
  const grand = springs.reduce((a, s) => a + s.total, 0) || 1;

  const minutes = data.tf.minutes;
  const perMin = (n: number) => (n / minutes).toFixed(n / minutes >= 10 ? 0 : 1);

  /* ── hand the errors to the platform's Error Inspector ──
   * The Explorer, already filtered and ranked by users affected. It is the
   * app's own url rather than an intent because `inspect-errors-of-frontend`
   * declares no filter string: `target: "explorer"` lands there with an empty
   * filter bar, which is the whole complaint. New tab, because this app runs
   * in an iframe and the hand-off leaves it. */
  const errExplorer = app.errors > 0 ? errorsExplorerHref(data.tf, app.name) : null;

  return (
    <div className="stack">
      <div className="pl-estate">
        <span>
          <b className="num">{data.apps.length}</b> applications ·{" "}
          {estate ? (() => {
            const people = estate.real > 0;
            const d = people ? estate.real : estate.s;
            const n = people ? estate.realHit : estate.h;
            return <>estate <b className="num">
              {/* floored, exactly as the estate table floors it */}
              {d ? Math.floor((1 - n / d) * 100) : 0}%</b>{" "}
              {people ? "of real users" : ""} error-free</>;
          })() : "…"}
          {" "}· <b className="num">{data.problems.length}</b> active problems
        </span>
        <button className="pl-link" onClick={onSeeEstate}>see the whole estate →</button>
      </div>

      <div className="tk-hd">
        <i className="tk-hd__ic" style={{ ["--t" as string]: TVAR[tone] }}>
          {isMobile ? <MobileIcon /> : <DesktopIcon />}
        </i>
        <div className="tk-hd__t">
          <h2>{app.name}</h2>
          <span>{isMobile ? "Mobile application" : "Web application"} · {data.tf.label}
            {" · "}<b style={{ color: TVAR[tone], fontWeight: 600 }}>
              {verdict.label} — {verdict.reason}</b></span>
        </div>
        <div className="tk-hd__a">
          {/* The errors this page counts, opened in the platform's own Error
              Inspector — same application, same window. Offered only when
              there are errors to inspect and an entity id to name them by. */}
          {errExplorer && (
            <a className="tk-btn tk-btn--sig" href={errExplorer}
              target="_blank" rel="noreferrer"
              title={`Error Inspector · ${fmtN(app.errors)} errors of ${app.name}, `
                + `ranked by users affected · ${data.tf.label}`}>
              Inspect {fmtK(app.errors)} errors
            </a>
          )}
          {/* The anomalies' one surface on this page, by the reader's own
              design: a button beside the error inspector, wearing the count.
              It opens the delivery chain — an anomaly only means something on
              the entity it is bound to, and the chain paints exactly those
              entities amber. No native app is offered because no anomaly url
              has been read off one yet. */}
          {anomalies > 0 && (
            <button className="tk-btn tk-btn--warn" onClick={onOpenChain}
              title={`${fmtN(anomalies)} Davis baselining anomalies on this `
                + "application's delivery scope — the chain shows each one amber "
                + "on the component it affects"}>
              {fmtN(anomalies)} anomal{anomalies === 1 ? "y" : "ies"}
            </button>
          )}
          <button className="tk-btn tk-btn--p" onClick={onAnalyze}>Analyze user sessions</button>
          <button className="tk-btn" onClick={onOpenChain}>Open delivery chain</button>
        </div>
      </div>

      <CleanCard
        sessions={impacted?.sessions ?? app.sessions}
        clean={clean} tone={tone} name={app.name} isMobile={!!isMobile}
        series={pulse?.series ?? []}
        actionsPerMin={perMin(pulse?.actions ?? 0)}
        errors={app.errors} errorsPerMin={perMin(app.errors)}
        crashes={app.crashes} anrs={app.anrs}

        /* The core shows an Apdex, which is a speed reading and says nothing
           about what Davis detected. The problems belong beside it — named by
           category, in the platform's own words, so the card carries both what
           was measured and what was detected. */
        problems={problems.length + scopeProblems}
        problemCats={[...new Set([...problems, ...scopeProbs]
          .map((pr) => davisCategory(pr.category)))]}
        requests={pulse?.requests ?? 0} reqFail={pulse?.reqFail ?? 0}
        hitSessions={impacted?.hit ?? 0}
        loadP50={app.p50Load > 0 ? app.p50Load : app.p50View}
        apdex={uxRow ? apdexOf(uxRow) : null}
        realErrors={uxRow ? uxRow.realErrors : null}
        errorsThird={uxRow?.errorsThird ?? 0}
        services={scopeCount} svcNames={svcNames} domNames={domNames}
        fc={fc} onOpen={onOpenChain}
        /* Always open. Clicking the open box used to collapse it, which left
           the page with no chart at all and the default box looking broken.
           A box can now only hand the chart to another box, never remove it. */
        detail={detail} onMetric={(m) => setDetail((cur) => (cur === m ? null : m))}
        svcSeries={svcSeries?.series ?? null}
        fcBars={{
          sessions: fcSessions?.point ?? null,
          errors: fcErrors?.point ?? null,
          requests: fcRequests?.point ?? null,
          // the services card projects its own series with the same estimator
          // the other three use, applied to the metric-store totals
          services: svcSeries?.fc ?? null,
        }} />

      {/* The clicked card's breakdown, full width under the grid — the layout
          the called services already used, now shared by all four. It needs no
          badge naming its source: the grid above holds exactly one card. */}
      {detail === "services" && (
        <ServiceForecasts rows={svcAhead} vitals={svcVitals} total={scopeCount ?? 0}
          tf={data.tf} onClose={() => setDetail(null)} />
      )}
      {detail && detail !== "services" && pulse && pulse.series.length > 1 && (
        <MetricChart series={pulse.series} tf={data.tf} metric={detail} fc={mfc} />
      )}
      {detail && detail !== "services" && (
        <DetailPanel metric={detail} rows={detailRows} tf={data.tf}
          appEntity={appEntityOf(app.entity, appId)} appName={app.name}
          tracedDomains={domainTraces} onClose={() => setDetail(null)} />
      )}
    </div>
  );
}

function Counter({ v, l, tone }: { v: number; l: string; tone?: Tone }) {
  const n = useCountUp(v);
  return (
    <div className="rv-kpi">
      <b className="num" style={tone ? { color: TVAR[tone] } : undefined}>{fmtN(n)}</b>
      <span>{l}</span>
    </div>
  );
}

/* ─────────────── the clean card ───────────────
 *
 * The classic overview card's geometry — two modules, the centre, two
 * modules — carrying only the numbers that decide something. The animation
 * IS the telemetry: everything on this card breathes at the speed of its
 * health (slow green calm, quick red alarm), anomalies pulse, and the
 * forecast draws itself. Nothing moves for decoration.
 */

interface CardProps {
  sessions: number; clean: number | null; tone: Tone; name: string; isMobile: boolean;
  /** The per-bin series; `t` is what the hover read-out puts on screen. */
  series: Array<{ t: string; sessions: number; errors: number; requests: number }>;
  actionsPerMin: string; errors: number; errorsPerMin: string;
  /** The fatal subset of `errors` — crashes end the session, ANRs freeze it
   *  until Android kills it. Mobile only, by what the types can occur on. */
  crashes: number; anrs: number;
  requests: number; reqFail: number; loadP50: number;
  /** Apdex over this application's user actions, or null when none were rated. */
  apdex: number | null;
  /** Errors that reached a real person, and the third-party share of all of
   *  them — null while the estate scan is still in flight. */
  realErrors: number | null;
  errorsThird: number;
  /** Throughput across the services this application calls, per interval. */
  svcSeries?: number[] | null;
  /** The projected intervals each card's bars continue into. */
  fcBars?: Partial<Record<DetailMetric | "services", number[] | null>>;
  /** Active Davis problems on this application or in its delivery scope,
   *  and their categories in the platform's own vocabulary. */
  problems: number;
  problemCats: string[];
  /** Which card's breakdown panel is open below the grid. */
  detail: DetailMetric | "services" | null;
  onMetric: (m: DetailMetric | "services") => void;
  /** Sessions hit by an error — keeps the verdict from rounding up to perfect. */
  hitSessions: number;
  services: number | null; svcNames: string[];
  /** The domains this application contacts, busiest first, with their volume. */
  domNames: string[];
  fc: { total: number; slope: number; point: number[] } | null;
  onOpen: () => void;
}

/** Health decides the breathing pace: calm is slow, trouble is fast. */
const BREATH: Record<Tone, string> = {
  good: "6s", info: "6s", warn: "3.2s", bad: "1.7s",
};

/**
 * One module of the card. When a per-bin series exists behind it the whole
 * box is the button — one click target per box, so a number and its label
 * are read, not aimed at.
 */
const Module = React.forwardRef<HTMLElement, {
  Icon: React.ComponentType<{ className?: string }>; title: string; tone?: Tone;
  pulse?: boolean; children: React.ReactNode;
  metric?: DetailMetric | "services"; active?: boolean;
  onPick?: (m: DetailMetric | "services") => void;
  /** The card's bar chart, drawn in the header rather than at the foot. */
  spark?: React.ReactNode;
}>(function Module({ Icon, title, tone = "info", pulse, children,
  metric, active, onPick, spark }, ref) {
  const pick = metric && onPick ? () => onPick(metric) : undefined;
  return (
    <section ref={ref}
      className={`tk-block cc-mod${pulse ? " cc-mod--pulse" : ""}`
        + (pick ? " cc-mod--pick" : "") + (active ? " cc-mod--on" : "")}
      {...(pick ? {
        role: "button", tabIndex: 0, onClick: pick,
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); }
        },
        "aria-pressed": !!active,
        title: `${active ? "Hide" : "Show"} the breakdown for `
          + (metric === "services" ? "the called services" : METRIC_LABEL[metric as Metric]),
      } : {})}
      style={{ ["--c" as string]: tone === "info" ? "var(--accent)" : TVAR[tone],
               ["--breath" as string]: BREATH[tone] }}>
      <i className="tk-block__wm" aria-hidden="true"><Icon /></i>
      <header className="tk-block__hd">
        <i className="tk-block__ic"><Icon /></i>
        <span>{title}</span>
        {spark && <span className="tk-block__spark">{spark}</span>}
      </header>
      {children}
    </section>
  );
});



/**
 * The core's ring: the verdict as a filled arc, the error rate as waves.
 *
 * The arc's length IS the share of sessions that saw no error, so the ring
 * closes only when every session came through clean. Waves are the second
 * fact: one bright pulse travelling the ring, its cadence following the
 * measured errors-per-minute on the same log scale the wires use — an
 * application with no errors has no waves at all, because none was measured.
 *
 * Geometry is read from the DOM: the core is a rounded rectangle laid out by
 * CSS, and its real perimeter is the only honest track to draw on.
 */
function CoreRing({ host, value, tone, errPerMin, errors }: {
  host: React.RefObject<HTMLDivElement>;
  /** The 0–1 measure the arc fills to — the Apdex the core displays. */
  value: number | null;
  tone: Tone; errPerMin: number; errors: number;
}) {
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const measure = () => {
      const b = el.getBoundingClientRect();
      if (b.width > 0) setBox({ w: b.width, h: b.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [host]);

  if (!box) return null;
  const R = 18, INSET = 2;
  const w = box.w - INSET * 2, h = box.h - INSET * 2;
  if (w <= 0 || h <= 0) return null;
  const per = 2 * (w + h) - 8 * R + 2 * Math.PI * R;
  const arc = per * (value ?? 0);

  // waves only where errors were measured; cadence from the rate, log-scaled
  const f = Math.min(1, Math.max(0, Math.log10(Math.max(errPerMin, 0.05) + 1) / Math.log10(101)));
  const dur = 5.4 - f * 4.2;
  const waves = errors > 0 ? (errPerMin >= 5 ? 3 : errPerMin >= 1 ? 2 : 1) : 0;

  const common = { x: INSET, y: INSET, width: w, height: h, rx: R, fill: "none" };
  return (
    <svg className="cc-ring" width={box.w} height={box.h}
      viewBox={`0 0 ${box.w} ${box.h}`} aria-hidden="true">
      <rect {...common} className="cc-ring__track" />
      <rect {...common} className="cc-ring__arc" style={{ stroke: TVAR[tone],
        strokeDasharray: `${arc.toFixed(1)} ${per.toFixed(1)}` }} />
      {Array.from({ length: waves }, (_, i) => (
        <rect key={i} {...common} className="cc-ring__wave"
          style={{ strokeDasharray: `16 ${per.toFixed(1)}`,
            ["--per" as string]: `${per.toFixed(1)}px`,
            animationDuration: `${dur.toFixed(2)}s`,
            animationDelay: `${(-(i * dur) / waves).toFixed(2)}s` }} />
      ))}
    </svg>
  );
}

/**
 * The classic card's little chart, alive: bars grow in, staggered.
 *
 * Laid out in the DOM rather than a stretched SVG: with
 * preserveAspectRatio="none" the bars fattened into blocks as the module got
 * wider — in the tenant shell they read as a solid slab instead of a chart.
 * Fixed-width bars keep the same shape at any width.
 */
/**
 * The card's own bar chart — measured intervals, then the projection.
 *
 * The forecast bars are the same series continuing, so they share the scale:
 * drawn against a separate maximum they would have "risen" whenever the
 * forecast happened to be flatter than history. They are hollow rather than
 * filled, which is the only difference a reader needs — one is a count that
 * happened, the other is a count that has not.
 */
function Bars({ vals, times, label, tone = "info", fc }: {
  vals: number[]; times?: string[]; label?: string; tone?: Tone;
  /** The analyzer's projected intervals, drawn after the measured ones. */
  fc?: number[] | null;
}) {
  const ahead = (fc ?? []).slice(0, 8);
  // history shortens to keep the row the same width when a forecast joins it
  const keep = 24 - ahead.length;
  const last = vals.slice(-keep);
  const lastT = (times ?? []).slice(-keep);
  const max = Math.max(...last, ...ahead, 1);
  const fill = tone === "bad"
    ? "color-mix(in srgb, var(--bad) 62%, #fff)" : "rgba(255,255,255,0.85)";
  return (
    <span className="cc-bars">
      {last.map((v, i) => (
        <i key={`m${i}`} className={`cc-bar${i === last.length - 1 ? " cc-bar--live" : ""}`}
          title={`${lastT[i] ? lastT[i].slice(11, 16) + " · " : ""}${fmtN(v)}`
            + (label ? ` ${label}` : "")
            + (i === last.length - 1 ? " · still accruing" : "")}
          style={{ height: `${Math.max(7, (v / max) * 100)}%`,
            animationDelay: `${i * 36}ms`, background: fill }} />
      ))}
      {ahead.map((v, i) => (
        <i key={`f${i}`} className="cc-bar cc-bar--fc"
          title={`forecast · ${fmtN(Math.round(v))}${label ? ` ${label}` : ""}`}
          style={{ height: `${Math.max(7, (v / max) * 100)}%`,
            animationDelay: `${(last.length + i) * 36}ms`,
            ["--fcc" as string]: fill }} />
      ))}
    </span>
  );
}

/** The analyzer's own projection, drawing itself — the future arriving. */
function ForecastLine({ fc }: { fc: NonNullable<CardProps["fc"]> }) {
  const pts = fc.point.slice(0, 24);
  if (pts.length < 2) return null;
  const max = Math.max(...pts, 1);
  const d = pts.map((v, i) =>
    `${(i / (pts.length - 1)) * 100},${24 - (v / max) * 18}`).join(" ");
  return (
    <svg className="cc-fcline" viewBox="0 0 100 26" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={d} className="cc-fcline__p"
        style={{ stroke: fc.slope > 0 ? "var(--warn)" : "var(--good)" }} />
    </svg>
  );
}

function CleanCard(p: CardProps) {
  // 100% must mean NOT ONE session was hit. Plain rounding promoted 99.8% to
  // perfect, which the session stream then contradicted with a red particle —
  // the stream was right and the number was wrong.
  const pct = p.clean === null ? "…"
    : `${p.hitSessions > 0 ? Math.min(99, Math.round(p.clean * 100))
        : Math.round(p.clean * 100)}%`;
  const wrapRef = useRef<HTMLDivElement>(null);
  const coreRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const sess = p.series.map((s) => s.sessions);
  const errs = p.series.map((s) => s.errors);
  const reqs = p.series.map((s) => s.requests);
  const times = p.series.map((s) => s.t);
  const errTone: Tone = p.errors > 0 ? "bad" : "good";
  // A failure RATE, not a failure count: with 927k requests a single 4xx is
  // 0.0% — turning the box red and making it knock for that is a false alarm,
  // and a card that cries wolf is worse than one that says nothing.
  const reqRate = p.requests > 0 ? p.reqFail / p.requests : 0;
  const reqTone: Tone = reqRate >= 0.01 ? "bad" : reqRate >= 0.001 ? "warn" : "info";
  return (
    <div className="tk-mgrid cc" role="region" aria-label={`${p.name} overview card`}
      ref={wrapRef}>
      <div className="tk-col">
        <Module Icon={UserSessionsIcon} title="User experience"
          metric="sessions" active={p.detail === "sessions"} onPick={p.onMetric}
          spark={<><Bars vals={sess} times={times} label="sessions" fc={p.fcBars?.sessions} />
            <em className="tk-block__sparkv">{p.actionsPerMin}/min<br />user actions</em></>}>
          <div className="tk-row2">
            <Stat v={fmtK(p.sessions)} l="users (sessions)" />
            <Stat v={pct} l="error-free" tone={p.tone === "info" ? undefined : p.tone} />
            {/* Apdex judges SPEED. It sits beside error-free on purpose: the
                two disagree often, and an application that is fast and broken
                should have to say both out loud. */}
            <Stat v={fmtApdex(p.apdex)} l="apdex"
              tone={p.apdex === null ? undefined : apdexTone(p.apdex)} />
          </div>

          {p.apdex !== null && (() => {
            const hit = p.clean === null ? null : 1 - p.clean;
            const conflicted = p.apdex >= 0.85 && hit !== null && hit >= HIT_WARN;
            return (
              <div className="tk-apdex">
                {apdexBand(p.apdex)} · {APDEX_LABEL}
                {conflicted && (
                  <><br />speed only — errors cost no time here, so they do not lower it</>
                )}
              </div>
            );
          })()}
        </Module>
        {/* No "anomalies" in the headline: they moved to the header button
            (the reader's design), which carries the count and opens the chain
            where each one is amber on its component. The card names only what
            it shows. */}
        <Module Icon={WarningIcon}
          title={p.isMobile ? "Crashes & errors" : "Errors"}
          tone={errTone}
          pulse={p.problems > 0}
          metric="errors" active={p.detail === "errors"} onPick={p.onMetric}
          spark={<><Bars vals={errs} times={times} label="errors" fc={p.fcBars?.errors}
            tone={p.errors > 0 ? "bad" : "info"} />
            <em className="tk-block__sparkv">{p.errorsPerMin}/min<br />error rate</em></>}>
          <div className="tk-row2">
            {/* A mobile application's card leads with its FATAL failures.
                Measured on guu84124: Astroshop Android had 289 crashes and
                247 ANRs inside its error count — a crash ends the session
                where an ordinary error merely dents it, and burying both in
                "errors" hid the number that decides whether anyone ships a
                hotfix tonight. Web apps cannot crash this way, so the stat
                exists only where the types can occur. */}
            {p.isMobile && (
              <Stat v={fmtK(p.crashes)} l="crashes"
                tone={p.crashes > 0 ? "bad" : "good"} />
            )}
            <Stat v={fmtK(p.errors)} l="errors" tone={p.errors > 0 ? "bad" : undefined} />
            {/* The count that decides whether anyone should be woken up: how
                many of those errors a person actually met. Red only for those. */}
            <Stat v={p.realErrors === null ? "…" : fmtK(p.realErrors)} l="reached a user"
              tone={p.realErrors ? "bad" : "good"} />
            <Stat v={String(p.problems)} l={`active problem${p.problems === 1 ? "" : "s"}`}
              tone={p.problems > 0 ? "bad" : "good"} />
          </div>

          <div className="tk-apdex">
            {/* ANRs ride the note line rather than a fourth stat: the row
                already carries the two fatal/triage numbers, and an ANR is
                the crash's sibling — named beside it, not competing with it. */}
            {p.isMobile && p.anrs > 0 && `${fmtK(p.anrs)} ANRs — app frozen until Android killed it · `}
            {p.realErrors === 0 && p.errors > 0
              ? "none reached a real user — robot and synthetic traffic only"
              : p.errorsThird > 0
                ? `${fmtK(p.errorsThird)} from third parties · `
                  + `${fmtK(p.errors - p.errorsThird)} from this application's own code`
                : "all from this application's own code or APIs"}
          </div>
        </Module>
      </div>

      <i className="tk-gap" aria-hidden="true" />

      <div className="tk-core cc-core" ref={coreRef} style={{ ["--t" as string]: TVAR[p.tone],
        ["--breath" as string]: BREATH[p.tone] }}>
        <div className="cc-corewrap" ref={ringRef}>
        {/* The ring draws the number it surrounds. That number is the Apdex
            now, so the arc is the Apdex and its colour is the Apdex's own
            band — an arc filled by one measure and coloured by another would
            be unreadable. The breathing PACE still carries health, which is
            the error verdict, so the card keeps saying both things. */}
        <CoreRing host={ringRef} value={p.apdex} tone={apdexTone(p.apdex)}
          errPerMin={Number(p.errorsPerMin)} errors={p.errors} />
        <button className="tk-core__b" onClick={p.onOpen}
          aria-label={`${p.name} — Apdex ${fmtApdex(p.apdex)}, open its delivery chain`}>
          <i className="tk-core__ic">{p.isMobile ? <MobileIcon /> : <DesktopIcon />}</i>
          <b className="num tk-core__pct">{fmtApdex(p.apdex)}</b>
          <span className="tk-core__cap">
            apdex{p.apdex === null ? "" : ` · ${apdexBand(p.apdex)}`}</span>
          <span className="tk-core__nm">{p.name}</span>
          {/* What Davis detected, beside what we measured. Silence is stated
              too — "no problems detected" is a finding, and leaving the line
              out would make its absence indistinguishable from not looking. */}
          <span className={`tk-core__prob${p.problems > 0 ? " tk-core__prob--on" : ""}`}>
            {p.problems > 0
              ? <>{p.problems} active problem{p.problems > 1 ? "s" : ""}
                  {p.problemCats.length > 0 && ` · ${p.problemCats.slice(0, 2).join(", ")}`}</>
              : "no problems detected"}
          </span>
          <span className="tk-core__go">open the delivery chain →</span>
        </button>
        </div>
        {p.fc && (
          <div className={`tk-fc cc-fc${p.fc.slope > 0 ? " tk-fc--warn cc-fc--rising" : ""}`}>
            <div className="cc-fc__row">
              <AnalyticsIcon />
              <span>forecast ≈ {fmtK(Math.round(p.fc.total))} errors 12h
                · {p.fc.slope > 0 ? "rising ↗" : "easing ↘"}</span>
            </div>
            <ForecastLine fc={p.fc} />
          </div>
        )}
      </div>

      <i className="tk-gap" aria-hidden="true" />

      <div className="tk-col">
        <Module Icon={HttpIcon} title="Web requests"
          tone={reqTone} pulse={reqTone === "bad"}
          metric="requests" active={p.detail === "requests"} onPick={p.onMetric}
          spark={<><Bars vals={reqs} times={times} label="requests" fc={p.fcBars?.requests}
            tone={reqTone === "bad" ? "bad" : "info"} />
            {/* Read off the SERIES the bars draw, not off the headline figure —
                if the two ever disagree the card should show it rather than
                print one number twice and hide the difference. */}
            <em className="tk-block__sparkv">{fmtK(reqs.reduce((a, v) => a + v, 0))}
              <br />requests</em></>}>
          <div className="tk-row2">
            <Stat v={fmtK(p.requests)} l="web requests" />
            <Stat v={p.requests > 0
                ? `${((p.reqFail / p.requests) * 100).toFixed(1)}%` : "—"}
              l="error rate" tone={p.reqFail > 0 ? "bad" : undefined} />
          </div>
          <div className="tk-note">load p50 {fmtMs(p.loadP50)}</div>
          {p.domNames.slice(0, 2).map((n) => (
            <div key={n} className="tk-note" title={p.domNames.join("\n")}>{n}</div>
          ))}

        </Module>
        <Module Icon={ServicesIcon} title="Called services"
          metric="services" active={p.detail === "services"} onPick={p.onMetric}
          spark={p.svcSeries?.length
            ? <><Bars vals={p.svcSeries} label="service calls" fc={p.fcBars?.services} />
              <em className="tk-block__sparkv">
                {fmtK(p.svcSeries.reduce((a, v) => a + v, 0))}<br />service calls</em></>
            : undefined}>
          <div className="tk-row2">
            <Stat v={p.services === null ? "…" : String(p.services)}
              l={`service${(p.services ?? 0) === 1 ? "" : "s"}`} />
          </div>
          {p.svcNames.slice(0, 2).map((n) => (
            <div key={n} className="tk-note" title={p.svcNames.join("\n")}>{n}</div>
          ))}
          {/* Not the browser's request series relabelled: this is
              dt.service.request.count summed over the services this
              application actually calls. */}

        </Module>
      </div>

      <div className="cc-motion" aria-hidden="true">
        every motion is a measurement · ring = apdex ·
        wave = error rate · breathing pace = health · icon knock = a failing signal
        on that box · pulsing forecast = rising · bright bar = the interval still
        accruing · click a box for its breakdown
        <br />{VERDICT_LEGEND}
      </div>
    </div>
  );
}

function Stat({ v, l, tone, title }: {
  v: string; l: string; tone?: Tone; title?: string;
}) {
  return (
    <div className="tk-stat" title={title}>
      <b className="num" style={tone ? { color: TVAR[tone] } : undefined}>{v}</b>
      <span>{l}</span>
    </div>
  );
}

/**
 * The services drill-down: where each backend service is heading.
 *
 * The card's "called services" number says how many; this says which of them
 * will be busier — and which will fail more — twelve hours from now. Both
 * projections come from the metric store, so the whole panel costs analyzer
 * time and no scanned bytes. Rising volume is neutral news (capacity), rising
 * failures are not, so only the second wears a warning colour.
 *
 * A service whose forecast the analyzer rates unsound says so, and the cap is
 * stated rather than silently applied.
 */
/**
 * The breakdown behind one card, in the grammar the services panel already
 * established: a name, a bar that sizes the row against the biggest, then the
 * numbers. Which numbers depends on the card — the experience card owes
 * p50/p90/p95, the errors card owes who it reached, the requests card owes
 * failures — so one component renders three column sets rather than three
 * components repeating the same frame.
 */
function DetailPanel({ metric, rows, tf, appEntity, appName, tracedDomains,
  onClose }: {
  metric: DetailMetric; rows: DetailRow[] | null; tf: TimeframeT;
  /** The application's entity id — what the intent hand-offs are keyed on. */
  appEntity?: string;
  /** Its display name — what the Error Inspector's filter bar matches on. */
  appName: string;
  /** Domains with spans behind them: those can reach Distributed Tracing. */
  tracedDomains?: Set<string> | null;
  onClose: () => void;
}) {
  const KIND = { sessions: "views", errors: "errors", requests: "requests" } as const;
  const TITLE: Record<DetailMetric, string> = {
    sessions: "Views", errors: "Failures", requests: "Domains",
  };
  const UNIT: Record<DetailMetric, string> = {
    sessions: "actions", errors: "errors", requests: "requests",
  };
  const max = Math.max(...(rows ?? []).map((r) => r.vol), 1);

  return (
    <div className="svcf">
      <div className="mch__hd">
        <span className="mch__t">{TITLE[metric]}
          <em>· {tf.label}, busiest first</em></span>
        <span className="mch__fc">
          {rows === null ? "measuring…" : `${rows.length} shown`}
        </span>
        <button className="mch__x" onClick={onClose} aria-label="Close">✕</button>
      </div>

      {rows !== null && rows.length === 0 && (
        <div className="svcf__note">Nothing recorded for this card in this window.</div>
      )}

      <div className="svcf__rows">
        {(rows ?? []).map((r) => {
          /* ONE destination per row, chosen by what the row is evidence of.
           * Three separate cell targets meant the same line led to three
           * different screens depending on which pixel was clicked — the
           * reader had to know the map before using it. The row picks the
           * screen its own numbers argue for:
           *   a view that failed  → the errors on that view
           *   a view that did not → where its time goes
           *   a failure           → that failure, everywhere it happened
           *   a domain            → the application's vitals
           * Views drill through the app's OWN url, observed carrying two
           * conditions at once ("View Name" and Frontend). Both are needed:
           * a view name is not unique — measured, `/` exists in four of this
           * tenant's applications. */
          /* Which screen a view earns is decided by its DOMINANT signal, not
           * by whether an error exists at all. Measured on easytrade:
           *   /home            0.1% errors · 6.3% of actions over 3s · p95 3.9s
           *   /credit-card/active  0.3% errors · nothing slow
           *   /withdraw       25.5% errors · nothing slow
           * The old rule ("any error → the error page") sent the first two to
           * the Error Inspector for one stray error each, hiding the only
           * story /home actually has, which is time. An error rate earns the
           * error page at the same threshold the verdict uses for impact. */
          const errRate = r.vol > 0 ? (r.errors ?? 0) / r.vol : 0;
          const dd = metric === "sessions" && errRate >= HIT_WARN
            ? { label: "Errors on this view",
                proves: `${Math.round(errRate * 100)}% of its actions failed`,
                href: errorsExplorerHref(tf, appName, r.name) }
            : rowDrilldown(
                KIND[metric],
                { ...r, hasSpans: !!tracedDomains?.has(r.name) },
                tf, appEntity, metric === "errors" ? "fail" : "time", appName);
          /* An anchor, not a button: without an href the click died silently
           * wherever the intent bus is absent. Two kinds of target arrive
           * here — a full intent hand-off, and a plain url built from an app's
           * own address. Only the first can travel by the bus; the second has
           * no payload and goes by href alone. */
          const rowProps = dd ? {
            href: dd.href, target: "_blank", rel: "noreferrer",
            title: `${dd.label} — ${dd.proves}`,
            onClick: (e: React.MouseEvent) => {
              /* Only a REAL intent payload goes to the bus. The error rows
                 travel by url now (viaHref, payload {}), and `{}` is truthy —
                 this guard used to swallow their href and send an empty
                 intent instead, which opened the chooser with "No compatible
                 intents found". Screenshotted on the crash rows. */
              const d = dd as DeepLink;
              if (!d.viaHref && d.payload
                  && Object.keys(d.payload).length > 0 && intentsAvailable()) {
                e.preventDefault(); open(d);
              }
            },
          } : {};
          return React.createElement(dd ? "a" : "div", {
            key: r.name,
            className: `svcf__row${r.failures || r.real ? " svcf__row--warn" : ""}`
              + (dd ? " svcf__row--go" : ""),
            ...rowProps,
          }, <>
            {/* The tag lives INSIDE the name cell. As a sibling it became a
                sixth child of a five-column positional grid — every cell
                slid one column over, the name landed centred in the bar's
                track and the fatal note wrapped onto a second grid row. The
                reader saw it as "muitos espaços desnecessários", and it was
                literally the layout misaligned. */}
            <span className="svcf__nm" title={r.name}>
              {metric === "errors" && (r.type === "crash" || r.type === "anr") && (
                <b className="svcf__fatal">{r.type === "anr" ? "ANR" : "CRASH"}</b>
              )}
              {r.name}
            </span>
            <span className="svcf__bar" aria-hidden="true">
              <i style={{ width: `${(r.vol / max) * 100}%` }} />
            </span>
            <span className="svcf__v">
              {fmtK(r.vol)} <em>{UNIT[metric]}</em>
            </span>
            {metric === "errors" ? (
              <>
                <span className="svcf__tr">
                  {/* the count that decides whether this one matters */}
                  {r.real ? <b style={{ color: "var(--bad)" }}>{fmtN(r.real)} reached a user</b>
                    : <em className="dim">no real user</em>}
                </span>
                <span className="svcf__f">
                  <em className="dim">
                    {r.type === "crash" ? "fatal — the session ends here"
                      : r.type === "anr" ? "fatal — frozen until Android killed it"
                      : <>{r.third ? "third party" : "own code"}
                          {r.src ? ` · ${r.src}` : ""}</>}
                  </em>
                </span>
              </>
            ) : (
              <>
                <span className="svcf__tr">
                  p50 {fmtMs(r.p50 ?? 0)} · p90 {fmtMs(r.p90 ?? 0)}</span>
                <span className="svcf__f">
                  <b style={{ color: (r.p95 ?? 0) > 3e9 ? "var(--warn)" : "var(--ink-2)" }}>
                    p95 {fmtMs(r.p95 ?? 0)}
                  </b>
                  {metric === "requests" && r.failures !== undefined && (
                    <em style={{ marginLeft: 8, fontStyle: "normal",
                      color: r.failures > 0 ? "var(--bad)" : "var(--ink-3)" }}>
                      {r.failures > 0 ? `${fmtN(r.failures)} failed` : "no failures"}
                    </em>
                  )}
                  {metric === "sessions" && r.fru !== undefined && (
                    <em style={{ marginLeft: 8, fontStyle: "normal",
                      color: r.fru > 0 ? "var(--bad)" : r.tol ? "var(--warn)" : "var(--ink-3)" }}>
                      {r.fru ? `${fmtN(r.fru)} frustrated`
                        : r.tol ? `${fmtN(r.tol)} tolerating` : "all satisfied"}
                    </em>
                  )}
                  {/* stated, not implied: this is the number that decides
                      whether the row leads anywhere */}
                  {metric === "sessions" && (
                    <em style={{ marginLeft: 8, fontStyle: "normal",
                      color: r.errors ? "var(--bad)" : "var(--ink-3)" }}>
                      {r.errors ? `${fmtN(r.errors)} errors` : "no errors"}
                    </em>
                  )}
                </span>
              </>
            )}
          </>);
        })}
      </div>
      <div className="svcf__note">
        {metric === "errors"
          ? "one row per KIND of failure — ids in the url are collapsed, so a broken "
            + "endpoint counts once with its true weight"
          : metric === "requests"
            ? "failures come from the error records: request events on this tenant "
              + "carry only 2xx, so counting 4xx off them would always read zero"
            : `apdex bands at T = ${APDEX_T_MS / 1000}s · the bar is share of user actions`}
      </div>
    </div>
  );
}

function ServiceForecasts({ rows, vitals, total, tf, onClose }: {
  rows: ServiceAhead[]; vitals: Map<string, ServiceVitals> | null;
  total: number; tf: TimeframeT; onClose: () => void;
}) {
  if (!rows.length) return null;
  // the ones heading somewhere worse first: failures, then volume
  const sorted = [...rows].sort((a, b) => {
    const fa = a.fails && a.fails.slope > 0 ? 1 : 0;
    const fb = b.fails && b.fails.slope > 0 ? 1 : 0;
    return fb - fa || b.traces - a.traces;
  });
  const max = Math.max(...rows.map((r) => r.thr?.total ?? 0), 1);

  return (
    <div className="svcf">
      <div className="mch__hd">
        <span className="mch__t">Called services
          <em>· next 12h, from the metric store</em></span>
        <span className="mch__fc">
          {rows.length} of {total} shown{total > rows.length ? " · busiest first" : ""}
        </span>
        <button className="mch__x" onClick={onClose} aria-label="Close">✕</button>
      </div>

      <div className="svcf__rows">
        {sorted.map((r) => {
          const rising = !!r.thr && r.thr.slope > 0;
          const failRising = !!r.fails && r.fails.slope > 0;
          const v = vitals?.get(r.id);
          // measured failures, or a projection of them — either earns the
          // failure lens; neither means the failure page would open empty
          /* ONE destination, and it is the whole row — the Services Explorer
           * opened on this service. Three cells pointing at the same url only
           * looked like three different offers. The name comes from the metric
           * store's own spelling, because the Smartscape label this panel
           * renders can differ from what dt.service.name holds. */
          const svcHref = servicesExplorerHref(tf, v?.name ?? r.name);
          return (
            <a key={r.id} href={svcHref} target="_blank" rel="noreferrer"
              title={`${r.name} — open in the Services Explorer`}
              className={`svcf__row svcf__row--go${failRising ? " svcf__row--warn" : ""}`}>
              <span className="svcf__nm" title={r.name}>{r.name}</span>
              <span className="svcf__bar" aria-hidden="true">
                <i style={{ width: `${((r.thr?.total ?? 0) / max) * 100}%` }} />
              </span>
              <span className="svcf__v">
                {!r.done ? <em className="dim">measuring…</em>
                  : r.thr ? <>≈ {fmtK(Math.round(r.thr.total))} <em>requests</em></>
                  : <em className="dim">no sound forecast</em>}
                {r.thr && <em className={rising ? "svcf__tr--up" : "dim"}>
                  {" "}{rising ? "↗" : "↘"}</em>}
              </span>
              {/* Where it is now, beside where it is heading. The panel used to
                  carry only projections, which is a forecast with nothing to
                  judge it against. */}
              <span className="svcf__tr">
                {v ? <>p50 {fmtMs(v.p50)} · p90 {fmtMs(v.p90)} ·{" "}
                  <b style={{ color: v.p95 > 1e9 ? "var(--warn)" : "var(--ink-2)" }}>
                    p95 {fmtMs(v.p95)}</b></>
                  : <em className="dim">measuring…</em>}
              </span>
              <span className="svcf__f">
                {v && <b style={{ color: v.fails > 0 ? "var(--bad)" : "var(--ink-3)",
                  marginRight: 8 }}>
                  {v.fails > 0 ? `${fmtN(v.fails)} errors` : "no errors"}
                </b>}
                {r.fails
                  ? <b style={{ color: failRising ? "var(--warn)" : "var(--ink-2)" }}>
                      ≈ {fmtK(Math.round(r.fails.total))} projected {failRising ? "↗" : "↘"}
                    </b>
                  : r.done ? <em className="dim">none projected</em> : null}
              </span>
            </a>
          );
        })}
      </div>
      <div className="svcf__note">
        volume is capacity, not trouble — only rising failures are coloured ·
        projections from dt.service.request.count and its failure counterpart
      </div>
    </div>
  );
}

/**
 * One metric's history and its future, opened by clicking that number.
 *
 * A single series owns the whole chart, so no scale is ever borrowed from a
 * neighbour — the mistake that made two errors stand as tall as a hundred
 * sessions. Measured values fill the left of the "now" divider; the
 * analyzer's projection continues to the right, dashed, inside its
 * confidence band. The last bin is dropped because it is still filling: a
 * half-elapsed interval plunges to near zero and invents a crash.
 */
function MetricChart({ series, tf, metric, fc }: {
  series: Array<{ t: string; sessions: number; errors: number;
    actions: number; requests: number }>;
  tf: TimeframeT; metric: Metric; fc: Forecast | null;
}) {
  const EW = 1200, EH = 132, P = 8, TOP = 14, BOT = 116;
  const box = useRef<HTMLDivElement>(null);
  /** Which bin the pointer is over — the whole read-out follows it. */
  const [hov, setHov] = useState<number | null>(null);
  const full = series.length > 2 ? series.slice(0, -1) : series;
  const N = full.length;
  if (!N) return null;

  const val = (p: typeof full[number]) => p[metric];
  const bad = metric === "errors";
  const hue = bad ? "var(--bad)" : "var(--info)";
  const HZ = fc?.point.length ?? 0;
  const T = N + HZ;
  // the label states the MEASURED peak; the scale also has to fit the
  // forecast's upper band, and conflating the two announced a peak that never
  // happened — and a fractional one, since a projection is not a count
  const peak = Math.max(...full.map(val), 0);
  const max = Math.max(peak, ...(fc ? fc.upper : []), 1);
  const x = (i: number) => P + (i / Math.max(T - 1, 1)) * (EW - 2 * P);
  const y = (v: number) => BOT - (v / max) * (BOT - TOP);
  const nowX = x(N - 1);

  const pts = full.map((p, i) => `${x(i)},${y(val(p))}`).join(" ");
  const cont = fc
    ? [`${nowX},${y(val(full[N - 1]))}`,
        ...fc.point.map((v, i) => `${x(N + i)},${y(v)}`)].join(" ")
    : "";
  const band = fc
    ? [...fc.upper.map((v, i) => `${x(N + i)},${y(v)}`),
        ...[...fc.lower].reverse().map((v, i) =>
          `${x(N + fc.lower.length - 1 - i)},${y(v)}`)].join(" ")
    : "";

  const hhmm = (iso: string) => iso.slice(11, 16) || iso.slice(5, 10);
  // the analyzer states its own interval; without it, the chart's bin width
  const binMs = fc?.intervalMs || (tf.minutes / 34) * 6e4;
  const endT = HZ ? new Date(new Date(full[N - 1].t).getTime() + HZ * binMs) : null;
  const total = fc ? Math.round(fc.total) : 0;

  // pointer x → bin index, through the same mapping the path was drawn with
  const onMove = (e: React.MouseEvent) => {
    const r = box.current?.getBoundingClientRect();
    if (!r || r.width <= 0) return;
    const vx = ((e.clientX - r.left) / r.width) * EW;
    const i = Math.round(((vx - P) / (EW - 2 * P)) * Math.max(T - 1, 1));
    setHov(i >= 0 && i < T ? i : null);
  };

  const hv = hov === null ? null : hov < N
    ? { t: full[hov].t, v: val(full[hov]), kind: "measured" as const }
    : fc && hov - N < fc.point.length
      ? { t: new Date(new Date(full[N - 1].t).getTime() + (hov - N + 1) * binMs).toISOString(),
          v: fc.point[hov - N], kind: "forecast" as const,
          lo: fc.lower[hov - N], hi: fc.upper[hov - N] }
      : null;

  return (
    <div className="mch" style={{ ["--m" as string]: hue }}>
      <div className="mch__hd">
        <span className="mch__t">{METRIC_LABEL[metric]}
          <em>· {tf.label}, peak {fmtN(Math.round(peak))}</em></span>
        {fc && (
          <span className={`mch__fc${fc.slope > 0 ? " mch__fc--up" : ""}`}>
            forecast ≈ {fmtK(total)} next {HZ} intervals
            · {fc.slope > 0 ? "rising ↗" : "easing ↘"}
          </span>
        )}
        {!fc && <span className="mch__fc mch__fc--none">forecast not sound for this window</span>}
      </div>
      <div className="mch__plot" ref={box}
        onMouseMove={onMove} onMouseLeave={() => setHov(null)}>
      <svg viewBox={`0 0 ${EW} ${EH}`} preserveAspectRatio="none" className="mch__svg">
        <defs>
          <linearGradient id={`mch-${metric}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={hue} stopOpacity="0.34" />
            <stop offset="100%" stopColor={hue} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {HZ > 0 && <rect x={nowX} y="0" width={EW - P - nowX} height={EH}
          className="rp-ecg__future" />}
        <polygon points={`${P},${BOT} ${pts} ${nowX},${BOT}`}
          fill={`url(#mch-${metric})`} />
        {fc && <polygon points={band} className="mch__band" />}
        <polyline points={pts} className="mch__line" vectorEffect="non-scaling-stroke" />
        {fc && <polyline points={cont} className="mch__line mch__line--fc"
          vectorEffect="non-scaling-stroke" />}
        <line x1={P} x2={EW - P} y1={BOT} y2={BOT} className="rp-ecg__base" />
        {HZ > 0 && <line x1={nowX} x2={nowX} y1="0" y2={EH} className="rp-ecg__now" />}
        <circle cx={nowX} cy={y(val(full[N - 1]))} r="3.5" className="mch__beat" />
        {hv && (<>
          <line x1={x(hov!)} x2={x(hov!)} y1={TOP - 6} y2={BOT}
            className="mch__guide" />
          <circle cx={x(hov!)} cy={y(hv.v)} r="4" className="mch__hit" />
        </>)}
      </svg>
      {hv && (
        <div className="mch__tip" style={{
          left: `${((x(hov!) / EW) * 100).toFixed(2)}%`,
          // flip before the right edge so the box never leaves the chart
          transform: `translate(${x(hov!) / EW > 0.72 ? "-100%" : "0"}, 0)` }}>
          <span className="mch__tip-t">{hv.t.slice(11, 16)}</span>
          <span className="mch__tip-v">
            <i style={{ background: hue }} />
            {METRIC_LABEL[metric]} <b>{fmtN(Math.round(hv.v))}</b>
          </span>
          {hv.kind === "forecast" && (
            <span className="mch__tip-f">
              forecast · band {fmtN(Math.round(hv.lo))}–{fmtN(Math.round(hv.hi))}
            </span>
          )}
        </div>
      )}
      </div>
      <div className="rp-ecg__x">
        <span>{hhmm(full[0].t)}</span>
        <span className="rp-ecg__leg">
          <i style={{ background: hue }} /> measured
          {HZ > 0 && endT && (
            <em className="rp-ecg__fclbl">┄ forecast → {endT.toISOString().slice(11, 16)}</em>
          )}
        </span>
        <span>now {hhmm(full[N - 1].t)}</span>
      </div>
    </div>
  );
}
