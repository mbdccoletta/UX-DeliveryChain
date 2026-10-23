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
import { fmtK, fmtMs, fmtN, NO_SCREEN, withinSessionLag } from "../utils/dql";
import * as Q from "../utils/dql";
import { SESSION_CHIP, chips, open as openIntent, sessionsLink } from "../utils/links";
import { useFrontendNames } from "../hooks/useFrontendNames";
import { geoCol, geoJudgeSub, geoPop, GEO_MIN_SESSIONS, GEO_WORD,
  geoArms, geoBecause, geoEnName, geoJudge, geoName,
  type GeoArm, type GeoTone } from "../utils/geoVerdict";
import type { ChainData } from "../hooks/useChainData";
import type { Timeframe as TimeframeT } from "../utils/dql";
import { useAppForecast } from "../hooks/useForecast";
import { useImpacted, type Impacted } from "../hooks/useImpacted";
import { useAppVitals } from "../hooks/useAppVitals";
import { useGeo } from "../hooks/useGeo";
import { useCities, useRegions } from "../hooks/useGeoDetail";
import { Intelligence } from "./Intelligence";
import { OVERVIEW_STARTERS } from "../utils/starters";
import { ChoroplethLayer, DotLayer, MapView,
  type MapViewRef } from "@dynatrace/strato-geo";
import { CENTROID, REGION_CENTROID as BR_REGIONS,
  REGION_CENTROID_MORE } from "../utils/geoCentroids";

/* One table, two files: Brazil was written first and the rest followed, and
   a caller should not have to know which country lives where. */
const REGION_CENTROID: Record<string, [number, number]> =
  { ...BR_REGIONS, ...REGION_CENTROID_MORE };
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
import { XmarkIcon,
  AnalyticsIcon, DesktopIcon, HttpIcon,
  MobileIcon, ServicesIcon, UserSessionsIcon, WarningIcon,
} from "@dynatrace/strato-icons";

import { verdictOf, VERDICT_LEGEND, HIT_BAD, HIT_WARN, davisCategory,
  type Tone, failTone} from "../utils/verdict";
import { errorsExplorerHref, servicesExplorerHref, viewVitalsHref, rowDrilldown, open,
  intentsAvailable, appEntityOf } from "../utils/links";
import type { DeepLink } from "../utils/links";
import { apdexOf, apdexBand, apdexTone, fmtApdex, scoreExplain, scoreMix } from "../utils/apdex";
import { useCardDetail, type DetailRow, type DetailMetric } from "../hooks/useCardDetail";
import { useDomainTraces } from "../hooks/useDomainTraces";


/** "BR-SP" → "SP". The map pin is already standing on the country. */
const uf = (id: string) => (id.includes("-") ? id.split("-").pop() ?? id : id);

const TVAR: Record<Tone, string> = {
  good: "var(--good)", warn: "var(--warn)", bad: "var(--bad)", info: "var(--info)",
};
/* THE VIVID HALF OF THE SAME PALETTE. Strato ships each status in two
 * strengths: a TEXT colour, tuned to be read as words, and a CONTAINER ACCENT
 * — the saturated member of the family, meant for solid marks. Borders, rings
 * and icons were reading the text one, which is why the page looked washed
 * beside the platform's own screens. Text keeps TVAR; everything that is a
 * mark rather than a sentence takes this. "info" is not a verdict and stays
 * neutral, by the rule that an unjudged box may not look judged. */
