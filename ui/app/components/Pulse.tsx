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
import * as Q from "../utils/dql";
import { SESSION_CHIP, chips, open as openIntent, sessionsLink } from "../utils/links";
import { useFrontendNames } from "../hooks/useFrontendNames";
import { GEO_ABS_BAD, GEO_ABS_WARN, GEO_COL, GEO_MIN_SESSIONS, GEO_WORD,
  geoArms, geoBecause, geoEnName, geoJudge, geoName,
  type GeoArm } from "../utils/geoVerdict";
import type { ChainData } from "../hooks/useChainData";
import type { Timeframe as TimeframeT } from "../utils/dql";
import { useAppForecast } from "../hooks/useForecast";
import { useImpacted } from "../hooks/useImpacted";
import { useGeo } from "../hooks/useGeo";
import { ChoroplethLayer, DotLayer, MapView } from "@dynatrace/strato-geo";
import { CENTROID } from "../utils/geoCentroids";
import { usePulse } from "../hooks/usePulse";
import { useAppScope } from "../hooks/useAppScope";
import { useMetricForecast, METRIC_LABEL, type Metric } from "../hooks/useEcgForecast";
import { useServiceForecasts, SERVICE_FORECAST_CAP,
  type ServiceAhead } from "../hooks/useServiceForecasts";
import { useServiceSeries } from "../hooks/useServiceSeries";
import { useServiceVitals, type ServiceVitals } from "../hooks/useServiceVitals";
import { aheadOf, type Forecast } from "../utils/forecast";
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