const FVAR: Record<Tone, string> = {
  good: "var(--good-fill)", warn: "var(--warn-fill)", bad: "var(--bad-fill)",
  info: "var(--border-2)",
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

/** The map's height. 380px left it a strip under a tall legend; the tile is
 *  the one place on this page where SPACE is the information. */
/* THE MAP TAKES THE ROOM IT HAS.
 *
 * 520px was a fixed number chosen on a laptop. On a wide monitor the tile is
 * nearly twice that tall, so the map sat in the upper half of its own panel
 * with a country drawn small inside a large empty frame. MapView wants a
 * number, not a CSS length, so the number is measured from the viewport and
 * kept between a floor that still shows a country and a ceiling that does not
 * push the table below the fold. */
const MAP_H_MIN = 420, MAP_H_MAX = 1200;
const mapHeight = () => {
  const h = typeof window === "undefined" ? 760 : window.innerHeight;
  return Math.round(Math.max(MAP_H_MIN, Math.min(MAP_H_MAX, h * 0.72)));
};

export function Pulse({ data, appId, onOpenChain, onAnalyze }: {
  data: ChainData;
  appId: string;
  onOpenChain: (hl?: "anomalies") => void;
  /** "Analyze user sessions", answered inside this app: the Journey tab. */
  onAnalyze: () => void;
}) {
  const app = data.apps.find((a) => a.appId === appId);
  /* The name Users & Sessions knows this app by. Its Frontends facet filters
   * on frontend.name, not the inventory name — "Astroshop Android" the
   * entity, "Astroshop_Android" the frontend — and the wrong one is accepted
   * silently and matches nothing. */
  const feNames = useFrontendNames(data.tf.minutes);
  /* the RESOLVED frontend name, or "" — callers gate their sessions links
   * on it, because the inventory-name fallback re-created the documented
   * empty-list failure while the name scan was still in flight */
  const feName = (app && feNames?.get(app.entity ?? "")) || "";
  /* RESOLVED FIRST, BECAUSE IT DECIDES THE MEASURE. The name is what lets
     the impact scan read the session store instead of the event store, so
     the card counts what its own button opens. */
  /* ONE PER-SESSION SCAN, NOT TWO. Inside the session store's lag (the
     default hour) the impact had a per-session scan of user.events of its
     own — the same window, the same sessions, the same counts the UX scan
     (qUxByApp) already produces: 95 GB twice on a bank's estate, the two
     competing for Grail. There the impact is read from the UX scan; past
     the lag, the session store answers as before. */
  const lag = withinSessionLag(data.tf);
  const impactedScan = useImpacted(appId, data.tf, !lag, feName || undefined);
  /* THE METRIC STORE ANSWERS FIRST. Pre-aggregated counts for this frontend
     — errors, crashes, ANRs, requests, actions — in milliseconds and for no
     Grail bytes. They hold the card up while the event scans that decide
     the final figures are still running; once those land, measured wins.
     Null when this environment does not publish them, in which case nothing
     below changes. */
  const vitals = useAppVitals(data.tf, feName || null);
  /* While the page is on preview figures, a metric is the better early
     number: a preview is a partial scan and can only be LOW, a metric is the
     whole window. Once the measurement is final, it is the measurement. */
  const early = <T,>(metric: T | null | undefined, measured: T): T =>
    data.partial && metric != null ? metric : measured;
  /* The map's rows carry their own experience score now (qGeo) — no merge,
     and no waiting on any other scan: the map is final when its scan is. */
  const geo = useGeo(data.tf, appId);
  const ux = useUxOverview(data.tf, appId);
  const uxSelf = ux?.get(appId);
  /* WHO WAS HURT — sessions an error AFFECTED (utils/dql USER_HIT: an error
     during the person's own action, or the app crashing/freezing), from the
     one per-session scan. This alone judges: the verdict, error-free and the
     lines the Intelligence facts quote. */
  const harm: Impacted | null = uxSelf
    ? { sessions: uxSelf.sessions, hit: uxSelf.hit,
        realSessions: uxSelf.realSessions, hitReal: uxSelf.hitReal,
        hitRobot: uxSelf.hitRobot, hitSynth: uxSelf.hitSynth,
        partial: !!ux?.partial, base: "events" }
    : null;
  /* HOW MANY — the session headline keeps the store Users & Sessions lists
     once the window is past its lag, so the card and its button agree. */
  const impacted: Impacted | null = !lag ? impactedScan : harm;
  /* a state's experience score comes with its row (qGeoRegions) */
  const regionArm = (r: { sessions: number; hit: number; realSessions?: number; realHit?: number;
    sat?: number; tol?: number; fru?: number }) => r;
  /* The geo drill: one country opened at a time, one scan leg per first
   * click, memoised for the window like everything else. */
  const [geoSel, setGeoSel] = useState<string | null>(null);
  /** The geo table starts short: the rows that matter are the first ones. */
  const [geoAll, setGeoAll] = useState(false);
  const GEO_CAP = 8;
  /* The cap never hides the row the reader is standing on: a selected country
     that fell past it is kept, and its states are shown in full, because the
     states only exist on screen BECAUSE that country was opened. */
  const shownGeo = React.useMemo(() => {
    const all = geo ?? [];
    if (geoAll || all.length <= GEO_CAP) return all;
    const head = all.slice(0, GEO_CAP);
    const sel = geoSel && !head.some((g) => g.country === geoSel)
      ? all.find((g) => g.country === geoSel) : null;
    return sel ? [...head, sel] : head;
  }, [geo, geoAll, geoSel]);

  /** The state opened inside the selected country — its cities follow. */
  const [regionSel, setRegionSel] = useState<string | null>(null);
  /* Asked only once a country is open — the map's first level is one scan,
   * and these cost another only if a reader goes looking. */
  const regions = useRegions(data.tf, geoSel ? appId : null, geoSel);
  const shownRegions = React.useMemo(() => {
    const all = regions ?? [];
    return geoAll || all.length <= GEO_CAP ? all : all.slice(0, GEO_CAP);
  }, [regions, geoAll]);
  const geoHidden = Math.max(0, (geo?.length ?? 0) - shownGeo.length)
    + Math.max(0, (regions?.length ?? 0) - shownRegions.length);
  const cities = useCities(data.tf, regionSel ? appId : null, geoSel,
    regionSel ? regionSel.slice((geoSel ?? "").length + 1) : null);
  type ScreenRows = Array<{ view: string; sessions: number; hit: number }> & { partial?: boolean };
  const [geoDetail, setGeoDetail] = useState<ScreenRows | null>(null);
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
        const shape = (rows: Record<string, unknown>[]): ScreenRows => rows.map((r) => ({
          view: String(r.view ?? "?"),
          sessions: Number(r.sessions) || 0, hit: Number(r.hit) || 0 }));
        /* previews paint, the final decides — see usePlaces for the why */
        const rows = await Q.runDql<Record<string, unknown>>(
          Q.qGeoCountry(data.tf, appId, geoSel), 8, undefined, (early) => {
            if (!live || !early.length) return;
            const pv = shape(early); pv.partial = true; setGeoDetail(pv);
          });
        const res = shape(rows);
        geoMemo.current.set(k, res);
        if (live) setGeoDetail(res);
      } catch { if (live) setGeoDetail([]); }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geoSel, appId, data.tf.from, data.tf.to]);
  /* THE SAME LIST, ONE LEVEL DOWN. Opening a state changed the cities and
   * nothing else — the screens below went on describing the whole country,
   * so clicking an amber state showed a list in which that state's traffic
   * was a rounding error, and the click looked like it had found nothing.
   * One leg, asked only when a state is actually opened. */
  const [regionDetail, setRegionDetail] = useState<ScreenRows | null>(null);
  const regionMemo = React.useRef(new Map<string,
    Array<{ view: string; sessions: number; hit: number }>>());
  useEffect(() => {
    if (!geoSel || !regionSel || !appId) { setRegionDetail(null); return; }
    const uf = regionSel.slice(geoSel.length + 1);
    const k = `${data.tf.from}|${data.tf.to}|${appId}|${regionSel}`;
    const hit = regionMemo.current.get(k);
    if (hit) { setRegionDetail(hit); return; }
    setRegionDetail(null);
    let live = true;
    (async () => {
      try {
        const shape = (rows: Record<string, unknown>[]): ScreenRows => rows.map((r) => ({
          view: String(r.view ?? "?"),
          sessions: Number(r.sessions) || 0, hit: Number(r.hit) || 0 }));
        const rows = await Q.runDql<Record<string, unknown>>(
          Q.qGeoRegion(data.tf, appId, geoSel, uf), 8, undefined, (early) => {
            if (!live || !early.length) return;
            const pv = shape(early); pv.partial = true; setRegionDetail(pv);
          });
        const res = shape(rows);
        regionMemo.current.set(k, res);
        if (live) setRegionDetail(res);
      } catch { if (live) setRegionDetail([]); }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geoSel, regionSel, appId, data.tf.from, data.tf.to]);
  /* WHERE THE MAP STARTS, once per estate.
   * The view the reader has panned to lives in geoView; this is what the map
   * opens on before they touch it, computed from the traffic. It is captured
   * the first time there is real data to frame so that a refresh of the same
   * application never yanks the view back, and cleared when the application
   * or the timeframe changes, because a frame describes an estate. */
  const geoFrame = useRef<{ latitude: number; longitude: number; zoom: number } | null>(null);
  /* MAKING THE MAP SPEAK.
   * Three builds assumed MapView would adopt a view we handed it — as
   * initialViewState, then as a keyed remount, then as controlled
   * latitude/longitude/zoom. It adopted none of them, and it reported
   * nothing, so the overlay projected against a frame the map had never
   * taken and the heaviest country sat in the Atlantic until the reader
   * zoomed and the map finally emitted a real view.
   * The one thing it does do is zoomToFit(), from its own ref: it frames the
   * layers' data and, in doing so, emits. So we stop telling the map where to
   * be and ask it where it IS. Nothing is drawn over the map until it has
   * answered — a mark we cannot place correctly is worse than no mark.
   * Two calls because the first can land before the style is ready, and a
   * zoom in/out round trip as the last resort, which has to move the view
   * twice and therefore has to report. */
  const mapRef = useRef<MapViewRef>(null);
  /* Re-measured on resize, and the map is asked to re-frame itself after:
     zoomToFit is the only lever this component answers to, so a new height
     without a new fit would stretch the old framing rather than use it. */
  const [mapH, setMapH] = useState(mapHeight);
  /* THE MAP IS AS TALL AS THE LIST BESIDE IT.
     The viewport was the wrong thing to measure: the two sit side by side and
     the list is what decides how much room the tile actually occupies, so a
     map sized from the window ended half way down a list of forty rows. The
     list is observed instead — collapse it and the map follows it up, expand
     it and the map grows with it — with a floor that still shows a country
     and a ceiling that keeps one screen's worth of map. */
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = listRef.current;
    const fromList = () => {
      const h = el ? el.getBoundingClientRect().height : 0;
      return Math.round(Math.max(MAP_H_MIN, Math.min(MAP_H_MAX, h || mapHeight())));
    };
    const on = () => setMapH((prev) => {
      const h = fromList();
      return Math.abs(prev - h) < 8 ? prev : h;
    });
    on();
    const ro = el && typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(on) : null;
    if (el && ro) ro.observe(el);
    window.addEventListener("resize", on);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", on);
    };
  }, [geoAll, geoSel]);
  /* RE-FIT WHEN THE DATA ARRIVES, NOT ONLY WHEN THE BOX CHANGES.
   *
   * Measured on production: the geo scan answered at about t+96s, a minute
   * and a half after this component mounted. Every zoomToFit had already run
   * and found empty layers, so the map sat there framing nothing — and since
   * MapView emits no view until it is touched, the overlay had nothing to
   * project against either. The first mouse movement over the map made it
   * report, and everything appeared at once. The reader described it exactly:
   * "o mapa só carrega ao movimentar o mouse".
   *
   * So the fit follows the DATA. Two attempts, because the first can land
   * before the layer has taken its rows. */
  const geoCount = geo?.length ?? 0;
  useEffect(() => {
    const fire = () => { try { mapRef.current?.zoomToFit(); } catch { /* not mounted */ } };
    const a = setTimeout(fire, 120);
    const b = setTimeout(fire, 700);
    return () => { clearTimeout(a); clearTimeout(b); };
  }, [mapH, geoCount, geoSel]);
  const reported = useRef(false);
  const geoSig = (geo ?? []).map((g) => g.country).join(",");
  useEffect(() => {
    if (!geo || geo.length === 0) return;
    reported.current = false;
    /* WE ASK UNTIL IT ANSWERS.
     *
     * The overlay refuses to draw against a view the map has not confirmed —
     * that rule is right and it is what stopped the marks landing in the
     * Atlantic. The problem is the other half: MapView emits nothing until
     * something actually MOVES it, and a single nudge is not reliable.
     * zoomToFit() moves nothing when the data already fits the default world
     * view; a zoomIn/zoomOut pair can be coalesced by the animation and net
     * to zero; and on a slow page the whole sequence can run before the
     * layer has even taken its rows. Every one of those ends the same way:
     * a silent map that springs to life the first time the reader touches
     * it — "o mapa só carrega com zoom in ou out", twice reported.
     *
     * So this stops being a timed guess and becomes a loop with a condition.
     * It nudges, checks whether the map has reported, and nudges again,
     * alternating fit with a zoom pair because the two fail in different
     * circumstances. It stops the moment the map speaks, and gives up after
     * a few seconds rather than spinning forever. */
    let tries = 0;
    let stop = false;
    const timers: number[] = [];
    const after = (ms: number, f: () => void) =>
      timers.push(window.setTimeout(f, ms));
    const nudge = () => {
      if (stop || reported.current) return;
      const m = mapRef.current;
      if (!m) { if (tries < 14) { tries += 1; after(350, nudge); } return; }
      try {
        if (tries % 2 === 0) {
          m.zoomToFit();
        } else {
          m.zoomIn();
          after(180, () => { try { mapRef.current?.zoomOut(); } catch { /* gone */ } });
        }
      } catch { /* not mounted yet */ }
      tries += 1;
      if (tries < 14) after(tries < 4 ? 250 : 500, nudge);
    };
    after(60, nudge);
    return () => {
      stop = true;
      timers.forEach((t) => clearTimeout(t));
    };
    // keyed on the country set, not the array: the preview→final swap keeps
    // the same countries and must not restart a nudge on a map that already
    // answered, or the marks would blink out and back for nothing
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geoSig, appId, data.tf.from, data.tf.to]);
  /* AND AGAIN WHENEVER THE SELECTION CHANGES. The layer's data narrows to the
   * selected country and its states (see layerData), so re-fitting is what
   * carries the map into it — and back out when the selection clears. The
   * delay lets the layer re-render first; fitting the old data would frame
   * the place the reader just left. */
  useEffect(() => {
    if (!geo || geo.length === 0) return;
    const t = setTimeout(() => {
      try { mapRef.current?.zoomToFit(); } catch { /* not mounted */ }
    }, 160);
    return () => clearTimeout(t);
  }, [geoSel, regions, geo]);
  /* CLICKING ANYTHING IN THIS TILE PUTS ITS ANSWER ON THE SCREEN.
   * Everything a click opens — a country's screens, a state's cities —
   * renders in the drill panel UNDER the map, which on a wide screen is
   * below the fold. Framing the TILE was the old behaviour, and it left the
   * answer off the bottom of it; the reader clicked, the map reacted, and
   * the thing they asked for stayed out of sight. The drill itself is what
   * gets framed now. The wait lets the panel mount first, so the scroll
   * lands on the rendered block rather than on the gap where it is about
   * to be. */
  const revealDrill = React.useCallback(() => {
    setTimeout(() => {
      document.querySelector(".geo__drill")?.scrollIntoView({
        behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto" : "smooth",
        block: "start",
      });
    }, 160);
  }, []);
  /* THE JUMP ON LOAD. The marks were painted from the frame we ASKED the map
   * for, which is not where the map is during the moment it spends loading
   * its style and settling into that frame. So the country appeared off its
   * place and then slid into it — the overlay was right about the destination
   * and wrong about the present.
   * It now holds still until the map reports a view of its own through
   * onViewStateChange, and fades in on that first report. The timer is the
   * safety net: if the map never reports — a style that fails to load, a
   * version that does not emit on settle — the marks appear anyway, on the
   * requested frame, rather than never. */
  /* The 1.2s reveal timer went with the uncontrolled map: there is
   * nothing to wait for when the view is ours from the first paint. */
  useEffect(() => {
    setGeoSel(null);
    /* a different estate is a different frame, and a view the reader panned
       to on the old one says nothing about this one */
    geoFrame.current = null;
    setGeoView(null);
  }, [appId, data.tf.from, data.tf.to]);
  useEffect(() => { setGeoViewSel(null); setRegionSel(null); }, [geoSel]);
  /* AND THE SCREEN GOES WITH THE STATE. Opening a state replaces the list of
   * screens underneath it, so a screen picked in the previous one is a
   * selection in a list that is no longer on the page. */
  useEffect(() => { setGeoViewSel(null); }, [regionSel]);
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
        /* one deterministic sample of the application's sessions (sampleRate):
           the country-vs-rest RATES are read off it, and both sides of the
           comparison come from the same sample */
        const rows = await Q.runDql<Record<string, unknown>>(Q.qGeoWho(data.tf, appId, geoSel,
          Q.sampleRate(data.apps.find((a) => a.appId === appId)?.sessions ?? 0)), 10000);
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
  const pulse = usePulse(appId, data.tf, feName || undefined);
  const fc = useAppForecast(appId, data.tf, feName || undefined);
  const scope = useAppScope(appId, data.apps.find((a) => a.appId === appId)?.entity);
  /* The page opens on sessions. Clicking a card opens that card's evidence
   * BELOW the grid — the chart and its breakdown — and clicking the open card
   * closes it. Only what is on screen costs an analyzer run. */
  const [detail, setDetail] = useState<DetailMetric | "services" | null>("sessions");

  const mfc = useMetricForecast(appId, data.tf,
    detail && detail !== "services" ? detail : null, feName || undefined);
  /* One projection per card, because every card now draws one. These are NOT
   * free: each runs a DQL timeseries over user.events inside the analyzer, so
   * each is a real Grail scan — and one the header's readout never sees, since
   * the app's own query path is not the one executing it. That is why history
   * is capped (forecastPlan): four cards on a thirty-day window used to ask
   * for four times ninety days. */
  const fcSessions = useMetricForecast(appId, data.tf, "sessions", feName || undefined);
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
  /* THE PROBE ASKS ABOUT HOSTS. Its query matches a span's server address, so
     feeding it the endpoint names — which it was, from the moment this drill
     began grouping by endpoint — asked about things no span can be. The
     lookup was already corrected to read r.domain; the LIST it is looked up
     in had to be corrected the same way, or the set was simply always empty.
     Deduplicated, because many endpoints share one host and the probe is
     billed per host. */
  const domainTraces = useDomainTraces(
    detail === "requests"
      ? [...new Set((detailRows ?? []).map((r) => r.domain ?? r.name))]
      : [],
    data.tf, detail === "requests");
  // the services drill-down: the busiest first, capped, and only once opened
  const svcTop = [...scope.traces.entries()]
    .map(([id, traces]) => ({ id, traces, name: scope.names.get(id) ?? id }))
    .sort((a, b) => b.traces - a.traces)
    .slice(0, SERVICE_FORECAST_CAP);
  const svcAhead = useServiceForecasts(svcTop, detail === "services");
  // measured now, beside the projections — one read for every service at once
  /* ALWAYS ON, for two services' worth of names. The card offers each
     service name as a link to its own page in the Services app, and that app
     filters on `dt.service.name` — which is the METRIC STORE's name and can
     differ from the Smartscape display name the card had been using. A link
     built from the wrong one opens an Explorer listing nothing, which is the
     failure that looks like success. This read is the resolver: one
     metric-store query for the whole set, which is orders cheaper than the
     RUM scans this page already pays for, and the panel below reuses it. */
  const svcVitals = useServiceVitals(svcTop.map((x) => x.id), data.tf, true);
  const scopeCount = scope.resolved ? scope.services.size : null;
  /* The card shows the busiest, and carries BOTH names: what to print (the
     one a reader recognises) and what the Explorer filters on. Without the
     second the link cannot be built, and a link that cannot be built is not
     offered — see the tk-note--link branch. */
  const svcLinks = svcTop.map((x) => ({
    label: scope.names.get(x.id) ?? x.id,
    filter: svcVitals?.get(x.id)?.name ?? null,
  })).filter((x) => x.label);
  const svcNames = svcLinks.map((x) => x.label);
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
    /* THE MEASURE LEADS, the subject follows — every other line on these
       cards reads "2k sessions", "246.3k web requests", and only these read
       backwards. The host is trimmed to the part that identifies it
       (checkout.playground-dev.internal.example.com is a wall in a
       160px column); the whole name rides the tooltip. */
    /* THE WHOLE HOST, ELLIPSISED BY CSS. It used to be cut to its first two
       labels to fit the column, which turned static.cdn.example-bank.com into
       "static.neth" — a hostname that does not exist, printed as if it did. A
       name cut by CSS at least shows that it was cut; a name cut by code
       looks complete. */
    .map(([d, n]) => ({ short: `${fmtK(n)} ${d}`,
      full: `${d} · ${fmtK(n)} requests` }));

  if (!app) return null;
  const isMobile = app.entity?.startsWith("MOBILE_APPLICATION-");
  const problems = data.problems.filter((p) =>
    (p.entityIds ?? []).includes(app.entity ?? ""));
  /* A PER-SESSION RATIO HAS NO HONEST PREVIEW. Grail's partial result of a
     per-session count holds each session with only part of its events, so
     "sessions that met an error" is not an incomplete figure but a LOW one —
     measured on a bank's production application: previews of 40%, 32%, 63%,
     78%, 56% before the final 81%. The verdict followed each of them, from
     "not measured" through Warning to Critical, and the reader watched the
     application change its diagnosis three times. So the ratio and the
     verdict built on it wait for the final; counts may still preview. */
  const impactFinal = !!harm && !harm.partial;
  const clean = impactFinal && harm && harm.sessions > 0
    ? 1 - harm.hit / harm.sessions : null;
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
    sessions: harm?.sessions, hit: harm?.hit,
    // the population that can actually be harmed decides the verdict
    realSessions: harm?.realSessions, realHit: harm?.hitReal,
    forecastRising: !!fc && fc.slope > 0,
    // response time against the errors that hurt — judged once it is final
    score: uxSelf && !ux?.scorePartial ? apdexOf(uxSelf) : null,
  });
  /* ONE VERDICT, ONCE. Until the impact scan's final and the chain's final
     (Davis problems arrive with it) have both landed, the page says it is
     measuring — in the header and in the hero, in neutral ink — instead of
     printing a diagnosis it may have to take back. */
  // the score judges too, so the verdict waits for its final as well
  const verdictFinal = impactFinal && !data.partial && !!ux && !ux.scorePartial;
  const shown = verdictFinal ? verdict : {
    tone: "info" as Tone, label: "Measuring",
    reason: "counting this window's sessions — the verdict appears once they are all in",
    hitRate: null };
  const tone: Tone = shown.tone;
  // Real people, the same population the estate table's headline counts — the
  // two lines quote the same estate and must not disagree about it.
  /* One row means the scan was scoped to this application, so there is no
     estate to compare against — and an application compared with itself
     would read as a finding. Absent beats invented. */
  const estate = ux && ux.size > 1 ? [...ux.values()].reduce((acc, u) => {
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
    real: harm?.hitReal ?? 0, robot: harm?.hitRobot ?? 0,
    synth: harm?.hitSynth ?? 0,
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

  /* What this page measured, in the order a reader meets it. Built here so
   * the Intelligence starters cite exactly the figures on screen — and so a
   * figure the page could NOT measure is named as unmeasured rather than
   * quietly omitted, which is how a model ends up inventing one. */
  const overviewFacts = () => {
    const HIT_BAD_PCT = HIT_BAD * 100, HIT_WARN_PCT = HIT_WARN * 100;
    const pc = (r: number) => `${(r * 100).toFixed(r >= 0.1 ? 0 : 1)}%`;
    const apdex = uxRow ? apdexOf(uxRow) : null;
    const L: string[] = [
      `Application: ${app.name}`,
      `Window: ${data.tf.label}`,
      /* the verdict used to print as "—": the card's own status word and the
         fact that decided it were right there and never made it into the
         facts, so the model was asked to judge a page whose judgement it
         could not see */
      verdictFinal ? `Verdict: ${verdict.label} — ${verdict.reason}`
        : "Verdict: still measuring — the session scan has not finished; do not infer one",
      impacted
        ? `Sessions: ${fmtN(impacted.sessions)} started in this window as Users & Sessions lists them (${fmtN(impacted.realSessions)} from real people, the rest robots or synthetic)`
        : "Sessions: not measured in this window",
      harm && harm.realSessions > 0
        ? `Sessions an error affected (an error during the person's own action, or the app crashing/freezing — background errors are not counted): ${fmtN(harm.hitReal)} of ${fmtN(harm.realSessions)} real ones (${pc(harm.hitReal / harm.realSessions)})`
        : "Sessions an error affected: not measurable — no real-user sessions on record",
      apdex === null
        ? "Experience score: not rated — the platform rated no user action in this window"
        : `Experience score: ${(scoreExplain({ ...uxRow!, crashes: uxRow!.scoreCrashes }) ?? "").replace(/\n+/g, " ")}`,
      `Errors recorded: ${fmtN(app.errors)}`
        + (uxRow
          ? ` — ${fmtN(uxRow.errorsThird)} raised by third parties (CSP, external requests, foreign scripts), ${fmtN(Math.max(0, uxRow.errors - uxRow.errorsThird))} by this application's own code; ${fmtN(uxRow.realErrors)} reached a real person`
          : ""),
      vitals && (vitals.crashes !== null || vitals.anrs !== null)
        ? `Crashes: ${fmtN(vitals.crashes ?? 0)} · freezes (ANR, the app killed by the OS): ${fmtN(vitals.anrs ?? 0)}`
        : "Crashes and freezes: not measured in this window",
      `Views recorded: ${fmtN(app.views)}`,
      problems.length + scopeProblems > 0
        ? `Davis problems on this application or its chain: ${fmtN(problems.length + scopeProblems)}`
        : "Davis problems: none open on this application or its chain — Davis found no deviation from this application's learned baseline, which is a different fact from 'no errors'",
      ...[...problems, ...scopeProbs].slice(0, 6).map((pr) =>
        `  ${pr.display_id} ${pr.name} (${davisCategory(pr.category)})`),
      anomalies > 0
        ? `Davis baselining anomalies on its components: ${fmtN(anomalies)}`
        : "Davis baselining anomalies: none",
      "",
    ];
    /* THE ERRORS BY NAME, when the reader has them open — the one list that
       turns "protect the brand" from advice into an action on a named error */
    if (detail === "errors" && detailRows && detailRows.length) {
      L.push("Errors by name (the errors card is open; biggest first):");
      for (const r of detailRows.slice(0, 8)) {
        L.push(`  ${r.name}: ${fmtN(r.vol)} errors in ${fmtN(r.sessions)} sessions`
          + (r.third ? `, ${fmtN(r.third)} from a third party` : "")
          + (r.real !== undefined ? `, ${fmtN(r.real)} reached a real person` : "")
          + (r.type ? ` · type ${r.type}` : ""));
      }
      L.push("");
    } else if (detail !== "sessions") {
      L.push("Errors by name: not loaded — open the errors card on this page to list them, and the Error Inspector drill-down to open one.", "");
    }
    /* THE SCORE, SCREEN BY SCREEN, when the experience card is open — and
       what each screen costs it. "Points lost" is plain arithmetic on the
       platform's own ratings: how far the application's score would rise if
       that screen's frustrated and tolerating actions had been satisfied,
       everything else equal. It ranks the screens by what fixing them is
       worth, which is the question a reader asks next. */
    const rated = uxRow ? uxRow.satisfied + uxRow.tolerating + uxRow.frustrated : 0;
    if (detail === "sessions" && detailRows && detailRows.length && rated > 0) {
      L.push("The experience score by screen (the experience card is open; most used first):",
        "  points lost = (frustrated + tolerating ÷ 2) ÷ the application's rated actions —",
        "  how much the application's score would rise if that screen's actions had all been satisfied");
      for (const r of detailRows.slice(0, 8)) {
        const sat = r.sat ?? 0, tol = r.tol ?? 0, fru = r.fru ?? 0;
        const n = sat + tol + fru;
        const own = n ? (sat + tol / 2) / n : null;
        const lost = (fru + tol / 2) / rated;
        const ms = (v?: number) => (v ? `${Math.round(v / 1e6).toLocaleString("en-US")} ms` : "—");
        L.push(`  ${r.name}: ${fmtN(r.vol)} actions, ${fmtN(n)} rated`
          + (own === null ? " (none rated)"
            : ` — its own score ${fmtApdex(own)} (${fmtN(sat)} satisfied, ${fmtN(tol)} tolerating, ${fmtN(fru)} frustrated)`
              + `, points lost ${lost.toFixed(3)}`)
          + ` · p50 ${ms(r.p50)}, p90 ${ms(r.p90)}`
          + (r.errors ? ` · ${fmtN(r.errors)} errors recorded on it` : ""));
      }
      L.push("");
    } else if (detail !== "errors") {
      L.push("The experience score by screen: not loaded — open the User experience card on this page to list the screens and what each costs the score.", "");
    }
    if (geo && geo.length) {
      const tot = geo.reduce((a, g) => a + g.sessions, 0) || 1;
      // the application's located rate, on the population places are judged on
      const base = geo.reduce((a, g) => a + geoPop(g).h, 0)
        / (geo.reduce((a, g) => a + geoPop(g).n, 0) || 1);
      /* THE RULE TRAVELS WITH THE FIGURES. A country in line at 85% beside
         states at 85% is only a contradiction to a reader who assumes the
         colour is the rate. It is not: it is deviation from this application.
         Spelled out here so the answer explains the rule the map applies —
         the rule in utils/geoVerdict — and not one it guessed. */
      L.push(`How a place is judged on this page: by the APPLICATION'S OWN RULE, worst of two — the share of the place's real-user sessions an error AFFECTED (an error during the person's own action, or — mobile only — the app crashing or freezing; background errors do not count), Critical at ${HIT_BAD_PCT}% or more, Warning at ${HIT_WARN_PCT}% or more; and the place's experience score (response time against those same errors), Critical under 0.70, Warning under 0.85, once 30 elements were rated. The place's rate against this application's (${pc(base)} of its located sessions were affected in this window — "0.59×" means better than usual) is printed, never coloured. A place with fewer than 10 sessions is too small to judge and stays green for lack of evidence, not for health.`);
      L.push("Where they connect from (sessions · share of the window · affected by an error · times the application's rate · verdict):");
      for (const g of [...geo].sort((a, b) => b.sessions - a.sessions).slice(0, 8)) {
        const pp = geoPop(g);
        const rate = pp.n > 0 ? pp.h / pp.n : 0;
        L.push(`  ${geoName(g.country)} (${g.country}): ${fmtN(g.sessions)} sessions`
          + ` (${((g.sessions / tot) * 100).toFixed(1)}%), ${pc(rate)} affected by an error`
          + ` (${base > 0 ? (rate / base).toFixed(2) : "—"}×) — ${GEO_WORD[geoJudge(g, base)]}: ${geoBecause(g, base)}`);
      }
      if (geoSel) {
        L.push(`Selected country: ${geoName(geoSel)} (${geoSel})`);
        if (regions && regions.length) {
          L.push("  Its states, judged by the same rule (a session that moves between states is counted in each):");
          for (const r of [...regions].sort((a, b) => b.sessions - a.sessions).slice(0, 10)) {
            const rate = r.sessions > 0 ? r.hit / r.sessions : 0;
            L.push(`    ${r.name}: ${fmtN(r.sessions)} sessions, ${pc(rate)} affected by an error`
              + ` (${base > 0 ? (rate / base).toFixed(2) : "—"}×) — ${GEO_WORD[geoJudgeSub(regionArm(r), base)]}`);
          }
        }
        const rows = regionSel ? regionDetail : geoDetail;
        if (rows && rows.length) {
          L.push(`  Top screens across ${regionSel ?? geoSel} (sessions · of which an error affected):`);
          for (const d of rows.slice(0, 8)) {
            L.push(`    ${d.view}: ${fmtN(d.sessions)} sessions, ${fmtN(d.hit)} affected by an error`
              + (d.sessions > 0 ? ` (${pc(d.hit / d.sessions)})` : ""));
          }
          if (rows.some((d) => d.view === NO_SCREEN)) {
            L.push(`  "${NO_SCREEN}" counts sessions whose error belongs to no screen — crashes, freezes (ANR) and request failures raised at application level. One such error marks the whole session, so when this row dominates, the application's own error rate is set by it and not by any screen; it is the first thing to open.`);
          }
        }
      }
    } else {
      L.push("Geography: no located sessions in this window");
    }
    L.push("",
      "Note: these counts include robot and synthetic traffic unless a line says",
      "otherwise. Anything this page did not measure is stated as such above —",
      "do not substitute a figure for it.");
    return L.filter((x) => x !== undefined).join("\n");
  };

  return (
    <div className="stack">
      {/* INTELLIGENCE — this application's own questions. overviewFacts is
          built from what the page rendered, so an answer can only cite what
          the reader can also see. */}
      <Intelligence subject="the Overview of this application"
        scope={`${appId}|${data.tf.from}|${data.tf.to}`}
        starters={OVERVIEW_STARTERS} facts={overviewFacts} />

      {/* THE ESTATE LINE IS GONE. This page is scoped to ONE application —
          the header's selector says which — so a headline counting every
          application, the whole estate's error-free share and every problem in
          the environment described a subject the page never shows. The reader
          caught the contradiction. */}

      <div className="tk-hd">
        <i className="tk-hd__ic" style={{ ["--t" as string]: FVAR[tone] }}>
          {isMobile ? <MobileIcon /> : <DesktopIcon />}
        </i>
        <div className="tk-hd__t">
          <h2>{app.name}</h2>
          <span>{isMobile ? "Mobile application" : "Web application"} · {data.tf.label}
            {" · "}<b style={{ color: verdictFinal ? TVAR[tone] : "var(--ink-2)", fontWeight: 600 }}>
              {shown.label} — {shown.reason}
              {/* A JUDGEMENT ON A PARTIAL FIGURE SAYS SO. The header already
                  reads "measuring…" while the impact scan is on a preview,
                  but the verdict is the loudest sentence on the page and it
                  was printing "Critical — 98% hit" off a partial scan with
                  nothing beside it. Data-integrity rule: the mark travels
                  with the number it qualifies. */}
              </b></span>
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
          <button className="tk-btn" onClick={onAnalyze}>Analyze user sessions</button>
          <button className="tk-btn" onClick={() => onOpenChain()}>Open delivery chain</button>
        </div>
      </div>

      <CleanCard
        sessions={impacted?.sessions ?? app.sessions}
        sessionBase={impacted?.base}
        shortWindow={Q.withinSessionLag(data.tf)}
        realSessions={impacted?.realSessions ?? null}
        clean={clean} tone={tone} name={app.name} isMobile={!!isMobile}
        series={pulse?.series ?? []}
        /* THE CAPTION DESCRIBES THE BARS. It read "/min user actions" beside
           a sparkline of SESSIONS — two facts in one slot, and on an
           application that records no user action at all it printed 0.0 next
           to bars that plainly were not zero. Read off the series the bars
           draw, so the two can never drift apart. */
        /* A RATE OVER THE SPAN THE SERIES ACTUALLY COVERS. The session store
           is only complete up to about an hour ago, so the drawn series stops
           there — dividing its total by the whole window would under-report
           the rate by half on a two-hour view. */
        sessionsPerMin={(() => {
          // a series that has not arrived is "…", never "0.0" — zero is a
          // measurement and this is the absence of one
          if (!pulse) return "…";
          const pts = pulse.series;
          const span = Math.max(1, pts.length * Q.binMinutesFor(data.tf.minutes));
          const n = pts.reduce((a, b) => a + b.sessions, 0);
          return (n / span).toFixed(n / span >= 10 ? 0 : 1);
        })()}
        errors={early(vitals?.errors, app.errors)}
        errorsPerMin={perMin(early(vitals?.errors, app.errors))}
        crashes={early(vitals?.crashes, app.crashes)}
        anrs={early(vitals?.anrs, app.anrs)}

        /* The core shows an Apdex, which is a speed reading and says nothing
           about what Davis detected. The problems belong beside it — named by
           category, in the platform's own words, so the card carries both what
           was measured and what was detected. */
        problems={problems.length + scopeProblems}
        problemCats={[...new Set([...problems, ...scopeProbs]
          .map((pr) => davisCategory(pr.category)))]}
        requests={pulse?.requests ?? vitals?.requests ?? 0} reqFail={pulse?.reqFail ?? 0}
        hitSessions={harm?.hit ?? 0}
        loadP50={app.p50Load > 0 ? app.p50Load : app.p50View}
        apdex={uxRow ? apdexOf(uxRow) : null}
        apdexPartial={!!ux?.scorePartial}
        /* AN EMPTY SCORE HAS TO SHOW ITS WORK.
           "—" is the right answer when nothing could be rated, and it is
           indistinguishable from a broken query unless the card says what it
           counted. Apdex rates USER ACTIONS belonging to real people, so the
           two numbers that settle it are how many actions the window held and
           how many of them were rated — both already measured, neither shown.
           With them a reader can tell "this application records no user
           actions" from "the score failed to arrive", which is exactly the
           distinction being asked for. */
        /* "—" MEANS MEASURED-EMPTY, NEVER NOT-YET. While the UX scan is in
           flight the slot said "—" with "no rated user actions" under it —
           asserting a fact before the data existed, identical on screen to
           an application that truly has none. Loading says loading; a
           preview says measuring; only a final may say "—". */
        apdexNote={ux === null
          ? "Measuring — the user-experience scan is still running."
          : uxRow && apdexOf(uxRow) === null
          ? (uxRow.realSessions === 0 && uxRow.sessions > 0
            ? "No people to rate: every session this window is robot or synthetic traffic, "
              + "and the experience score counts real users only."
            : uxRow.actions === 0
              ? `No user actions recorded in this window — ${fmtN(uxRow.sessions)} sessions, `
                + `and not one navigation or interaction among them. The platform rates user actions, `
                + `so there is nothing to score. This is a fact about the instrumentation, not `
                + `about the speed: RUM is reporting requests and errors for this application `
                + `and not what people do on the screen.`
              : `${fmtN(uxRow.actions)} user actions in this window and none of them rated. `
                + `The experience score counts real users only, so actions belonging to robots or synthetic `
                + `monitors are excluded — if that is all of them, the score has nothing left `
                + `to measure.`)
          : undefined}
        apdexBands={uxRow ? { sat: uxRow.satisfied, tol: uxRow.tolerating,
          fru: uxRow.frustrated, ratedActs: uxRow.ratedActs, errActions: uxRow.errActions,
          crashes: uxRow.scoreCrashes } : null}
        verdictLabel={shown.label} verdictReason={shown.reason}
        realErrors={uxRow ? uxRow.realErrors : null}
        errorsThird={uxRow?.errorsThird ?? 0}
        services={scopeCount} svcNames={svcNames} svcLinks={svcLinks} domNames={domNames}
        onOpenService={(n) => window.open(servicesExplorerHref(data.tf, n), "_blank", "noopener")}
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
          a LARGE map framed on the data (the view comes from the traffic's
          own bounding box), bubbles in volume buckets — shapeSize is per
          layer, so three layers make three sizes — coloured by the health
          judgement, and the ranked list beside the map as its legend. One
          scan leg (qGeo) feeds all of it. */}
      {geo && geo.length > 0 && (() => {
        const tot = geo.reduce((a, g) => a + g.sessions, 0) || 1;
        // the application's located rate, on the population places are judged on
        const base = geo.reduce((a, g) => a + geoPop(g).h, 0)
          / (geo.reduce((a, g) => a + geoPop(g).n, 0) || 1);
        const max = Math.max(...geo.map((g) => g.sessions), 1);
        const located = geo.filter((g) => CENTROID[g.country]);
        /* FRAME THE MAP ON THE PEOPLE, NOT ON THE PLACES.
         *
         * This used to centre on the midpoint of the bounding box of every
         * located country — one vote per country, however few sessions it
         * held. Measured on a live estate: 391 sessions in Brazil and TWO
         * in the United States put the centre at roughly 14°N 76°W, so the map
         * opened on the Caribbean with Brazil clipped at the right edge and
         * 99.5% of the traffic off-screen. Two sessions outvoted three hundred
         * and ninety-one.
         *
         * So the centre is weighted by sessions, and the frame is sized from
         * the countries that actually carry traffic. The outliers still draw —
         * they are dots on a map and rows in the list beside it — they just no
         * longer decide where everyone else is looking.
         */
        const wsum = located.reduce((a, g) => a + g.sessions, 0) || 1;
        /* The CENTRE follows the sessions — latitude averages directly, but
         * longitude has to go round the circle, or an estate split across the
         * antimeridian averages to its own opposite (Tokyo and California
         * would centre on Africa). */
        const cLat = located.length
          ? located.reduce((a, g) => a + CENTROID[g.country][0] * g.sessions, 0) / wsum : 20;
        const cLng = located.length ? (() => {
          const x = located.reduce((a, g) =>
            a + Math.cos((CENTROID[g.country][1] * Math.PI) / 180) * g.sessions, 0);
          const y = located.reduce((a, g) =>
            a + Math.sin((CENTROID[g.country][1] * Math.PI) / 180) * g.sessions, 0);
          return (Math.atan2(y, x) * 180) / Math.PI;
        })() : 0;
        /* …but the FRAME holds everyone, weight or none. A country with two
         * sessions must not decide where the map looks, and it must not fall
         * off the edge either: it is a real place real people connected from,
         * and the panel beside the map names it. So the span reaches the
         * furthest country, not the heaviest one, measured the short way round
         * the globe. */
        const away = (lng: number) =>
          Math.abs(((lng - cLng + 540) % 360) - 180);
        const PAD = 1.6; // dots sit inside the view, not against its edges
        const span = located.length
          ? Math.min(360, Math.max(
            2 * Math.max(...located.map((g) => away(CENTROID[g.country][1]))) * PAD, 30))
          : 360;
        const zoom = span > 200 ? 1.1 : span > 120 ? 1.6 : span > 60 ? 2.2 : 3;
        /* The rule itself lives in utils/geoVerdict — the board and the
         * poster judge locations too, and three copies of a threshold is
         * how screens start to argue. */
        const arms = (g: GeoArm) => geoArms(g, base);
        const judge = (g: GeoArm) => geoJudge(g, base);
        /* The reader's own semantics, stated as a rule: satisfied = green,
         * tolerating = yellow, frustrated = red. Blue was the odd one out.
         * The canvas layer paints outside CSS and cannot read a var, so it
         * RESOLVES the three verdict tokens instead of carrying literals of
         * its own — the map's marks are the platform's success, warning and
         * critical, and they follow light mode like every other verdict. */
        /* captured once per estate: see geoFrame at the top of the component */
        if (located.length && !geoFrame.current) {
          geoFrame.current = { latitude: cLat, longitude: cLng, zoom };
        }
        const frame = geoFrame.current ?? { latitude: cLat, longitude: cLng, zoom };
        /* `frame` is a HINT now, not a claim — it is handed to the map as
           initialViewState and nothing is projected against it. What the
           overlay projects against is geoView, which only ever holds a view
           the MAP reported. See the note at mapRef for why. */
        /* NO VERDICT COLOUR ON A PREVIEW. The colour is a per-session share
           judged on the application's lines, and a preview of a per-session
           count is LOW (see impactFinal) — a country painted amber at 4 s
           turned red at 8 s. Until the map's own scan is final, every mark
           and row is drawn in neutral ink with its counts, and the header
           says measuring; the verdict colours arrive once, together. */
        const geoFinal = !geo.partial;
        const COL = { ...geoCol(), wait: "rgba(160,164,176,0.55)" };
        /* dots and bars are MARKS, so they take the saturated half of the
           family — the text half resolves to #855400 in light, which is the
           olive that made the whole tile look yellow. */
        const TOK = { good: "var(--good-fill)", warn: "var(--warn-fill)",
          bad: "var(--bad-fill)", wait: "var(--ink-3)" } as const;
        const shown = (g: GeoArm): GeoTone | "wait" => (geoFinal ? judge(g) : "wait");
        const WORD = { ...GEO_WORD, wait: "measuring" } as const;
        const because = (g: GeoArm) => geoBecause(g, base);
        /* Country NAMES from the browser itself — no dataset needed, and it
         * speaks the reader's own language. City stays impossible honestly:
         * measured null on every RUM row of a live estate. */
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
          color: COL[shown(g)], country: nameOf(g.country),
          sessions: g.sessions, hitByErrors: g.hit,
        });
        /* THE MAP DRILLS WITH THE SELECTION.
         * MapView takes no "fly to" — its ref offers zoomToFit, zoomIn,
         * zoomOut and reset, and nothing that accepts a coordinate. But
         * zoomToFit frames THE LAYERS' DATA, so narrowing the data IS the
         * drill: select Japan and the layer holds Japan and its prefectures,
         * so the fit lands on Japan. Deselect and it holds the world again.
         * It is also the only way to move this map that does not depend on
         * it honouring a view prop, which it does not.
         * A single point would fit to street level, so a country with no
         * sub-national rows gets two transparent anchors about six degrees
         * out — they frame a country-sized box and draw nothing. */
        const ANCHOR = 6;
        const layerData = (() => {
          if (!geoSel || !CENTROID[geoSel]) return located.map(dot);
          const rs = (regions ?? [])
            .filter((r) => REGION_CENTROID[r.id])
            .map((r) => ({
              latitude: REGION_CENTROID[r.id][0], longitude: REGION_CENTROID[r.id][1],
              color: COL[geoJudgeSub(regionArm(r), base)],
              country: r.name, sessions: r.sessions, hitByErrors: r.hit,
            }));
          if (rs.length >= 2) return rs;
          const [la, lo] = CENTROID[geoSel];
          const home = located.filter((g) => g.country === geoSel).map(dot);
          const anchor = (dla: number, dlo: number) => ({
            latitude: la + dla, longitude: lo + dlo, color: "rgba(0,0,0,0)",
            country: "", sessions: 0, hitByErrors: 0,
          });
          return [...home, anchor(-ANCHOR, -ANCHOR), anchor(ANCHOR, ANCHOR)];
        })();
        /* Nine layers, because shape and shapeSize are PER LAYER: three volume
         * buckets × three health tones. The shape is a ReactNode, which is
         * what lets the map itself ANIMATE — problem countries pulse a sonar
         * ring, the busiest breathe. CSS drives it, reduced-motion respected. */
        const sizeOf = (g: typeof located[number]) =>
          g.sessions >= max * 0.45 ? 44 : g.sessions >= max * 0.12 ? 26 : 14;

        return (
          <div className="panel geo">
            <div className="panel__hd"><span className="lbl">Where they connect from</span>
              <span className="hint">sessions and health by country · {data.tf.label}
                {/* PREVIEW ROWS SAY SO. The tile now paints the moment the
                    query has a first answer; until the final replaces it the
                    figures are a floor, and the header carries the mark the
                    same way the card and the verdict do. */}
                {geo?.partial ? <em className="dim"> · measuring…</em> : null}</span></div>
            <div className="pad geo__wrap">
              {/* THE MAP ITSELF WAITS TOO. Holding only the marks back was
                  half the fix: the map still painted its default view and
                  then panned to the frame, and a map that moves on its own
                  the moment you arrive reads as a mistake being corrected.
                  Nothing in this tile is visible until the map reports where
                  it is; the same timer that backs the marks backs this, so a
                  map that never reports still appears. */}
              <div className={`geo__map${geoView ? " geo__map--on" : ""}`}>
                {/* CONTROLLED, and this time for the right reason.
                    It was controlled once, loosely, and the loop it caused
                    sent it back to uncontrolled — where it failed twice more,
                    because uncontrolled here means the map answers to nobody:
                    measured, MapView neither applied the initialViewState it
                    was given nor reported a view until the reader touched it.
                    The overlay therefore drew against a frame the map had
                    never adopted, and the heaviest country sat in the Atlantic
                    until the first zoom emitted a real view and everything
                    snapped into place — which is exactly how the reader
                    described it.
                    Controlled, there is one view and both sides read it, so
                    they cannot disagree. The loop that scared us off is held
                    by the equality guard below: the view we just rendered
                    comes straight back from onViewStateChange and is dropped
                    as a no-op, while a real pan still gets through. */}
                <MapView height={mapH}
                  ref={mapRef}
                  initialViewState={frame}
                  onViewStateChange={(v) => {
                    /* THE MAP'S OWN ANSWER, and the only view the overlay
                       will project against. It is a hint we hand back to
                       ourselves, never a view we impose. */
                    if (v.latitude == null || v.longitude == null || v.zoom == null) return;
                    reported.current = true;
                    const next = { latitude: v.latitude, longitude: v.longitude, zoom: v.zoom };
                    setGeoView((cur) => {
                      const same = cur
                        && Math.abs(cur.latitude - next.latitude) < 1e-6
                        && Math.abs(cur.longitude - next.longitude) < 1e-6
                        && Math.abs(cur.zoom - next.zoom) < 1e-6;
                      return same ? cur : next;
                    });
                  }}>
                  {/* a faint native layer keeps the map's own tooltip */}
                  <DotLayer shape="circle" shapeSize={6} data={layerData} />
                  {/* NO STATE CHOROPLETH, and the reason is the component, not
                      the data. Strato's ChoroplethLayer takes an ISO 3166-2
                      code — which geo.region.iso_code supplies once the country
                      is prefixed — but this version ships ONE geometry file,
                      WORLD-COUNTRIES.json, and its only fill constant is
                      COUNTRIES_FILL_COLOR. Measured with the layer mounted: the
                      map requested no sub-national shapes and painted nothing.
                      A code with no polygon behind it draws nothing, so the
                      states live in the panel below, counted rather than
                      shaded. */}
                </MapView>
                {geoView && (() => {
                  const vs = geoView;
                  const world = 512 * Math.pow(2, vs.zoom);
                  const mx = (lng: number) => ((lng + 180) / 360) * world;
                  const my = (lat: number) => {
                    const p = (lat * Math.PI) / 180;
                    return ((1 - Math.log(Math.tan(p) + 1 / Math.cos(p)) / Math.PI) / 2) * world;
                  };
                  const cx = mx(vs.longitude), cy = my(vs.latitude);
                  /* NO LABEL ON TOP OF ANOTHER LABEL.
                     Marks are placed by coordinate, so on a world view the
                     crowded parts of the map — western Europe, east Asia —
                     stack their names on each other and none of them can be
                     read. Measured on a live estate: IE over GB, JP over KR,
                     MX over the United States.
                     So labels are PLACED, biggest first: each one claims a
                     box, and a label whose box would touch a claimed one is
                     not drawn. The mark stays, with its tone, its size, its
                     tooltip and its row in the list beside the map — what it
                     loses is a name it could not have been read anyway. The
                     box is estimated from the text, in the mono face the
                     label actually uses, which is near enough for a test
                     that only has to answer "do these touch". */
                  const claimed: Array<[number, number, number, number]> = [];
                  const claim = (dx: number, dy: number, text: string, size: number) => {
                    const w = text.length * 6.4 + 18, h = 16;
                    const x0 = dx - w / 2, y0 = dy + size / 2 + 3;
                    const x1 = x0 + w, y1 = y0 + h;
                    const hits = claimed.some(([a, b, c, d]) =>
                      !(x1 < a || x0 > c || y1 < b || y0 > d));
                    if (hits) return false;
                    claimed.push([x0, y0, x1, y1]);
                    return true;
                  };
                  /* the order IS the priority: the heaviest place keeps its
                     name, and the ones that cannot have one are the small */
                  const labelled = new Set<string>();
                  [...located]
                    .sort((a, b) => b.sessions - a.sessions)
                    .forEach((g) => {
                      const [la, lo] = CENTROID[g.country];
                      const sz = sizeOf(g);
                      if (!(sz >= 26 || judge(g) !== "good")) return;
                      const txt = (sz === 44 ? nameOf(g.country) : g.country)
                        + ` ${fmtK(g.sessions)}`;
                      if (claim(mx(lo) - cx, my(la) - cy, txt, sz)) labelled.add(g.country);
                    });
                  const rLabelled = new Set<string>();
                  if (geoSel && regions) {
                    [...regions]
                      .sort((a, b) => b.sessions - a.sessions)
                      .forEach((r) => {
                        const c = REGION_CENTROID[r.id];
                        if (!c) return;
                        const sz = r.sessions >= 100 ? 20 : r.sessions >= 10 ? 15 : 11;
                        const txt = (sz >= 20 ? `${r.name} ${fmtK(r.sessions)}` : uf(r.id));
                        if (claim(mx(c[1]) - cx, my(c[0]) - cy, txt, sz)) rLabelled.add(r.id);
                      });
                  }
                  return (
                    <div className="geo__ov geo__ov--on" aria-hidden="true">
                      {/* ONE LEVEL AT A TIME. With a country open, its own
                          bubble sat on top of the states it had just opened —
                          two readings of the same ground, the bigger one
                          hiding the detail that was the point of the click.
                          The country marks step aside the moment there are
                          states to show. If the drill comes back with none,
                          they stay: there is nothing to step aside for. */}
                      {!(geoSel && regions && regions.length > 0)
                        && located.map((g) => {
                        const [la, lo] = CENTROID[g.country];
                        const sz = sizeOf(g);
                        const tone = shown(g);
                        return (
                          <button type="button" key={g.country}
                            className={`gpin gpin--${tone}${sz === 44 ? " gpin--busy" : ""}${geoSel === g.country ? " gpin--sel" : ""}`}
                            style={{ width: sz, height: sz,
                              left: `calc(50% + ${(mx(lo) - cx).toFixed(1)}px)`,
                              top: `calc(50% + ${(my(la) - cy).toFixed(1)}px)` }}
                            title={`${nameOf(g.country)} — ${WORD[tone]} · ${fmtN(g.sessions)} sessions · ${because(g)}${g.ttfbMs ? ` · ${fmtLat(g.ttfbMs)} to first byte (p75)` : ""}`}
                            onClick={() => {
                              const opening = geoSel !== g.country;
                              setGeoSel((c) => (c === g.country ? null : g.country));
                              if (opening) revealDrill();
                            }}>
                            {(sz >= 26 || tone !== "good") && (
                              <span className={`gpin__lbl${
                                labelled.has(g.country) ? "" : " gpin__lbl--off"}`}>
                                {sz === 44 ? nameOf(g.country) : g.country}
                                <em>{fmtK(g.sessions)}</em>
                              </span>
                            )}
                          </button>
                        );
                      })}

                      {/* THE STATES, AS MARKS. Strato paints no sub-national
                          polygon — this version ships WORLD-COUNTRIES.json and
                          nothing else, measured — but this overlay never drew
                          polygons anyway: the country bubbles above are placed
                          from our own centroid table over the platform's map.
                          A state needs the same one coordinate, so it joins
                          them rather than waiting for a geometry file that is
                          not coming. Smaller than a country mark, so the two
                          levels never read as the same thing. */}
                      {geoSel && regions && regions.map((r) => {
                        /* "BR-SP" → "SP": ISO 3166-2 carries the country, the
                           map is already standing on it. */
                        const c = REGION_CENTROID[r.id];
                        if (!c) return null;
                        const rate = r.hit / Math.max(r.sessions, 1);
                        const t = geoJudgeSub(regionArm(r), base);
                        const sz = r.sessions >= 100 ? 20 : r.sessions >= 10 ? 15 : 11;
                        return (
                          <button type="button" key={r.id}
                            className={`gpin gpin--sub gpin--${t}`
                              + (regionSel === r.id ? " gpin--sel" : "")}
                            style={{ width: sz, height: sz,
                              left: `calc(50% + ${(mx(c[1]) - cx).toFixed(1)}px)`,
                              top: `calc(50% + ${(my(c[0]) - cy).toFixed(1)}px)` }}
                            title={`${r.name} — ${fmtN(r.sessions)} sessions,`
                              + ` ${(rate * 100).toFixed(1)}% met an error.`
                              + " Click for its cities."}
                            onClick={() => {
                              const opening = regionSel !== r.id;
                              setRegionSel((x) => (x === r.id ? null : r.id));
                              /* A MARK ON THE MAP OPENS THE DRILL BELOW IT.
                                 The state list and its cities live under the
                                 map, far enough down on a wide screen that
                                 clicking a mark looked like it had done
                                 nothing: the row highlighted somewhere off
                                 the fold. The click now carries the reader to
                                 what it opened. The wait lets the row and its
                                 cities render first, so the scroll lands on
                                 the finished block rather than on the gap
                                 where it is about to be. */
                              if (opening) revealDrill();
                            }}>
                            {/* EVERY STATE IS NAMED. The label used to need 10
                                sessions, which on a real estate left two
                                thirds of the marks as unexplained dots — the
                                panel beside the map named them, the map did
                                not. Now each mark carries its own name: the
                                full one where the mark is big enough to hang
                                it on, the two-letter code otherwise, which is
                                the same identifier the list uses. The count
                                stays with the big marks only; sixteen numbers
                                over one country is a wall, and the list is
                                right there holding all of them. */}
                            <span className={`gpin__lbl${
                              rLabelled.has(r.id) ? "" : " gpin__lbl--off"}`}>
                              <b>{sz >= 20 ? r.name : uf(r.id)}</b>
                              {sz >= 20 && <em>{fmtK(r.sessions)}</em>}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  );
                })()}
              </div>
              <div className="geo__rows" ref={listRef}>
                {/* COLLAPSED BY DEFAULT, BECAUSE THE TABLE IS AN INDEX.
                    Thirteen countries and twenty-seven states is a page of
                    scrolling for a tile whose job is to say where the trouble
                    is — and the trouble is in the first few rows, which is why
                    they are sorted by volume. The rest is still one click
                    away, and the selected country is never hidden by the cap:
                    a list that drops the row you are standing on has lost the
                    reader to save space. */}
                {/* THE COLUMNS SAY WHAT THEY ARE. Seven of them, and every
                    one was a bare number: 469, 68.4% hit, 93ms. "hit" and
                    "ms" carry their own meaning, but the volume column
                    carried none at all, and a table whose columns are
                    unnamed asks the reader to infer the schema. The header
                    rides the same grid as the rows, so the names sit over
                    the numbers they belong to and cannot drift from them. */}
                {/* THE STATES BELONG UNDER THEIR COUNTRY, not under the last
                    row of the table. The list is built as every country, then
                    the selected country's states appended after them — so
                    Brazil's states loaded below Switzerland. The right rows in
                    the wrong place read as a loading bug rather than as a
                    hierarchy.
                    The rows stay where they are in the markup, which keeps the
                    reading order and the tab order honest, and the column flex
                    places them: each country takes a decade, its states take
                    the numbers just above the next one. */}
                <div className="geo__r geo__hd" aria-hidden="true" style={{ order: -1 }}>
                  <i /><span>code</span><span>country</span><span />
                  <span>sessions</span><span>affected</span><span>ttfb p75</span>
                </div>
                {shownGeo.map((g, gi) => {
                  const a = arms(g);
                  const { rate, lift } = a;
                  const tone = shown(g);

                  return (
                    <button type="button"
                      className={`geo__r${geoSel === g.country ? " geo__r--on" : ""}`}
                      style={{ order: gi * 100 }}
                      onClick={() => {
                        const opening = geoSel !== g.country;
                        setGeoSel((c) => (c === g.country ? null : g.country));
                        if (opening) revealDrill();
                      }}
                      key={g.country}
                      title={`${fmtN(g.sessions)} sessions from ${g.country} — ${(rate * 100).toFixed(1)}% affected by an error, application average ${(base * 100).toFixed(1)}% · ${WORD[tone]}: ${because(g)}`}>
                      <i className="geo__dot" style={{ background: TOK[tone] }} />
                      {/* THE ROW SAYS IT OPENS. Clicking a country has always
                          listed its states, and nothing on the row admitted
                          it — the reader had to discover the behaviour by
                          accident. A plus is the whole convention: it turns
                          into a minus when the country is open, so the sign
                          also says which state the row is in. */}
                      <b className="geo__cc">
                        <i className="geo__ex" aria-hidden="true">
                          {geoSel === g.country ? "−" : "+"}
                        </i>
                        {g.country}
                      </b>
                      <span className="geo__nm">{nameOf(g.country)}</span>
                      <span className="geo__t">
                        <i className="geo__b" style={{ width: `${(g.sessions / max) * 100}%`,
                          background: `color-mix(in srgb, ${TOK[tone]} 55%, transparent)` }} />
                      </span>
                      <span className="num geo__n">{fmtN(g.sessions)}</span>
                      {/* the rate is what the colour judged; the deviation
                          rides beside it as a figure, with the same substance
                          gate as before — one errored session in hundreds
                          never gets to claim "2.8×" */}
                      <em className={`geo__h geo__h--${tone}`}>
                        {g.hit === 0 ? "clean" : `${(rate * 100).toFixed(1)}% hit`}
                        {g.hit >= 5 && rate >= 0.02 && base > 0 && Math.abs(lift - 1) >= 0.15
                          ? <span className="geo__x"> · {lift.toFixed(2)}×</span> : null}
                      </em>
                      <em className={`geo__lat${latTone(g) ? ` geo__lat--${latTone(g)}` : ""}`}
                        title={g.ttfbMs ? `first byte p75 for ${nameOf(g.country)} — the network route's own cost; median country here: ${fmtLat(latBase)}` : "no timed views from here"}>
                        {g.ttfbMs ? fmtLat(g.ttfbMs) : "—"}
                      </em>
                    </button>
                  );
                })}

                {/* THE STATES, IN THE LIST, under the country they belong to.
                    They were only in the panel below the map, which is where
                    the reader was not looking — the list is the index of this
                    tile, and a level missing from it reads as a level that
                    does not exist. Clicking one takes the map to it, so the
                    row and the picture always agree about where you are. */}
                {geoSel && regions && regions.length > 0 && shownRegions.map((r, ri) => {
                  // the decade of the country these belong to, so they sit
                  // directly under it however the countries are sorted
                  // a country owns a century of slots, so even Brazil's 27
                  // states sit between it and the next country
                  const under = shownGeo.findIndex((g) => g.country === geoSel) * 100
                    + 1 + ri;
                  const rate = r.hit / Math.max(r.sessions, 1);
                  const t = geoJudgeSub(regionArm(r), base);
                  const c = REGION_CENTROID[r.id];
                  return (
                    <button type="button" key={r.id}
                      className={`geo__r geo__r--sub${regionSel === r.id ? " geo__r--on" : ""}`}
                      style={{ order: under }}
                      title={`${r.name} — ${fmtN(r.sessions)} sessions,`
                        + ` ${(rate * 100).toFixed(1)}% met an error.`
                        + (c ? " Click to centre the map on it and list its cities."
                             : " No coordinate for this state, so it is counted but not placed.")}
                      onClick={() => {
                        const opening = regionSel !== r.id;
                        setRegionSel((x) => (x === r.id ? null : r.id));
                        if (opening) revealDrill();
                      }}>
                      <i className="geo__dot" style={{ background: TOK[t] }} />
                      <b className="geo__cc">{r.id.slice(3)}</b>
                      <span className="geo__nm">{r.name}</span>
                      <span className="geo__t">
                        <i className="geo__b" style={{
                          width: `${(r.sessions / Math.max(...regions.map((x) => x.sessions), 1)) * 100}%`,
                          background: `color-mix(in srgb, ${TOK[t]} 55%, transparent)` }} />
                      </span>
                      <span className="num geo__n">{fmtN(r.sessions)}</span>
                      <em className={`geo__h geo__h--${t}`}>
                        {r.hit === 0 ? "clean" : `${(rate * 100).toFixed(1)}% hit`}
                      </em>
                    </button>
                  );
                })}

                {/* THE WAY BACK UP, AND THE WAY DOWN. The count is on the
                    button because "show more" without a number asks the
                    reader to click to find out whether it was worth it. */}
                {(geoHidden > 0 || geoAll) && (
                  <button type="button" className="geo__more"
                    style={{ order: 99999 }}
                    onClick={() => setGeoAll((v) => !v)}>
                    {geoAll ? "show fewer rows"
                      : `show ${fmtN(geoHidden)} more row${geoHidden === 1 ? "" : "s"}`}
                  </button>
                )}

                {/* The traffic light's rulebook used to print here, a
                    permanent two-line legend under a table whose every row
                    already carries its own verdict in its own tooltip. It was
                    a footnote asking for the space of a finding. Removed at
                    the reader's request; the thresholds still travel with
                    each pin and each row, where they describe something. */}
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
                    : `top screens · ${data.tf.label}${
                      (regionSel ? regionDetail : geoDetail)?.partial ? " · measuring…" : ""}`}</span>
                  <button className="geo__drill-x" aria-label="Close"
                    onClick={() => setGeoSel(null)}><XmarkIcon /></button>
                </div>

                {/* STATES, AND THE SESSIONS THAT HAVE NONE.
                    Coverage is stated first and always: measured on a live
                    estate, one application's US traffic was 419 sessions with
                    no state against 3 with one. A reader adding the states up
                    and finding less than the country is owed the reason — it
                    is a gap in what the platform resolved, not a missing
                    place — and without the line they would read it as a bug in
                    the numbers beside it. */}
                {regions !== null && (() => {
                  const total = geo?.find((g) => g.country === geoSel)?.sessions ?? 0;
                  /* NOT A SUM. A session is counted in every state it had
                     events in, so adding these up double-counts anyone who
                     moved — measured here, the states totalled 469 against a
                     country of 468. The honest line says what each state
                     holds and warns that they do not add up, rather than
                     publishing a coverage figure that is arithmetic nonsense
                     wearing the look of a measurement. */
                  return (
                    <div className="geo__sub">
                      <span className="geo__sub-l">
                        states
                        <em>{regions.length === 0
                          ? `none of this country's ${fmtN(total)} sessions carry a state`
                          : (regions.partial ? "measuring… · " : "")
                            + `${regions.length} recorded of ${fmtN(total)} sessions in the country`
                            + " — a session that moves between states is counted in each,"
                            + " so these do not add up"}</em>
                      </span>
                      {regions.length > 0 && (
                        <div className="geo__sub-rows">
                          {regions.slice(0, 8).map((r) => {
                            const rate = r.hit / Math.max(r.sessions, 1);
                            const open = regionSel === r.id;
                            return (
                              <button type="button" key={r.id}
                                className={open ? "geo__sub-r geo__sub-r--on" : "geo__sub-r"}
                                title={`${fmtN(r.sessions)} sessions from ${r.name}`
                                  + ` · ${(rate * 100).toFixed(1)}% met an error`
                                  + ` · ISO ${r.id}. Click for its cities.`}
                                onClick={() => setRegionSel((c) => (c === r.id ? null : r.id))}>
                                <span>{r.name}</span>
                                <b className="num">{fmtN(r.sessions)}</b>
                                <em className="num">{(rate * 100).toFixed(0)}%</em>
                              </button>
                            );
                          })}
                        </div>
                      )}
                      {/* CITIES ARE A LIST, NOT A MAP. They carry no ISO code,
                          and geo.location.latitude measured NULL on 100% of
                          rows — nothing can position them. */}
                      {regionSel && cities !== null && (
                        <div className="geo__sub-cities">
                          <span className="geo__sub-l">
                            cities in {regions.find((r) => r.id === regionSel)?.name ?? regionSel}
                            <em>no coordinate is recorded for a city, so these are counted, not mapped</em>
                          </span>
                          {cities.length === 0
                            ? <span className="geo__sub-none">no city recorded for these sessions</span>
                            : cities.slice(0, 10).map((c) => (
                              <span className="geo__sub-city" key={c.id}>
                                <span>{c.name}</span>
                                <b className="num">{fmtN(c.sessions)}</b>
                                <em className="num">
                                  {((c.hit / Math.max(c.sessions, 1)) * 100).toFixed(0)}%</em>
                              </span>
                            ))}
                        </div>
                      )}
                    </div>
                  );
                })()}
                {(() => {
                  /* WHOSE SCREENS THESE ARE. With a state open the list is
                     that state's, read from its own leg; with none open it
                     is the country's. The caption says which, because two
                     lists that look identical and count different things is
                     the one confusion this panel cannot afford. */
                  const rgName = regionSel
                    ? regions?.find((r) => r.id === regionSel)?.name ?? regionSel
                    : null;
                  const scoped = regionSel ? regionDetail : geoDetail;
                  if (!scoped || scoped.length === 0) return null;
                  const dmax = Math.max(...scoped.map((d) => d.sessions), 1);
                  /* The drill speaks the same traffic light as the map —
                   * green satisfied, yellow tolerating, red frustrated — and
                   * bar and word carry the same colour, so the eye needs no
                   * second read. The country's own rate is still COMPUTED,
                   * for the tooltip's "x% vs y% for the country"; it is a
                   * comparison the reader can see, not the verdict. */
                  const cTot = scoped.reduce((a, d) => a + d.sessions, 0) || 1;
                  const cRate = scoped.reduce((a, d) => a + d.hit, 0) / cTot;
                  /* ONE BASELINE AT EVERY DEPTH. The cities were judged
                     against their country (≥2×) or the absolute line; the
                     states against the absolute line; the countries against
                     the application. Three rules on one map — see
                     geoJudgeSub. Now every place, at every depth, answers
                     the same question: worse than this application? */
                  const toneOf = (d: { sessions: number; hit: number }) => geoJudgeSub(d, base);
                  /* bars are MARKS: the saturated half of the family, like
                     every other mark in the product */
                  const BAR = { good: "var(--good-fill)", warn: "var(--warn-fill)",
                    bad: "var(--bad-fill)" } as const;
                  return (
                    <div className="geo__drill-rows">
                      <span className="geo__sub-l">
                        {rgName ? <>top screens in {rgName}</> : <>top screens across {geoSel}</>}
                        <em>{rgName
                          ? `judged against ${rgName}'s own error rate, not the country's`
                          : "judged against this country's own error rate"}</em>
                      </span>
                      {/* the columns, named — same grid as the rows */}
                      <div className="geo__dr geo__dr--hd" aria-hidden="true">
                        <span>screen</span><span>share</span>
                        <span>sessions</span><span>affected</span>
                      </div>
                      {scoped.map((d) => {
                        const t = toneOf(d);
                        const noScreen = d.view === Q.NO_SCREEN;
                        return (
                          <button type="button"
                            className={`geo__dr geo__dr--btn${geoViewSel === d.view ? " geo__dr--on" : ""}`}
                            key={d.view}
                            onClick={() => setGeoViewSel((v) => (v === d.view ? null : d.view))}
                            title={noScreen
                              ? `${fmtN(d.hit)} ${geoSel} sessions met an error that belongs to no screen — app-level failures like ANR (the app frozen until the OS kills it). They count in the country's total, and a session opened from the list below may carry one of these instead of a screen's error.`
                              : `${fmtN(d.sessions)} sessions from ${geoSel} on ${d.view}${d.hit ? ` — ${fmtN(d.hit)} affected by an error (${((d.hit / Math.max(d.sessions, 1)) * 100).toFixed(1)}% vs ${(cRate * 100).toFixed(1)}% for the country)` : ""}. Click to set this screen as the filter — the button below opens the sessions.`}>
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
                {(regionSel ? regionDetail : geoDetail)?.length === 0 && (
                  <span className="geo__drill-none">
                    no screens recorded for {regionSel ? "this state" : "this country"} in the window
                  </span>
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
                            onClick={() => app && feName && openIntent(sessionsLink(data.tf, feName, x.n,
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
                                onClick: () => app && feName && openIntent(sessionsLink(data.tf, feName, 0,
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
                  /* THE SAME LIST THE READER CLICKED. Since the drill began
                     scoping its screens to the open STATE, the list on screen
                     comes from regionDetail — and this lookup went on reading
                     geoDetail, the COUNTRY's. So a screen with no errors in
                     the chosen state but errors elsewhere in the country kept
                     offering "inspect its errors", and changing locality
                     could not take the offer away: the locality was never
                     part of the question being asked. */
                  const selList = regionSel ? regionDetail : geoDetail;
                  const selRow = geoViewSel
                    ? selList?.find((d) => d.view === geoViewSel) : undefined;
                  const chasing = !!selRow && selRow.hit > 0;
                  const realScreen = !!geoViewSel && geoViewSel !== Q.NO_SCREEN;
                  return (<>
                  <button className="geo__drill-go" disabled={!feName}
                    title={!feName ? "resolving the sessions app's own name for this frontend…"
                      : chasing && realScreen
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
                      title={`${fmtN(selRow!.hit)} ${regionSel ? (regions?.find((r) => r.id === regionSel)?.name ?? geoSel) : geoSel} sessions met an error on ${geoViewSel} — the Error Inspector filters by screen (the Sessions list cannot), and every error there opens its session. The screen filter is exact; the country is not carried, so expect all countries' hits on this view.`}>
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
  /** Sessions per minute, read off the same series the bars draw. */
  sessionsPerMin: string;
  /** True while the Apdex bands came from a preview of the UX scan. */
  apdexPartial?: boolean;
  /** Which store the headline counted — see useImpacted. */
  sessionBase?: "sessions" | "events";
  /** True when the window sits inside the session store's write lag. */
  shortWindow?: boolean;
  errors: number; errorsPerMin: string;
  /** The fatal subset of `errors` — crashes end the session, ANRs freeze it
   *  until Android kills it. Mobile only, by what the types can occur on. */
  crashes: number; anrs: number;
  requests: number; reqFail: number; loadP50: number;
  /** Apdex over this application's user actions, or null when none were rated. */
  apdex: number | null;
  /** Why the score is absent, when it is — "•••" alone made a robot-only
   *  application on a live estate read as a rendering bug. */
  apdexNote?: string;
  /** The bands behind it — what the words under the score are built from. */
  apdexBands: { sat: number; tol: number; fru: number; ratedActs: number; errActions: number;
    crashes: number } | null;
  /** The application's ONE verdict (utils/verdict) — the same word and
   *  reason the page header prints. The hero leads with it. */
  verdictLabel: string; verdictReason: string;
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
  /** Each service's printable name and the name the Services Explorer filters
   *  on — null until the metric store has answered, and a name that cannot be
   *  resolved gets no link rather than a link that opens nothing. */
  svcLinks?: Array<{ label: string; filter: string | null }>;
  /** Of those sessions, the ones belonging to real people — null until the
   *  per-session leg has answered. The headline counts EVERYTHING, which is
   *  what makes it comparable to error-free beside it; this is what makes it
   *  comparable to Users & Sessions, which lists real users. */
  realSessions?: number | null;
  /** What the sessions hand-off will list — counted from user.sessions, the
   *  store the explorer reads, so the card can state it instead of leaving
   *  the reader to discover that two stores count two populations. */
  /** Opens one service's own page in the platform's Services app. */
  onOpenService?: (name: string) => void;
  /** The domains this application contacts, busiest first, with their volume. */
  domNames: Array<{ short: string; full: string }>;
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
      /* A CARD WITH NO VERDICT GETS NO VERDICT COLOUR. tone "info" means this
         card was never judged — there is no threshold behind "10.4k web
         requests" the way there is behind an error rate. It used to borrow
         the accent and breathe like the judged ones, which is a card looking
         as though it had an opinion it does not hold. Muted: neutral border,
         no breath. */
      className={`tk-block cc-mod${pulse ? " cc-mod--pulse" : ""}`
        + (tone === "info" ? " cc-mod--mute" : "")
        + (pick ? " cc-mod--pick" : "") + (active ? " cc-mod--on" : "")}
      {...(pick ? {
        /* THE CARD IS A CONTAINER, NOT A CONTROL. It used to carry
           role="button" and tabIndex itself, and then the service names were
           added inside it — a button inside a button, which assistive
           technology either announces confusingly or does not announce at
           all. Stopping key propagation made the inner links WORK without
           making the structure true.
           Now the card's own action is a button that covers it, exactly as
           the drill rows do: the card action and the service links are
           siblings, each with its own name, in the order they read. The
           pointer behaviour is unchanged — the whole card is still the
           target — and the keyboard gains what it never had, which is two
           separate stops instead of one ambiguous one. */
        onClick: pick,
      } : {})}
      style={{ ["--c" as string]: FVAR[tone],
               ["--breath" as string]: BREATH[tone] }}>
      {pick && (
        <button type="button" className="tk-block__hit"
          /* AND IT MUST NOT TOGGLE TWICE. The section still handles clicks,
             which is what lets the card's CONTENT stay hoverable and still
             open the breakdown. This button therefore has to keep its click
             to itself: without that, one press ran pick() here and again on
             the way up, and onMetric toggles — so selecting a card cleared
             the selection and re-selecting it cleared and restored it. The
             breakdown could not be opened at all. */
          onClick={(e) => { e.stopPropagation(); pick(); }}
          aria-pressed={!!active}
          title={`${active ? "Hide" : "Show"} the breakdown for `
            + (metric === "services" ? "the called services" : METRIC_LABEL[metric as Metric])}
          aria-label={`${title} — ${active ? "hide" : "show"} the breakdown`} />
      )}
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
 * wider — in a live estate shell they read as a solid slab instead of a chart.
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
  // the shared rule (utils/verdict.failTone), not a second copy of it
  const reqTone: Tone = failTone(reqRate);
  /* THE SCORE SHOWS ITS ARITHMETIC. Asked twice in production how the
     number is made, so the counts behind it travel with it: the hero's word
     and the card's stat carry the formula with this window's own figures as
     their tooltip, and the hero prints the three shares under the score. */
  const counts = p.apdexBands
    ? { satisfied: p.apdexBands.sat, tolerating: p.apdexBands.tol, frustrated: p.apdexBands.fru,
        crashes: p.apdexBands.crashes, errActions: p.apdexBands.errActions }
    : null;
  const apdexWords = counts ? scoreExplain(counts) : null;
  const apdexMix = counts ? scoreMix(counts) : null;
  /* WHERE THE HURT IS. Read off the user actions themselves (error.count /
     has_crash): the share that carried an error. On a fast application that
     still hurts people this is small — the errors are outside the actions
     (ANRs, background requests) — which is exactly why the speed score can
     read high while one session in three meets an error. */
  const errActs = p.apdexBands && p.apdexBands.ratedActs > 0
    ? p.apdexBands.errActions / p.apdexBands.ratedActs : null;
  const errActsLine = errActs === null ? null
    : `${errActs > 0 && errActs < 0.01 ? "<1" : Math.round(errActs * 100)}% of rated actions carried an error and were rated frustrated`;

  return (
    <div className="tk-mgrid cc" role="region" aria-label={`${p.name} overview card`}
      ref={wrapRef}>
      <div className="tk-col">
        <Module Icon={UserSessionsIcon} title="User experience"
          metric="sessions" active={p.detail === "sessions"} onPick={p.onMetric}
          spark={<><Bars vals={sess} times={times} label="sessions" fc={p.fcBars?.sessions} />
            <em className="tk-block__sparkv">{p.sessionsPerMin}/min<br />sessions</em></>}>
          <div className="tk-row2">
            <Stat v={fmtK(p.sessions)} l="sessions"
              title={`Sessions that STARTED in this window, counted from `
                + `user.sessions — the same store the Analyze user sessions `
                + `button opens, so this number and that list are the same `
                + `population. Robots and synthetic monitors are included, `
                + `because the error-free figure beside it shares this base.`
                + (p.realSessions != null
                  ? ` ${fmtN(p.realSessions)} of them belong to real people.` : "")
                + ` Two kinds of session are NOT here, both by the platform's `
                + `design: ones still running or closed less than ~30 minutes `
                + `ago, which the session aggregator has not written yet, and `
                + `ones with no navigation and no interaction at all, which it `
                + `never writes.`} />
            {/* UNAFFECTED, not "error-free": the share of sessions no error
                AFFECTED — none during the person's own actions, no crash or
                freeze. Background errors are counted on the errors card. */}
            <Stat v={pct} l="unaffected" tone={p.tone === "info" ? undefined : p.tone}
              title={"Sessions no error affected: no error during the person's own actions, "
                + "and no crash or freeze. Errors in the background — a request with no "
                + "action around it, an analytics beacon — are counted on the errors card "
                + "but do not hurt anyone, so they do not count here."} />
            {/* Apdex judges SPEED. It sits beside error-free on purpose: the
                two disagree often, and an application that is fast and broken
                should have to say both out loud. */}
            <Stat v={fmtApdex(p.apdex)} l={p.apdexPartial ? "experience · measuring" : "experience"}
              tone={p.apdex === null ? undefined : apdexTone(p.apdex)}
              title={p.apdex === null ? p.apdexNote : apdexWords ?? undefined} />
          </div>
          {/* THE OTHER BASE, ON THE SCREEN. A reader comparing this card with
              Users & Sessions found 427 here and 193 there, twice, and had to
              ask why — the answer lived in a tooltip, which is where answers
              go to be missed. The headline counts EVERY session, because the
              error-free percentage beside it has to share a base; this line
              carries the base the explorer uses. Two numbers a reader can
              compare are worth more than one they have to defend. */}
          {/* WHICH BASE, SAID ON THE CARD. The headline promises to be the
              number the sessions button opens — and on a short window the
              session store is still being written, so the count comes from
              the event scan instead and the list WILL show fewer. That is a
              fact about the platform's write lag, and it belongs next to the
              number it qualifies, not in a tooltip. */}
          {p.sessionBase === "events" && p.shortWindow && (
            <div className="tk-note"
              title={`Sessions are written to the platform's session store about `
                + `an hour after they go quiet. Inside a window this short the store `
                + `holds almost none of them yet, so this counts every session ACTIVE `
                + `in the window from the event stream. Users & Sessions reads the `
                + `store and will list fewer until they are written. Widen the window `
                + `past an hour and the two agree again.`}>
              active in this window
              <em className="tk-note__k"> the list fills in as sessions are written</em>
            </div>
          )}
          {p.realSessions != null && p.realSessions !== p.sessions && (
            <div className="tk-note"
              title={`The headline counts every session the platform listed `
                + `for this window, robots and synthetic monitors included, `
                + `because the error-free figure beside it shares that base. `
                + `This is the part belonging to real people.`}>
              {fmtK(p.realSessions)} real users
              <em className="tk-note__k"> of {fmtK(p.sessions)}</em>
            </div>
          )}
          {/* THE SCALE IS NOT A HEADLINE. This footnote repeated the band word
              already printed as the biggest thing on the screen, added the
              threshold, and did it in a column too narrow to hold it — so the
              reader met "Excellent · T = 3s · …", a sentence cut before it
              said anything. The whole of it, uncut, is the score's tooltip;
              the CONFLICT between a good score and hurt users still earns a
              line on the card, because that one is a finding. */}
          {p.apdex !== null && (() => {
            const hit = p.clean === null ? null : 1 - p.clean;
            const conflicted = p.apdex >= 0.85 && hit !== null && hit >= HIT_WARN;
            if (!conflicted) return null;
            return (
              <div className="tk-apdex">
                fast, and still hurting people — most of the harm is outside the
                rated actions (crashes, freezes); see unaffected
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
                Measured on a live estate: Astroshop Android had 289 crashes and
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
            {/* the provenance line EARNS its place: with no errors it said
                "all from this application's own code" about nothing at all */}
            {p.errors === 0 ? null
              : p.realErrors === 0
              ? "none reached a real user — robot and synthetic traffic only"
              : p.errorsThird > 0
                ? `${fmtK(p.errorsThird)} from third parties · `
                  + `${fmtK(p.errors - p.errorsThird)} from this application's own code`
                : "all from this application's own code or APIs"}
          </div>
        </Module>
      </div>

      <i className="tk-gap" aria-hidden="true" />

      {/* THE CORE IS THE APDEX, ALL THE WAY DOWN. It shows the Apdex, its arc
          fills to the Apdex, its colour is the Apdex's own band — and it used
          to breathe to the ERROR verdict, a different signal entirely. On an
          application that is fast and broken the centre pulsed alarm around a
          score reading EXCELLENT. The pace is the Apdex's now: one measure,
          one motion. Errors keep their own card, their own colour and their
          own wave on this ring. */}
      {/* the score in plain words, built from the same bands the number is, so
          the two can never disagree — it is the verdict word's tooltip now */}
      {/* THE HERO LEADS WITH THE VERDICT. It led with the experience score —
          a SPEED measure — and on a bank's production application printed
          EXCELLENT in green while the header beside it said Warning: one in
          three real-user sessions hit by errors. Two answers to "how is this
          application?" on one screen, and the louder one was the partial
          one. The hero now carries the application's ONE verdict
          (utils/verdict: errors, Davis problems and speed together), in its
          colour and its breathing pace; the score keeps its place as the
          caption, named for what it is. The ring's fill is still the score. */}
      <div className={`tk-core cc-core${p.apdex === null && p.tone === "info" ? " cc-core--mute" : ""}`}
        ref={coreRef}
        style={{ ["--t" as string]: FVAR[p.tone],
          ["--breath" as string]: BREATH[p.tone] }}>
        <div className="cc-corewrap" ref={ringRef}>
        {/* NOTHING MOVES BEFORE THE VERDICT. While the page measures, the ring
            drew a red wave from the early error rate and a score that was not
            in yet — an alarm before any finding. Neutral and still until the
            verdict lands; then the ring speaks the verdict's tone. */}
        <CoreRing host={ringRef}
          value={p.verdictLabel === "Measuring" ? null : p.apdex}
          tone={p.verdictLabel === "Measuring" ? "info" : p.tone}
          errPerMin={p.verdictLabel === "Measuring" ? 0 : Number(p.errorsPerMin)}
          errors={p.verdictLabel === "Measuring" ? 0 : p.errors} />
        <button className="tk-core__b" onClick={p.onOpen}
          aria-label={`${p.name} — ${p.verdictLabel}: ${p.verdictReason}; experience score ${fmtApdex(p.apdex)}, open its delivery chain`}>
          <i className="tk-core__ic">{p.isMobile ? <MobileIcon /> : <DesktopIcon />}</i>
          {/* The WORD leads — "Good" reads instantly where 0.92 needs a
              scale; the number moves to the caption for whoever audits it. */}
          {/* THE VERDICT WEARS ITS VERDICT. The biggest word on the screen was
              printed in neutral ink while every smaller verdict in the app is
              coloured — so the one thing a reader sees first said nothing by
              its colour. Excellent and Good are good, Fair warns, Poor and
              Unacceptable are critical: the same three tones the rest of the
              product speaks. It also carries the score in plain words as its
              tooltip, which used to be a line on the card repeating the
              number printed right above it. */}
          {/* "Measuring" is not a judgement: neutral ink, not the primary hue */}
          <b className="num tk-core__pct tk-core__pct--word"
            style={{ color: p.verdictLabel === "Measuring" ? "var(--ink-2)" : TVAR[p.tone] }}
            title={p.verdictReason}>
            {p.verdictLabel}</b>
          <span className="tk-core__why">{p.verdictReason}</span>
          {/* ONE LINE FOR THE SCORE. The card carried the score, its band, its
              three shares, its rated count and the share of actions with an
              error — five facts in three lines under the verdict, read as
              clutter in production. The line keeps the number and what it
              measures; everything else is its tooltip, with the arithmetic. */}
          <span className="tk-core__cap"
            title={[apdexWords, apdexMix, errActsLine && `${errActsLine} — read off each action's `
              + "own error fields. Errors outside any action (background requests) do not "
              + "enter the score; a crash or freeze counts against unaffected."]
              .filter(Boolean).join("\n\n") || p.apdexNote || undefined}>
            experience score {p.apdexPartial && p.apdex === null ? "…"
              : p.apdex === null ? "—" : fmtApdex(p.apdex)}</span>
          {/* The score, translated: what happens in every 100 things users
              do — built from the same bands the number is, so the words and
              the figure cannot disagree. Slowness and errors are named
              separately because they are fixed by different people. */}
          <span className="tk-core__nm">{p.name}</span>
          {/* What Davis detected, beside what we measured. Silence is stated
              too — "no Davis problems" is a finding, and leaving the line out
              would make its absence indistinguishable from not looking.
              The two halves are deliberately different kinds of fact: a
              PROBLEM is Davis judging a deviation against the baseline it
              learned; an ERROR is a thing a user actually received. An
              application can record thousands of errors and raise no problem
              when that is its normal level — read in production as "no
              problems, so no errors", until the drill-down showed otherwise.
              Naming Davis and printing the error count on the same line is
              what stops silence from one being read as absence of the other. */}
          <span className={`tk-core__prob${p.problems > 0 ? " tk-core__prob--on" : ""}`}>
            {p.problems > 0
              ? <>{p.problems} Davis problem{p.problems > 1 ? "s" : ""}
                  {p.problemCats.length > 0 && ` · ${p.problemCats.slice(0, 2).join(", ")}`}</>
              : <>no Davis problems
                  <span className="tk-core__prob-err">
                    {" · "}{p.errors > 0 ? `${fmtK(p.errors)} errors recorded` : "no errors recorded"}
                  </span></>}
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
            <em className="tk-block__sparkv">{p.series.length ? fmtK(reqs.reduce((a, v) => a + v, 0)) : "…"}
              <br />requests</em></>}>
          <div className="tk-row2">
            <Stat v={fmtK(p.requests)} l="web requests" />
            {/* THE SAME RULE THE MODULE USES, not a second one. This read
                `reqFail > 0 ? "bad"` — a COUNT test under a module whose own
                comment says a rate — so one failed call in 927k printed
                "0.0%" in red. A figure that rounds to zero must not be the
                loudest thing on the card; the shared thresholds decide, and
                a healthy rate carries no colour at all. */}
            <Stat v={p.requests > 0
                ? `${((p.reqFail / p.requests) * 100).toFixed(1)}%` : "—"}
              l="calls failed"
              tone={reqTone === "good" || reqTone === "info" ? undefined : reqTone} />
          </div>
          <div className="tk-note">{fmtMs(p.loadP50)} load <em>(p50)</em></div>
          {/* HOSTS, AND LABELLED AS HOSTS. These read exactly like the
              service names on the card beside this one, so the two cards
              looked like they were saying the same thing twice. They are
              the busiest HOSTS this application calls; the busiest
              ENDPOINTS are a click away, in the drill. */}
          {p.domNames.slice(0, 2).map((n) => (
            <div key={n.full} className="tk-note" title={n.full}>
              {n.short}<em className="tk-note__k"> host</em>
            </div>
          ))}
          {p.domNames.length > 0 && (
            <div className="tk-note tk-note--go">open for its endpoints →</div>
          )}

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
          {/* EACH NAME IS THE DOOR TO ITS OWN SERVICE. A service's overview
              is a page the platform already owns and this app has no business
              rebuilding — so the name opens it, filtered to that service, in
              the Services app. The click is stopped from reaching the card,
              whose own job is the projections panel below. */}
          {(p.svcLinks ?? p.svcNames.map((n) => ({ label: n, filter: null })))
            .slice(0, 2).map(({ label: n, filter }) => (
            filter == null ? (
              /* the metric store has not named it yet, or does not know it:
                 a link that cannot be built is not offered */
              <div key={n} className="tk-note" title={n}>{n}</div>
            ) : (
            <button key={n} type="button" className="tk-note tk-note--link"
              title={`Open ${n} in the Services app`}
              /* No key guard here any more: the card stopped being a button
                 around this one, so Enter and Space arrive where they were
                 aimed. A native button needs no help to be pressed. */
              onClick={(e) => { e.stopPropagation(); p.onOpenService?.(filter); }}>
              {n}<em className="tk-note__k"> service →</em>
            </button>
            )
          ))}
          {/* Not the browser's request series relabelled: this is
              dt.service.request.count summed over the services this
              application actually calls. */}

        </Module>
      </div>

      {/* THE LEGEND MOVES OFF THE CANVAS. Two dense lines explaining the card
          language sat under every screen, and the reader reads them once. It
          is not DELETED — the thresholds it carries are the app's own rule and
          stating the rule is a principle here — it becomes the key you can
          open, closed by default. */}
      <details className="cc-motion">
        {/* The build stamp lived here for one version and moved to the
            header, where it is on screen at every scroll position and on
            every tab. One stamp is enough; two is clutter on a key line. */}
        <summary>what the motion and the colours mean</summary>
        <span>
          every motion is a measurement · ring fill = experience score (speed) ·
          hero colour and breathing pace = the application's verdict ·
          wave = error rate · icon knock = a failing signal on that box ·
          pulsing forecast = rising · bright bar = the interval still
          accruing · click a box for its breakdown
          <br />{VERDICT_LEGEND}
        </span>
      </details>
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
  /* "Domains" was true until this panel started grouping by endpoint; a
     title that names the wrong unit turns a correct table into a wrong one,
     because the reader compares its rows against the card's host totals and
     finds them short. */
  const TITLE: Record<DetailMetric, string> = {
    sessions: "Views", errors: "Failures", requests: "Endpoints",
  };
  const UNIT: Record<DetailMetric, string> = {
    sessions: "actions", errors: "errors", requests: "requests",
  };
  const max = Math.max(...(rows ?? []).map((r) => r.vol), 1);
  /* FULL NAMES ON DEMAND. An endpoint list is a column of near-identical
     prefixes whose ending is the whole point, and the ellipsis eats exactly
     that. Widening the column for everyone would starve the numbers, so the
     reader asks: the names then wrap instead of truncating and the name
     column takes the share the bar can spare. */
  const [wide, setWide] = useState(false);

  /* DRAGGABLE COLUMNS. The toggle above makes names wrap, which a reader
     asked for and then told me was not the thing: they wanted to MOVE the
     divider. Fair — these endpoint names differ in their last twenty
     characters and no automatic width rule knows how much of a hostname a
     given reader needs to see.
     The header and the rows are one grid, so the widths live in a custom
     property on the panel and both follow it. They start as whatever the
     automatic layout measured, so grabbing a divider continues the layout
     rather than replacing it with numbers out of nowhere. */
  const hdRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [cols, setCols] = useState<number[] | null>(null);
  /* MEASURE THE WIDEST ROW, NOT THE HEADER.
     The first cut froze the widths the HEADER cells happened to have, and the
     header says "response time" where the row says "p50 865ms · p90 1.5s p95
     4.7s". Those tracks were narrower than the data, the numeric cells do not
     wrap, and they spilled over their neighbours — the reader saw
     "p9054576s", three readings printed on top of each other.
     Every row is its own grid, so the resolved tracks are read per row and the
     widest wins. Nothing is frozen until a divider is actually grabbed: until
     then the automatic layout is in charge, which is what sizes those cells
     correctly in the first place. */
  const measure = (): number[] | null => {
    const root = rootRef.current;
    if (!root) return null;
    let best: number[] | null = null;
    let budget = 0;
    for (const r of root.querySelectorAll<HTMLElement>(".svcf__row")) {
      const t = getComputedStyle(r).gridTemplateColumns.split(" ").map(parseFloat);
      if (!t.length || t.some((n) => !Number.isFinite(n))) continue;
      // the first row read gives the width the table ACTUALLY has to spend;
      // every row resolves to the same total, gaps excluded
      if (!budget) budget = t.reduce((a, b) => a + b, 0);
      best = best ? best.map((w, i) => Math.max(w, t[i] ?? 0)) : t;
    }
    if (!best || best.length < 2 || !budget) return null;
    /* THE WIDTHS MUST STILL ADD UP TO THE TABLE.
       Taking the widest track of every row gives each column the room its
       longest row wanted — and their SUM is then wider than the table, so
       freezing those numbers pushed the last columns off the right edge.
       Dragging looked like it broke the layout; the layout was already
       over-committed and the drag only made it visible. The proportions are
       kept and scaled back into the budget. */
    const total = best.reduce((a, b) => a + b, 0);
    return total > budget ? best.map((w) => (w * budget) / total) : best;
  };

  const drag = (i: number) => (e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    const start = cols ?? measure();
    if (!start) return;
    if (!cols) setCols(start);
    const base = [...start];
    const x0 = e.clientX;
    const move = (ev: PointerEvent) => {
      const next = [...base];
      /* A ZERO-SUM DRAG. What one column gains its neighbour gives, and the
         movement is bounded by what the neighbour can actually spare — so the
         total never changes and no column can be pushed out of the table.
         Clamping the two sides independently, as this did, let the sum drift
         on every drag that hit a floor. */
      const MIN = 56;
      const room = (base[i + 1] ?? 0) - MIN;
      const give = base[i] - MIN;
      const dx = Math.max(-give, Math.min(ev.clientX - x0, room));
      next[i] = base[i] + dx;
      if (base[i + 1] != null) next[i + 1] = base[i + 1] - dx;
      setCols(next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const gridVar = cols
    ? ({ "--svcf-cols": cols.map((n) => `${n}px`).join(" ") } as React.CSSProperties)
    : undefined;

  return (
    <div className={`svcf${wide ? " svcf--wide" : ""}`} style={gridVar} ref={rootRef}>
      <div className="mch__hd">
        <span className="mch__t">{TITLE[metric]}
          <em>· {tf.label}, busiest first
            {metric === "requests"
              ? " · one row per endpoint, so these do not add up to a host's total"
              : ""}</em></span>
        <span className="mch__fc">
          {rows === null ? "measuring…" : `${rows.length} shown`}
        </span>
        <button className="svcf__wide" onClick={() => setWide((w) => !w)}
          aria-pressed={wide}
          title={wide ? "Trim the names back to one line"
            : "Show each name in full — they wrap instead of being cut"}>
          {wide ? "trim names" : "full names"}
        </button>
        <button className="mch__x" onClick={onClose} aria-label="Close"><XmarkIcon /></button>
      </div>

      {rows !== null && rows.length === 0 && (
        <div className="svcf__note">Nothing recorded for this card in this window.</div>
      )}

      <div className="svcf__rows">
      {/* EVERY TABLE NAMES ITS COLUMNS. These rows carried five values and
          not one label: a reader had to infer the schema from the data, and
          the units differ per metric. The header rides the rows' own grid, so
          the names sit over the numbers they belong to. */}
      <div className="svcf__row svcf__hd" ref={hdRef}>
        {[TITLE[metric].toLowerCase(), "share", UNIT[metric],
          metric === "errors" ? "reached a user" : "response time",
          metric === "errors" ? "kind" : "failures"].map((h, i, all) => (
          <span key={h + i}>{h}
            {/* the divider: present on every column but the last, since the
                last has no neighbour to take width from */}
            {i < all.length - 1 && (
              <i className="svcf__grip" onPointerDown={drag(i)}
                role="separator" aria-orientation="vertical"
                title="Drag to resize this column" />
            )}
          </span>
        ))}
      </div>
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
           * estate's applications. */
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
          const errs = { label: "Errors on this view",
            proves: `${Math.round(errRate * 100)}% of its actions failed`,
            href: errorsExplorerHref(tf, appName, r.name) };
          /* THE REQUEST DRILL FILTERS ON server.address, WHICH IS A HOST.
             The probe was corrected to ask about hosts and this was left
             asking about endpoints — rowDrilldown builds its span filter from
             row.name, so an instrumented endpoint like api.example.com/orders
             enabled a link that searched for that whole string as an address
             and found nothing. Same mistake as the probe, one layer along: a
             fix applied to the question and not to the filter. The endpoint
             stays on screen; only what the drill FILTERS by becomes the
             host. */
          const perf = rowDrilldown(
            KIND[metric],
            { ...r, hasSpans: !!tracedDomains?.has(r.domain ?? r.name),
              /* the HOST still names the row for the span lookup; the
                 ENDPOINT rides beside it, for the filter */
              ep: metric === "requests" ? r.name : undefined,
              name: metric === "requests" ? (r.domain ?? r.name) : r.name },
            tf, appEntity, metric === "errors" ? "fail" : "time", appName);
          /* A VIEW GOES TO THE PAGE THAT OWNS IT. Until now a view row led
             either to the Error Inspector or to the traces, depending on how
             much of it had failed — two destinations that both describe a
             view from the outside. The platform has a page about the view
             itself, and the reader asked for it: Experience / Vitals, that
             frontend, that view, this window. It replaces the choice rather
             than joining it. */
          const vitals = metric === "sessions"
            ? viewVitalsHref(tf, appEntity, r.name) : null;
          const leadsWithErrors = metric === "sessions" && errRate >= HIT_WARN;
          const dd = vitals
            ? {
                label: "Open this view's vitals",
                meta: `Experience · ${r.name} · ${tf.label}`,
                proves: "how this view performs for real users, over this window",
                href: vitals, payload: {}, keyProperties: [], viaHref: true,
                app: "Experience",
              } satisfies DeepLink
            : leadsWithErrors ? errs : perf;
          /* ONE DOOR. The row used to carry a second, smaller link — "errors"
             or "performance" — appearing on hover beside the count, so the
             reader could take the route the row had not chosen for them.
             With the view's own vitals page as the destination that choice
             has nothing left to resolve, and a chip that appears under the
             cursor over a row that is already a link was reading as a third
             thing to decide. Removed at the reader's request. */
          /* The sentence a row without a destination owes the reader. */
          const noDrill = metric === "requests"
            ? (r.domain
                ? `No server-side traces behind ${r.domain}: no span in this `
                  + `window carries it as a server address. That is what a `
                  + `third party, a CDN or an uninstrumented backend looks `
                  + `like from here — the browser's side is measured, the `
                  + `other side is not ours to open.`
                : "No host recorded for this endpoint, so there is nothing to "
                  + "look for on the server side.")
            : metric === "errors"
              ? (r.named === 0
                  ? "This failure carries no error name of its own — the name "
                    + "on the row was written here, from what the record did "
                    + "carry. The Error Explorer lists errors BY name, so it "
                    + "would open on nothing."
                  : "No destination for this row.")
              : ((r.errors ?? 0) === 0
                  ? "Nothing failed on this view in this window."
                  : "No destination for this row.");

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
          /* NOT AN ANCHOR AROUND AN ANCHOR. The row was an <a>, and 0.9.39
             put the second lens inside it — interactive content nested in a
             link, which is invalid and which browsers resolve by ignoring one
             of them. The row is a container now: the primary is a link that
             covers it, the secondary sits beside that link rather than within
             it, and both are reachable by keyboard in the order they read. */
          return React.createElement("div", {
            key: r.name,
            className: `svcf__row${r.failures || r.real ? " svcf__row--warn" : ""}`
              + (dd ? " svcf__row--go" : ""),
          }, <>
            {dd && (
              /* THE LINK NO LONGER CONTAINS THE ROW'S TEXT, so its name has
                 to carry it. Without this every row announced the same thing
                 — "Where the time goes — where this view spends its time" —
                 and a reader moving between links could not tell which view
                 each one opened. */
              /* the cells above this are transparent to the pointer, so a
                 truncated name can only be read from HERE — the title has to
                 carry it, not just the accessible name */
              <a className="svcf__hit" aria-label={`${r.name} — ${dd.label}: ${dd.proves}`}
                title={`${r.name}\n${dd.label} — ${dd.proves}`}
                {...rowProps} />
            )}
            {/* The tag lives INSIDE the name cell. As a sibling it became a
                sixth child of a five-column positional grid — every cell
                slid one column over, the name landed centred in the bar's
                track and the fatal note wrapped onto a second grid row. The
                reader saw it as "muitos espaços desnecessários", and it was
                literally the layout misaligned. */}
            {/* WHY A ROW GOES NOWHERE, ON THE ROW ITSELF. Some endpoints have
                no drill-down and the reason used to be visible for free: the
                hostname was printed in the name, and a reader could see that
                firebase and firelog are not this estate's backends. Taking
                the host off the row took the explanation with it, so the row
                now says it in its tooltip instead of merely going quiet. */}
            <span className="svcf__nm"
              title={dd
                ? (metric === "requests" && r.domain && r.domain !== r.name
                    ? `${r.name}\non ${r.domain}` : r.name)
                : `${r.name}\n${noDrill}`}>
              {metric === "errors" && (r.type === "crash" || r.type === "anr") && (
                <b className="svcf__fatal">{r.type === "anr" ? "ANR" : "CRASH"}</b>
              )}
              {r.name}
              {/* NO HOST ON THE ROW. Every endpoint in this panel shares
                  one, so printing it eight times spent the column on the
                  identical part and truncated the only part that differs.
                  It survives in the row's tooltip and in the trace hand-off,
                  which is where it is actually needed. */}
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
            ? "failures come from the error records: request events on a live estate "
              + "carry only 2xx, so counting 4xx off them would always read zero"
            : `experience rated by the platform per action · the bar is share of user actions`}
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
        <button className="mch__x" onClick={onClose} aria-label="Close"><XmarkIcon /></button>
      </div>

      <div className="svcf__rows">
      <div className="svcf__row svcf__hd" aria-hidden="true">
        <span>service</span>
        <span>share</span>
        <span>projected</span>
        <span>measured now</span>
        <span>failures</span>
      </div>
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
          /* the anchor waits for the metric-store name — the Smartscape
           * label can differ from dt.service.name, and a link built on it
           * opened an Explorer filtered to nothing that read as working */
          const svcHref = v?.name ? servicesExplorerHref(tf, v.name) : undefined;
          return (
            <a key={r.id} href={svcHref} target={svcHref ? "_blank" : undefined}
              rel="noreferrer"
              title={svcHref ? `${r.name} — open in the Services Explorer`
                : `${r.name} — resolving its Explorer name…`}
              aria-disabled={svcHref ? undefined : true}
              className={`svcf__row svcf__row--go${failRising ? " svcf__row--warn" : ""}`}>
              <span className="svcf__nm" title={r.name}>{r.name}</span>
              <span className="svcf__bar" aria-hidden="true">
                <i style={{ width: `${((r.thr?.total ?? 0) / max) * 100}%` }} />
              </span>
              <span className="svcf__v">
                {!r.done ? <em className="dim">measuring…</em>
                  /* "≈ 0 requests" beside a card counting 23.4k service calls
                     was the app contradicting itself. The two read different
                     sources — the card counts TRACES, this projects
                     dt.service.request.count from the metric store — and for
                     a service with no such metric published the analyzer
                     forecasts zero and calls it VALID, correctly. Zero is
                     coming and this is not measured here are different
                     sentences, and only the second one is true. */
                  : r.thr?.emptyInput
                    ? <em className="dim">no request metric for this service</em>
                  : r.thr ? <>≈ {fmtK(Math.round(r.thr.total))} <em>requests</em></>
                  : <em className="dim">no sound forecast</em>}
                {r.thr && !r.thr.emptyInput && <em className={rising ? "svcf__tr--up" : "dim"}>
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