export function Pulse({ data, appId, onOpenChain, onAnalyze }: {
  data: ChainData;
  appId: string;
  onOpenChain: (hl?: "anomalies") => void;
  /** "Analyze user sessions", answered inside this app: the Journey tab. */
  onAnalyze: () => void;
}) {
  const app = data.apps.find((a) => a.appId === appId);
  const impacted = useImpacted(appId, data.tf, true);
  const geo = useGeo(data.tf, appId);
  /* The name Users & Sessions knows this app by. Its Frontends facet filters
   * on frontend.name, not the inventory name — "Astroshop Android" the
   * entity, "Astroshop_Android" the frontend — and the wrong one is accepted
   * silently and matches nothing. */
  const feNames = useFrontendNames();
  const feName = (app && (feNames?.get(app.entity ?? "") ?? app.name)) || "";
  /* The geo drill: one country opened at a time, one scan leg per first
   * click, memoised for the window like everything else. */
  const [geoSel, setGeoSel] = useState<string | null>(null);
  const [geoDetail, setGeoDetail] = useState<Array<{ view: string; sessions: number; hit: number }> | null>(null);
  const geoMemo = React.useRef(new Map<string, Array<{ view: string; sessions: number; hit: number }>>());
  useEffect(() => {
    if (!geoSel || !appId) { setGeoDetail(null); return; }
    const k = `${data.tf.from}|${data.tf.to}|${appId}|${geoSel}`;
    const hit = geoMemo.current.get(k);
    if (hit) { setGeoDetail(hit); return; }
    setGeoDetail(null);
    let live = true;
    (async () => {
      try {
        const rows = await Q.runDql<Record<string, unknown>>(Q.qGeoCountry(data.tf, appId, geoSel), 8);
        const res = rows.map((r) => ({ view: String(r.view ?? "?"),
          sessions: Number(r.sessions) || 0, hit: Number(r.hit) || 0 }));
        geoMemo.current.set(k, res);
        if (live) setGeoDetail(res);
      } catch { if (live) setGeoDetail([]); }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geoSel, appId, data.tf.from, data.tf.to]);
  useEffect(() => { setGeoSel(null); }, [appId, data.tf.from, data.tf.to]);
  useEffect(() => { setGeoViewSel(null); }, [geoSel]);
  /* The map draws into a CANVAS: ReactNode shapes do not paint and CSS cannot
   * animate there — measured, zero dots rendered. So the animated pins are an
   * HTML OVERLAY, projected with the same Web-Mercator maths the map uses and
   * kept in sync through onViewStateChange. HTML means real text labels and
   * real CSS animation, which is exactly what was asked for. */
  const [geoView, setGeoView] = useState<{ latitude: number; longitude: number; zoom: number } | null>(null);
  /* A row click FILTERS; the button at the foot is the only door out —
   * the reader asked for the hand-off to stay a deliberate act. */
  const [geoViewSel, setGeoViewSel] = useState<string | null>(null);
  /* The WHO leg: per-session characteristics for the selected country vs the
   * rest, pivoted here. Two findings families, both floored so small buckets
   * cannot pose as findings:
   *   PRESENCE  — a characteristic over-represented in the region (≥1.5×)
   *   ERROR     — inside the region, the characteristic whose sessions carry
   *               the errors (≥2× the region's own rate)              */
  const [geoWho, setGeoWho] = useState<null | {
    over: Array<{ d: string; b: string; lift: number; share: number }>;
    err: Array<{ d: string; b: string; lift: number; rate: number; n: number }>;
    regionRate: number; restRate: number;
  }>(null);
  const whoMemo = React.useRef(new Map<string, NonNullable<typeof geoWho>>());
  useEffect(() => {
    if (!geoSel || !appId) { setGeoWho(null); return; }
    const k = `${data.tf.from}|${data.tf.to}|${appId}|${geoSel}`;
    const hitM = whoMemo.current.get(k);
    if (hitM) { setGeoWho(hitM); return; }
    setGeoWho(null);
    let live = true;
    (async () => {
      try {
        const rows = await Q.runDql<Record<string, unknown>>(Q.qGeoWho(data.tf, appId, geoSel), 10000);
        const DIMS = ["os", "browser", "isp", "devtype", "conn", "osv", "browserv"] as const;
        const LABEL: Record<string, string> = { os: "os", browser: "browser", isp: "isp",
          devtype: "device", conn: "connection", osv: "os version", browserv: "browser version" };
        const inRows = rows.filter((r) => Number(r.inC) === 1);
        const outRows = rows.filter((r) => Number(r.inC) !== 1);
        const inN = inRows.length || 1, outN = outRows.length || 1;
        const regionHit = inRows.filter((r) => Number(r.hit) > 0).length;
        const regionRate = regionHit / inN;
        const restRate = outRows.filter((r) => Number(r.hit) > 0).length / outN;
        const over: Array<{ d: string; b: string; lift: number; share: number }> = [];
        const err: Array<{ d: string; b: string; lift: number; rate: number; n: number }> = [];
        for (const d of DIMS) {
          const buckets = new Set(inRows.map((r) => String(r[d] ?? "")).filter(Boolean));
          for (const b of buckets) {
            const inB = inRows.filter((r) => String(r[d] ?? "") === b);
            if (inB.length < 20) continue;
            const shIn = inB.length / inN;
            const shOut = outRows.filter((r) => String(r[d] ?? "") === b).length / outN;
            const lift = shOut > 0 ? shIn / shOut : Infinity;
            if (shIn >= 0.05 && lift >= 1.5) over.push({ d: LABEL[d], b, lift, share: shIn });
            const bHit = inB.filter((r) => Number(r.hit) > 0).length;
            const bRate = bHit / inB.length;
            const eLift = regionRate > 0 ? bRate / regionRate : 0;
            if (bHit >= 5 && eLift >= 2) err.push({ d: LABEL[d], b, lift: eLift, rate: bRate, n: inB.length });
          }
        }
        over.sort((x, y) => y.share - x.share);
        err.sort((x, y) => y.lift - x.lift);
        const res = { over: over.slice(0, 4), err: err.slice(0, 3), regionRate, restRate };
        whoMemo.current.set(k, res);
        if (live) setGeoWho(res);
      } catch { if (live) setGeoWho({ over: [], err: [], regionRate: 0, restRate: 0 }); }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geoSel, appId, data.tf.from, data.tf.to]);
  const pulse = usePulse(appId, data.tf);
  const fc = useAppForecast(appId, data.tf);
  const ux = useUxOverview(data.tf);
  const scope = useAppScope(appId, data.apps.find((a) => a.appId === appId)?.entity);
  /* The page opens on sessions. Clicking a card opens that card's evidence
   * BELOW the grid — the chart and its breakdown — and clicking the open card
   * closes it. Only what is on screen costs an analyzer run. */
  const [detail, setDetail] = useState<DetailMetric | "services" | null>("sessions");

  const mfc = useMetricForecast(appId, data.tf,
    detail && detail !== "services" ? detail : null);
  /* One projection per card, because every card now draws one. These are NOT
   * free: each runs a DQL timeseries over user.events inside the analyzer, so
   * each is a real Grail scan — and one the header's readout never sees, since
   * the app's own query path is not the one executing it. That is why history
   * is capped (forecastPlan): four cards on a thirty-day window used to ask
   * for four times ninety days. */
  const fcSessions = useMetricForecast(appId, data.tf, "sessions");
  const fcErrors = useMetricForecast(appId, data.tf, "errors");
  const fcRequests = useMetricForecast(appId, data.tf, "requests");
  /* THE HERO'S PROJECTION FOLLOWS THE SELECTED BOX. It used to be the error
   * forecast whatever was selected — so picking "sessions" left a chip talking
   * about errors beside a chart about sessions. Each box's projection is
   * already in hand, so the switch costs nothing and never blanks. Services
   * has no single series to project, so it keeps the application's errors. */
  const heroFc = detail === "sessions" ? fcSessions
    : detail === "errors" ? fcErrors
    : detail === "requests" ? fcRequests
    : detail && detail !== "services" ? mfc : fc;
  const heroMetric = detail && detail !== "services"
    ? METRIC_LABEL[detail as Metric] : "errors";

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
    (pr.entityIds ?? []).some((id) => scope.services.has(id) || scope.runtime.has(id)));
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
            // no sessions at all = nothing to rate, never "0% error-free"
            if (!d) return <>estate <b className="num">•••</b> — no sessions to rate</>;
            return <>estate <b className="num">
              {/* floored, exactly as the estate table floors it */}
              {Math.floor((1 - n / d) * 100)}%</b>{" "}
              {people ? "of real users" : ""} error-free</>;
          })() : "…"}
          {" "}· <b className="num">{data.problems.length}</b> active problems
        </span>
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
            <button className="tk-btn tk-btn--warn"
              onClick={() => onOpenChain("anomalies")}
              title={`${fmtN(anomalies)} Davis baselining anomalies on this `
                + "application's delivery scope — the chain shows each one amber "
                + "on the component it affects"}>
              {fmtN(anomalies)} anomal{anomalies === 1 ? "y" : "ies"}
            </button>
          )}
          <button className="tk-btn tk-btn--p" onClick={onAnalyze}>Analyze user sessions</button>
          <button className="tk-btn" onClick={() => onOpenChain()}>Open delivery chain</button>
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
        apdexNote={uxRow && apdexOf(uxRow) === null
          ? (uxRow.realSessions === 0 && uxRow.sessions > 0
            ? "No people to rate: every session this window is robot or synthetic traffic, and Apdex scores real users only."
            : "No rated user actions in this window.")
          : undefined}
        apdexBands={uxRow ? { sat: uxRow.satisfied, tol: uxRow.tolerating,
          fru: uxRow.frustrated, fruErr: uxRow.fruErr } : null}
        realErrors={uxRow ? uxRow.realErrors : null}
        errorsThird={uxRow?.errorsThird ?? 0}
        services={scopeCount} svcNames={svcNames} domNames={domNames}
        fc={heroFc} fcMetric={heroMetric} onOpen={() => onOpenChain()}
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

      {/* ── ACCESS AND HEALTH BY LOCATION ──
          Rebuilt to the standard of the platform's own dashboard geo tiles:
          a LARGE map framed on the data (initialViewState from the traffic's
          own bounding box), bubbles in volume buckets — shapeSize is per
          layer, so three layers make three sizes — coloured by the health
          judgement, and the ranked list beside the map as its legend. One
          scan leg (qGeo) feeds all of it. */}
      {geo && geo.length > 0 && (() => {
        const tot = geo.reduce((a, g) => a + g.sessions, 0) || 1;
        const totHit = geo.reduce((a, g) => a + g.hit, 0);
        const base = totHit / tot;
        const max = Math.max(...geo.map((g) => g.sessions), 1);
        const located = geo.filter((g) => CENTROID[g.country]);
        // frame the map on the traffic itself
        const lats = located.map((g) => CENTROID[g.country][0]);
        const lngs = located.map((g) => CENTROID[g.country][1]);
        const cLat = lats.length ? (Math.min(...lats) + Math.max(...lats)) / 2 : 20;
        const cLng = lngs.length ? (Math.min(...lngs) + Math.max(...lngs)) / 2 : 0;
        const span = lngs.length ? Math.max(Math.max(...lngs) - Math.min(...lngs), 30) : 360;
        const zoom = span > 200 ? 1.1 : span > 120 ? 1.6 : span > 60 ? 2.2 : 3;
        /* The rule itself lives in utils/geoVerdict — the board and the
         * poster judge locations too, and three copies of a threshold is
         * how screens start to argue. */
        const arms = (g: GeoArm) => geoArms(g, base);
        const judge = (g: GeoArm) => geoJudge(g, base);
        /* The reader's own semantics, stated as a rule: satisfied = green,
         * tolerating = yellow, frustrated = red. Blue was the odd one out. */
        const COL = GEO_COL;
        const WORD = GEO_WORD;
        const because = (g: GeoArm) => geoBecause(g, base);
        /* Country NAMES from the browser itself — no dataset needed, and it
         * speaks the reader's own language. City stays impossible honestly:
         * measured null on every RUM row of this tenant. */
        /* LATENCY per region: ttfb p75 from the same scan. Judged against
         * the MEDIAN country — a region 2× the median is paying for its
         * route, whatever the absolute number is. */
        const latVals = geo.filter((g) => g.ttfbMs > 0).map((g) => g.ttfbMs)
          .sort((x, y) => x - y);
        const latBase = latVals.length ? latVals[Math.floor(latVals.length / 2)] : 0;
        const latTone = (g: { ttfbMs: number }) =>
          !g.ttfbMs || !latBase ? null
          : g.ttfbMs >= latBase * 2 ? "bad" : g.ttfbMs >= latBase * 1.4 ? "warn" : "good";
        const fmtLat = (v: number) => v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`;
        /* THE FILTER GRAMMAR, copied from an OBSERVED Users & Sessions URL —
         * the one rule this app never breaks after being burned by guessed
         * grammars: the field is `Location`, not Country; the value is the
         * ENGLISH display name (Japan, "United States"), quoted only when it
         * carries spaces; `"User Type" = "Real Users"` scopes to people; and
         * `"Has Errors" = "With Errors"` narrows to the sessions worth
         * reading when the reader is chasing an error. */
        const chipQ = (v: string) =>
          /^[\w.:@/-]+$/.test(v) ? v : `"${v.replace(/["\\]/g, "")}"`;
        const enName = geoEnName;
        const nameOf = geoName;
        const dot = (g: typeof located[number]) => ({
          latitude: CENTROID[g.country][0], longitude: CENTROID[g.country][1],
          color: COL[judge(g)], country: nameOf(g.country),
          sessions: g.sessions, hitByErrors: g.hit,
        });
        /* Nine layers, because shape and shapeSize are PER LAYER: three volume
         * buckets × three health tones. The shape is a ReactNode, which is
         * what lets the map itself ANIMATE — problem countries pulse a sonar
         * ring, the busiest breathe. CSS drives it, reduced-motion respected. */
        const sizeOf = (g: typeof located[number]) =>
          g.sessions >= max * 0.45 ? 44 : g.sessions >= max * 0.12 ? 26 : 14;

        return (
          <div className="panel geo">
            <div className="panel__hd"><span className="lbl">Where they connect from</span>
              <span className="hint">sessions and health by country · {data.tf.label}</span></div>
            <div className="pad geo__wrap">
              <div className="geo__map">
                <MapView height={380}
                  initialViewState={{ latitude: cLat, longitude: cLng, zoom }}
                  onViewStateChange={(v) => setGeoView({
                    latitude: v.latitude ?? cLat, longitude: v.longitude ?? cLng,
                    zoom: v.zoom ?? zoom })}>
                  {/* a faint native layer keeps the map's own tooltip */}
                  <DotLayer shape="circle" shapeSize={6} data={located.map(dot)} />
                </MapView>
                {(() => {
                  const vs = geoView ?? { latitude: cLat, longitude: cLng, zoom };
                  const world = 512 * Math.pow(2, vs.zoom);
                  const mx = (lng: number) => ((lng + 180) / 360) * world;
                  const my = (lat: number) => {
                    const p = (lat * Math.PI) / 180;
                    return ((1 - Math.log(Math.tan(p) + 1 / Math.cos(p)) / Math.PI) / 2) * world;
                  };
                  const cx = mx(vs.longitude), cy = my(vs.latitude);
                  return (
                    <div className="geo__ov" aria-hidden="true">
                      {located.map((g) => {
                        const [la, lo] = CENTROID[g.country];
                        const sz = sizeOf(g);
                        const tone = judge(g);
                        return (
                          <button type="button" key={g.country}
                            className={`gpin gpin--${tone}${sz === 44 ? " gpin--busy" : ""}${geoSel === g.country ? " gpin--sel" : ""}`}
                            style={{ width: sz, height: sz,
                              left: `calc(50% + ${(mx(lo) - cx).toFixed(1)}px)`,
                              top: `calc(50% + ${(my(la) - cy).toFixed(1)}px)` }}
                            title={`${nameOf(g.country)} — ${WORD[tone]} · ${fmtN(g.sessions)} sessions, ${fmtN(g.hit)} met an error · ${because(g)}${g.ttfbMs ? ` · ${fmtLat(g.ttfbMs)} to first byte (p75)` : ""}`}
                            onClick={() => {
                              const opening = geoSel !== g.country;
                              setGeoSel((c) => (c === g.country ? null : g.country));
                              /* A map pin sits at the top of a tall tile; the
                               * drill it opens renders below the fold. The
                               * click carries the reader to what it opened —
                               * smooth unless they asked for reduced motion. */
                              if (opening) setTimeout(() => {
                                /* Not the drill centred — the TILE topped: the
                                 * reader framed it exactly, map and legend
                                 * above, details below, all in one screen. */
                                document.querySelector(".geo")?.scrollIntoView({
                                  behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
                                    ? "auto" : "smooth",
                                  block: "start",
                                });
                              }, 120);
                            }}>
                            {(sz >= 26 || tone !== "good") && (
                              <span className="gpin__lbl">
                                {sz === 44 ? nameOf(g.country) : g.country}
                                <em>{fmtK(g.sessions)}</em>
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  );
                })()}
              </div>
              <div className="geo__rows">
                {geo.map((g) => {
                  const a = arms(g);
                  const { rate, lift } = a;
                  const tone = judge(g);
                  /* when SPEED alone set the tone, the cell must say so — a
                   * red country with zero errors reading "clean" is the same
                   * contradiction this tile just got cured of */
                  const spdOnly = a.level > 0 && a.spd === a.level
                    && a.abs < a.level && a.rel < a.level;
                  return (
                    <button type="button"
                      className={`geo__r${geoSel === g.country ? " geo__r--on" : ""}`}
                      onClick={() => {
                        const opening = geoSel !== g.country;
                        setGeoSel((c) => (c === g.country ? null : g.country));
                        if (opening) setTimeout(() => {
                          document.querySelector(".geo")?.scrollIntoView({
                            behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
                              ? "auto" : "smooth",
                            block: "start",
                          });
                        }, 120);
                      }}
                      key={g.country}
                      title={`${fmtN(g.sessions)} sessions from ${g.country} — ${fmtN(g.hit)} met an error (${(rate * 100).toFixed(1)}%, application average ${(base * 100).toFixed(1)}%) · ${WORD[tone]}: ${because(g)}`}>
                      <i className="geo__dot" style={{ background: COL[tone] }} />
                      <b className="geo__cc">{g.country}</b>
                      <span className="geo__nm">{nameOf(g.country)}</span>
                      <span className="geo__t">
                        <i className="geo__b" style={{ width: `${(g.sessions / max) * 100}%`,
                          background: `color-mix(in srgb, ${COL[tone]} 55%, transparent)` }} />
                      </span>
                      <span className="num geo__n">{fmtN(g.sessions)}</span>
                      {/* the multiplier only when deviation IS the finding —
                          same substance gate as judge(): a red country at
                          1.0× the app reads its own rate, and one errored
                          session in hundreds never gets to claim "2.8×" */}
                      <em className={`geo__h geo__h--${tone}`}>
                        {spdOnly ? `Apdex ${a.apx!.toFixed(2)}`
                          : g.hit === 0 ? "clean"
                          : lift >= 1.15 && g.hit >= 5 && rate >= 0.02
                            ? `${lift.toFixed(1)}× the app`
                          : `${(rate * 100).toFixed(1)}% hit`}
                      </em>
                      <em className={`geo__lat${latTone(g) ? ` geo__lat--${latTone(g)}` : ""}`}
                        title={g.ttfbMs ? `first byte p75 for ${nameOf(g.country)} — the network route's own cost; median country here: ${fmtLat(latBase)}` : "no timed views from here"}>
                        {g.ttfbMs ? fmtLat(g.ttfbMs) : "—"}
                      </em>
                    </button>
                  );
                })}
                {/* the traffic light's own rulebook, always on screen — the
                    verdict never asks to be taken on faith */}
                <span className="geo__rule"
                  title={`Errors: share of a country's sessions that met at least one — this app's average this window: ${(base * 100).toFixed(1)}%; the deviation arm needs ≥30 sessions, 5 errored, 2% hit before it speaks. Slowness: duration-only Apdex over the country's user actions, T = 3s — under 0.85 tolerating, under 0.50 frustrated (≥30 rated actions). Worst arm wins; each pin's tooltip names the arm that fired.`}>
                  <i style={{ background: COL.bad }} /> ≥25% hit · <i style={{ background: COL.warn }} /> ≥10% ·
                  <i style={{ background: COL.good }} /> below — or 1.5× / 1.15× the app&apos;s average · slow: Apdex &lt;0.85 / &lt;0.50
                </span>
              </div>
            </div>
            {/* THE DRILL: what this country does here — its screens, and where
                it meets errors — plus the hand-off to the platform's own
                session analysis, already filtered to the country. */}
            {geoSel && (
              <div className="pad geo__drill">
                <div className="geo__drill-hd">
                  <b>{nameOf(geoSel)} · {geoSel}</b>
                  <span>{geoDetail === null ? "reading this country's sessions…"
                    : `top screens · ${data.tf.label}`}</span>
                  <button className="geo__drill-x" onClick={() => setGeoSel(null)}>✕</button>
                </div>
                {geoDetail && geoDetail.length > 0 && (() => {
                  const dmax = Math.max(...geoDetail.map((d) => d.sessions), 1);
                  /* The drill speaks the same traffic light as the map: each
                   * screen judged against the COUNTRY's own error rate —
                   * green satisfied, yellow tolerating, red where the errors
                   * concentrate (≥2× the country). Bar and word carry the
                   * same colour, so the eye needs no second read. */
                  const cTot = geoDetail.reduce((a, d) => a + d.sessions, 0) || 1;
                  const cRate = geoDetail.reduce((a, d) => a + d.hit, 0) / cTot;
                  /* THE MAP'S OWN FLOORS, imported — this drill once had a
                   * fourth rule (any hit = tolerating, no substance gates)
                   * that called one error in a thousand "tolerating" while
                   * the legend above said tolerating starts at 10%. */
                  const toneOf = (d: { sessions: number; hit: number }) => {
                    const r = d.hit / Math.max(d.sessions, 1);
                    if (d.sessions >= GEO_MIN_SESSIONS
                      && ((cRate > 0 && r >= cRate * 2) || r >= GEO_ABS_BAD)) return "bad";
                    if (d.sessions >= GEO_MIN_SESSIONS && r >= GEO_ABS_WARN) return "warn";
                    return "good";
                  };
                  const BAR = GEO_COL;
                  return (
                    <div className="geo__drill-rows">
                      {geoDetail.map((d) => {
                        const t = toneOf(d);
                        const noScreen = d.view === Q.NO_SCREEN;
                        return (
                          <button type="button"
                            className={`geo__dr geo__dr--btn${geoViewSel === d.view ? " geo__dr--on" : ""}`}
                            key={d.view}
                            onClick={() => setGeoViewSel((v) => (v === d.view ? null : d.view))}
                            title={noScreen
                              ? `${fmtN(d.hit)} ${geoSel} sessions met an error that belongs to no screen — app-level failures like ANR (the app frozen until the OS kills it). They count in the country's total, and a session opened from the list below may carry one of these instead of a screen's error.`
                              : `${fmtN(d.sessions)} sessions from ${geoSel} on ${d.view}${d.hit ? ` — ${fmtN(d.hit)} met an error (${((d.hit / Math.max(d.sessions, 1)) * 100).toFixed(1)}% vs ${(cRate * 100).toFixed(1)}% for the country)` : ""}. Click to set this screen as the filter — the button below opens the sessions.`}>
                            <span className="geo__dr-v">{d.view}</span>
                            <span className="geo__t"><i className="geo__b"
                              style={{ width: `${(d.sessions / dmax) * 100}%`,
                                background: `color-mix(in srgb, ${BAR[t]} 55%, transparent)` }} /></span>
                            <b className="num">{fmtN(d.sessions)}</b>
                            <em className={`geo__h geo__h--${t}`}>
                              {d.hit === 0 ? GEO_WORD.good
                                : `${fmtN(d.hit)} hit · ${GEO_WORD[t]}`}</em>
                          </button>
                        );
                      })}
                    </div>
                  );
                })()}
                {geoDetail && geoDetail.length === 0 && (
                  <span className="geo__drill-none">no screens recorded for this country in the window</span>
                )}
                {/* WHAT SETS THIS REGION APART — presence lifts vs the rest,
                    and inside the region, the characteristic that carries the
                    errors. This is the question the map exists to raise: a red
                    country is a WHERE; this is the WHAT. */}
                {geoWho && (geoWho.over.length > 0 || geoWho.err.length > 0 || geoWho.regionRate > 0) && (
                  <div className="geo__who">
                    {geoWho.err.length > 0 ? (
                      <div className="geo__who-g geo__who-g--bad">
                        <span className="geo__who-l geo__who-l--bad">inside {geoSel}, the errors ride on</span>
                        {geoWho.err.map((x) => {
                          const facet = x.d === "browser" ? SESSION_CHIP.browser(x.b)
                            : x.d === "os" ? SESSION_CHIP.osName(x.b)
                            : x.d === "device" ? SESSION_CHIP.deviceType(x.b)
                            : x.d === "isp" ? SESSION_CHIP.clientIsp(x.b)
                            : x.d === "browser version" ? SESSION_CHIP.browserVersion(x.b)
                            : x.d === "os version" ? SESSION_CHIP.osVersion(x.b) : null;
                          return facet ? (
                          <button type="button" className="geo__who-r geo__who-r--go" key={`${x.d}${x.b}`}
                            onClick={() => app && openIntent(sessionsLink(data.tf, feName, x.n,
                              chips(SESSION_CHIP.location(enName(geoSel!)), SESSION_CHIP.realUsers(),
                                facet, SESSION_CHIP.withErrors()),
                              `${geoSel} · ${x.b} sessions with errors`))}
                            title={`${fmtN(x.n)} ${geoSel} sessions on ${x.b} — ${(x.rate * 100).toFixed(1)}% met an error, against ${(geoWho.regionRate * 100).toFixed(1)}% for ${geoSel} overall. Click: these sessions, WITH errors, in Users & Sessions.`}>
                            <b>{x.b}</b><em>{x.d}</em>
                            <i className="geo__who-x">{x.lift.toFixed(1)}× the region&apos;s own rate</i>
                          </button>
                          ) : (
                          <span className="geo__who-r" key={`${x.d}${x.b}`}
                            title={`${x.b} — no session facet exists for ${x.d} in Users & Sessions, so this one cannot be clicked through`}>
                            <b>{x.b}</b><em>{x.d}</em>
                            <i className="geo__who-x">{x.lift.toFixed(1)}× the region&apos;s own rate</i>
                          </span>
                          );
                        })}
                      </div>
                    ) : geoWho.regionRate > 0 && (
                      <span className="geo__who-none">
                        <b>Nothing local stands out.</b> Errors in {geoSel} spread evenly across
                        devices, browsers and carriers — which points at the route to the region,
                        not at who is in it.
                      </span>
                    )}
                    {geoWho.over.length > 0 && (
                      <div className="geo__who-g">
                        <span className="geo__who-l">what makes {geoSel} different</span>
                        {geoWho.over.map((x) => {
                          const facet = x.d === "browser" ? SESSION_CHIP.browser(x.b)
                            : x.d === "os" ? SESSION_CHIP.osName(x.b)
                            : x.d === "device" ? SESSION_CHIP.deviceType(x.b)
                            : x.d === "isp" ? SESSION_CHIP.clientIsp(x.b)
                            : x.d === "browser version" ? SESSION_CHIP.browserVersion(x.b)
                            : x.d === "os version" ? SESSION_CHIP.osVersion(x.b) : null;
                          const Tag = facet ? "button" : "span";
                          return (
                            <Tag {...(facet ? { type: "button" as const,
                                onClick: () => app && openIntent(sessionsLink(data.tf, feName, 0,
                                  chips(SESSION_CHIP.location(enName(geoSel!)),
                                    SESSION_CHIP.realUsers(), facet),
                                  `${geoSel} · ${x.b} sessions`)) } : {})}
                              className={`geo__who-r${facet ? " geo__who-r--go" : ""}`}
                              key={`${x.d}${x.b}`}
                              title={`${(x.share * 100).toFixed(0)}% of ${geoSel}'s sessions are on ${x.b} — ${x.lift === Infinity ? "seen nowhere else" : `${x.lift.toFixed(1)}× everyone else`}${facet ? ". Click: these sessions in Users & Sessions." : ""}`}>
                              <b>{x.b}</b><em>{x.d}</em>
                              <i>{x.lift === Infinity ? "only here" : `${x.lift.toFixed(1)}×`}</i>
                            </Tag>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
                {app && (() => {
                  const selRow = geoViewSel
                    ? geoDetail?.find((d) => d.view === geoViewSel) : undefined;
                  const chasing = !!selRow && selRow.hit > 0;
                  const realScreen = !!geoViewSel && geoViewSel !== Q.NO_SCREEN;
                  return (<>
                  <button className="geo__drill-go"
                    title={chasing && realScreen
                      ? `The Sessions bar has no screen facet, so this opens EVERY ${geoSel} session that met an error — the ${geoViewSel} ones among them, but also app-level failures like ANR. For the screen alone, use the red button.`
                      : undefined}
                    onClick={() => {
                      /* "View Name" is NOT a Sessions facet — it belongs to
                       * the Error Inspector's bar. Sent here it poisoned the
                       * whole segment (the reader's screenshot arrived with
                       * only Frontends applied). And because the chips cannot
                       * carry the screen, the LABEL must not promise it — a
                       * reader sent to "Product detail sessions" landed on an
                       * ANR session and rightly asked where the screen went. */
                      const chip = chips(
                        SESSION_CHIP.location(enName(geoSel)),
                        SESSION_CHIP.realUsers(),
                        chasing ? SESSION_CHIP.withErrors() : null,
                      );
                      const n = geo.find((g) => g.country === geoSel)?.sessions ?? 0;
                      openIntent(sessionsLink(data.tf, feName, n, chip,
                        chasing ? `${geoSel} sessions with errors` : `Analyze ${geoSel} sessions`));
                    }}>
                    analyze {geoSel} sessions{chasing ? " with errors" : ""} in Users &amp; Sessions →
                  </button>
                  {/* The screen itself is filterable only in the ERROR
                    * INSPECTOR — its bar takes "View Name" and the inventory
                    * app name, both observed (see errorsExplorerHref). So a
                    * frustrated screen gets a second door: its errors, each
                    * one opening the session that met it. The Sessions bar
                    * cannot say "this screen"; this bar can. The no-screen
                    * row gets no door: its errors belong to no view, so a
                    * View Name filter would return nothing. */}
                  {chasing && realScreen && (
                    <a className="geo__drill-go geo__drill-go--err"
                      href={errorsExplorerHref(data.tf, app.name, geoViewSel!)}
                      target="_blank" rel="noreferrer"
                      title={`${fmtN(selRow!.hit)} ${geoSel} sessions met an error on ${geoViewSel} — the Error Inspector filters by screen (the Sessions list cannot), and every error there opens its session. The screen filter is exact; the country is not carried, so expect all frontends' hits on this view.`}>
                      inspect {geoViewSel} errors in Error Inspector →
                    </a>
                  )}
                  </>);
                })()}
              </div>
            )}
          </div>
        );
      })()}
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
  /** Why the score is absent, when it is — "•••" alone made a robot-only
   *  application on the dev tenant read as a rendering bug. */
  apdexNote?: string;
  /** The bands behind it — what the words under the score are built from. */
  apdexBands: { sat: number; tol: number; fru: number; fruErr: number } | null;
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
  fc: Forecast | null;
  /** What the projection is OF — the selected box's metric, in words. */
  fcMetric: string;
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
    ? "color-mix(in srgb, var(--bad) 62%, var(--ink-hi))" : "color-mix(in srgb, var(--ink-hi) 85%, transparent)";
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
            <Stat v={fmtK(p.sessions)} l="sessions"
              title="All sessions in the window — robots and synthetic included; the error-free figure beside it uses the same base" />
            <Stat v={pct} l="error-free" tone={p.tone === "info" ? undefined : p.tone} />
            {/* Apdex judges SPEED. It sits beside error-free on purpose: the
                two disagree often, and an application that is fast and broken
                should have to say both out loud. */}
            <Stat v={fmtApdex(p.apdex)} l="apdex"
              tone={p.apdex === null ? undefined : apdexTone(p.apdex)}
              title={p.apdex === null ? p.apdexNote : undefined} />
          </div>

          {p.apdex !== null && (() => {
            const hit = p.clean === null ? null : 1 - p.clean;
            const conflicted = p.apdex >= 0.85 && hit !== null && hit >= HIT_WARN;
            return (
              <div className="tk-apdex">
                {apdexBand(p.apdex)} · {APDEX_LABEL}
                {conflicted && (
                  <><br />errored views frustrate their own actions (Dynatrace&apos;s rule);
                    errors outside any rated action still cost no time</>
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
          {/* The WORD leads — "Good" reads instantly where 0.92 needs a
              scale; the number moves to the caption for whoever audits it. */}
          <b className="num tk-core__pct tk-core__pct--word">
            {p.apdex === null ? "…" : apdexBand(p.apdex)}</b>
          <span className="tk-core__cap">
            apdex{p.apdex === null ? "" : ` ${fmtApdex(p.apdex)}`}</span>
          {/* The score, translated: what happens in every 100 things users
              do — built from the same bands the number is, so the words and
              the figure cannot disagree. Slowness and errors are named
              separately because they are fixed by different people. */}
          {p.apdexBands && (() => {
            const { sat, tol, fru, fruErr } = p.apdexBands;
            const rated = sat + tol + fru;
            if (!rated) return null;
            const per = (v: number) => Math.round((v / rated) * 100);
            const slow = per(fru - fruErr) + per(tol);
            const err = per(fruErr);
            const fine = Math.max(0, 100 - slow - err);
            return (
              <span className="tk-core__words">
                of every 100 things users do here, ~{fine} feel fine
                {slow > 0 && <> · {slow} drag{err > 0 ? "" : " — speed, not errors"}</>}
                {err > 0 && <> · {err} ruined by errors</>}
              </span>
            );
          })()}
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
              <span title={`Projected by the platform's own analyzer over this application's
error series, read at the same width the window is drawn in.`}>
                forecast ≈ {fmtK(Math.round(p.fc.total))} {p.fcMetric} next {aheadOf(p.fc)}{" "}
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
              l="calls failed" tone={p.reqFail > 0 ? "bad" : undefined} />
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
                  {/* amber at the platform's own satisfaction threshold T
                      (3s) — the view panel above ambers there, and 1s made
                      the same latency two colours on one screen */}
                  <b style={{ color: v.p95 > 3e9 ? "var(--warn)" : "var(--ink-2)" }}>
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
            forecast ≈ {fmtK(total)} next {aheadOf(fc)}{" "}
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
