// Delivery chain: 7 layers built from Smartscape and enriched with Davis
// problems, custom alerts and extension events.
import React, { useMemo, useRef, useState, useEffect } from "react";
import { fmtK, fmtMs, fmtN, perfScore } from "../utils/dql";
import { appHomeHref, intentsAvailable, investigationPaths, kindOf,
  KIND_LABEL as ENTITY_WORD, open,
  type Persona, type Route } from "../utils/links";
import { useFrontendNames } from "../hooks/useFrontendNames";
import { useDbEntities } from "../hooks/useDbEntities";
import { useLayerStats } from "../hooks/useLayerStats";
import { useJourneys } from "../hooks/useJourneys";
import { useQuietProbe } from "../hooks/useQuietProbe";
import type { ChainData } from "../hooks/useChainData";
import { usePanZoom } from "../hooks/usePanZoom";
import { useAssist } from "../hooks/useAssist";
import { type AppMap, useApps } from "../hooks/useApps";
import { useAppScope, type AppScope } from "../hooks/useAppScope";
import { useAppForecast } from "../hooks/useForecast";
import { useImpacted, type Impacted } from "../hooks/useImpacted";
import { useCloudScope, type CloudPlacement } from "../hooks/useCloudScope";
import { useDataStores, type DataStore } from "../hooks/useDataStores";
import { useDbEntity } from "../hooks/useDbEntity";
import { useGen2Closure, type Gen2Service } from "../hooks/useGen2Closure";
import { davisCategory, HIT_BAD, HIT_WARN, verdictOf, worseOf, type Tone } from "../utils/verdict";
import { useNodeMetrics, type MetricTarget } from "../hooks/useNodeMetrics";
import { useDomainTraces } from "../hooks/useDomainTraces";
import { aheadOf, type Forecast } from "../utils/forecast";
import type { SvgIconProps } from "@dynatrace/strato-icons";
import {
  ApplicationsIcon, AutomationEngineIcon, ContainerIcon, DatabaseIcon, DesktopIcon, TerminalIcon,
  HostsIcon, InternetIcon, MobileIcon, NetworkIcon, NodeIcon,
  ServicesIcon, SyntheticMonitoringSignetIcon, UserSessionsIcon,
} from "@dynatrace/strato-icons";

// info is not a judgement, so it renders in ink — colour means good/warn/bad only
const TVAR: Record<Tone, string> = { good: "var(--good)", warn: "var(--warn)", bad: "var(--bad)", info: "var(--ink-2)" };

/** Layer name, one-line role, and the stage verb shown above the pillar. */
/** Identity hue per layer — a sweep around the colour wheel, cold to warm. */
// One identity colour for every layer. The seven-hue sweep read as seven
// judgements — the user cannot tell an identity colour from a warning at a
// glance, so identity stays neutral and colour is reserved for good/warn/bad.
const TIER_HUE = [
  "--ink-2", "--ink-2", "--ink-2", "--ink-2", "--ink-2", "--ink-2", "--ink-2",
  "--ink-2",
];

export const TIERS: Array<[string, string, string]> = [
  ["User & device", "who consumes it", "Consume"],
  ["Network & third parties", "path to the edge", "Transport"],
  ["Application (RUM)", "code in the browser", "Render"],
  ["Edge / ingress", "traffic entry point", "Route"],
  ["Services", "business logic", "Serve"],
  ["Runtime", "pods and containers", "Run"],
  ["Infrastructure & cloud", "nodes, hosts and provider", "Host"],
  // The eighth layer exists only where the machinery has a provider behind it.
  // Measured on this tenant: 7 of 49 hosts do; for the other 42 the chain ends
  // at Infrastructure rather than showing an empty column.
  ["Cloud", "where the machine lives", "Provider"],
];

/** The platform's own icon per layer — and per node kind below. */
/** The layer's name where a reader can see it — "layer 05" was jargon. */
const TIER_NAME = ["Consume", "Transport", "Render", "Route",
  "Serve", "Runtime", "Infrastructure", "Cloud"] as const;
const LAYER_ICON = [
  UserSessionsIcon, InternetIcon, ApplicationsIcon, NetworkIcon,
  ServicesIcon, ContainerIcon, HostsIcon, AutomationEngineIcon,
] as const;

/**
 * The classic serviceType, in words.
 *
 * The platform's own vocabulary, lowercased — DATABASE_SERVICE is a database
 * and QUEUE_LISTENER_SERVICE is a queue listener, and inventing friendlier
 * names for them would only stop the reader finding the same thing in the
 * platform. Anything unmapped falls through as itself rather than as "other".
 */
const KIND_LABEL = (kind: string): string => kind
  ? kind.replace(/_SERVICE$/, "").replace(/_/g, " ").toLowerCase()
  : "service";

/** The icon a node wears: its layer's, refined by what the node actually is. */
function nodeIcon(ti: number, n: { nm: string; store?: string; gen2Db?: boolean }): React.ComponentType<SvgIconProps> {
  if (ti === 0) {
    if (n.nm === "Mobile") return MobileIcon;
    /* Not AutomationEngineIcon: that glyph is the AutomationEngine PRODUCT
     * logo — its native tooltip literally reads "AutomationEngine" over a
     * node called Robots. Strato ships no robot; Terminal is the honest
     * stand-in for scripted, machine-driven traffic, and brands nothing. */
    if (n.nm === "Robots") return TerminalIcon;
    if (n.nm === "Synthetic") return SyntheticMonitoringSignetIcon;
    return DesktopIcon;
  }
  // a store shares the Services layer but is not a service — and a classic
  // service that IS a database gets the same icon, since it is the same thing
  if (n.store || n.gen2Db) return DatabaseIcon;
  if (ti === 6) return /host/i.test(n.nm) ? HostsIcon : NodeIcon;
  return LAYER_ICON[ti];
}

interface Elo {
  nm: string; mt: string; v: string; tone: Tone; miss?: boolean;
  /** Set on the layers keyed by url.domain rather than by a Smartscape id. */
  domain?: string;
  det: Array<[string, string]>;
  /** Smartscape/entity ids this link represents — signals are matched against these. */
  ids?: string[];
  /** The analyzer's 12-hour projection, drawn on the card as a dashed line. */
  spark?: { pts: number[]; rising: boolean };
  /** Measured volume, for node sizing — sessions, requests or traces. */
  vol?: number;
  /**
   * A data store drawn inside the Services layer, keyed by the address the
   * caller dialled. The Serve layer holds three kinds of card now, and the
   * edge pass has to tell them apart: neither a store nor a classic-only
   * service is fed by the ingress — both are fed by the service beside them.
   */
  store?: string;
  /** A service only the classic topology knows: entered from its caller. */
  gen2?: string;
  /** …and whether that service is a data store, which decides its icon. */
  gen2Db?: boolean;
  /**
   * Which visual group of the Serve column this card sits in. The column
   * holds three natures — services, classic-topology (mainframe) elements,
   * data stores — and they were only tellable apart by reading each card's
   * subtitle. A divider is drawn where the group changes.
   */
  grp?: "classic" | "stores";
}

/**
 * How many cards a layer draws before the rest fold into "+N more".
 *
 * Module-level because it is not only a display limit: an edge can anchor only
 * to a drawn card, so anything past this cap loses its connections too. The
 * Serve layer has to know the number while it decides what to show.
 */
const NODE_CAP = 12;

/** A layer: every element it holds, plus the summary shown on the pillar. */
interface Layer {
  items: Elo[];
  /** Real population of this layer, even when only a few items are listed. */
  total: number;
  kpi: string;
  kpiLabel: string;
  tone: Tone;
}
// a layer wears its worst card's verdict — ordering lives in utils/verdict.ts
const worstOf = (items: Elo[]): Tone =>
  items.reduce<Tone>((acc, i) => worseOf(acc, i.tone), "good");

/**
 * Traffic origin, from RUM's own fields. One classifier for sessions and for
 * requests, so a "Robots" card and its outgoing edges agree with each other.
 */
export type Origin = "Browsers" | "Mobile" | "Robots" | "Synthetic";
export const originOf = (agent?: string | null, utype?: string | null): Origin => {
  if (/mobile|ios|android/i.test(agent ?? "")) return "Mobile";
  if (/robot/i.test(utype ?? "")) return "Robots";
  if (/synthetic/i.test(utype ?? "")) return "Synthetic";
  return "Browsers";
};
const ORIGIN_META: Record<Origin, string> = {
  Browsers: "real users on the web",
  Mobile: "native mobile apps",
  Robots: "bots and load generators",
  Synthetic: "monitors replaying journeys",
};

/** A measured flow between two rendered cards. */
interface Edge {
  s: [number, number]; t: [number, number]; v: number; label: string;
  /** The route's own casualties: failed requests, or sessions that met an
   *  error, riding THIS leg. undefined = not measured for this edge kind;
   *  null = still loading. Free — every count already sits in the rows the
   *  edge volumes come from. */
  bad?: number | null;
  /** True when the app has failed calls that carry no domain — a leg whose
   *  own count is 0 cannot claim "clean" while failures sit unattributed. */
  blind?: boolean;
  /** The leg's median latency, when the same rows carry one (ns). */
  p50?: number;
  /** The tail — speaks when the median is 0 (measured: over half of the
   *  first-party requests report zero duration). */
  p90?: number;
  /** The leg's volume in the SECOND half of the window — the free trend
   *  split the queries now carry. null: unknown (cached payload from before
   *  the column, or a shifted window where a trend is not a forecast). */
  late?: number | null;
}

/** Entity ids a Davis problem points at. */
const problemIds = (p: { entityIds: string[] | null }) => p.entityIds ?? [];

/** Builds the 7 layers from the loaded live data. */
/**
 * Does this classic-only service earn its own card? The same database must
 * not be drawn twice: when a classic DATABASE service's significant name
 * tokens appear in a store card's namespace or address (measured: derby @
 * ls-ub-lb4ac00v vs "MF easyTravelBusiness", one physical DB as two boxes),
 * the store card — which carries measured calls and latency — keeps it.
 * Shared by the tier builder AND the backend row's "N topology-mapped" sub,
 * so the count can never disagree with the cards (it once said 2 over 0).
 */
function gen2CardKept(g: Gen2Service, stores: DataStore[] | null): boolean {
  if (!/DATABASE|DATASTORE/.test(g.kind) || !stores?.length) return true;
  const gt = g.name.toLowerCase().replace(/[^a-z0-9]+/g, " ")
    .split(" ").filter((t) => t.length >= 4);
  return !stores.some((st) => {
    const hay = ` ${(st.ns ?? "")} ${st.store} `.toLowerCase();
    return gt.length > 0 && gt.some((t) => hay.includes(t));
  });
}

function buildTiers(d: ChainData, appId: string, scope: AppScope, ahead: Forecast | null,
  impacted: Impacted | null, cloud: CloudPlacement[] | null,
  stores: DataStore[] | null, gen2: Gen2Service[] | null,
  /** store address → resolved DB entity ids (batched Smartscape lookup),
   *  so database health alerts can light store cards. */
  dbIds?: Map<string, { id: string; classic?: string }> | null,
  /** 24h probe for a window with zero sessions — "quiet" vs "uninstrumented"
   *  are different findings and the empty card must say which. */
  quiet?: { sessions: number; last: string | null } | null,
  /** A third-party-TAGGED domain proven to be this app's own backend —
   *  spans with server.address == domain exist (measured: the Android app's
   *  only domain carries 93,250 spans over 2 of its services in 30m, yet
   *  RUM tags it third_party). Promoted, it feeds the Route layer instead
   *  of leaving it "No coverage". */
  promotedFp: string | null = null,
): { layers: Layer[]; edges: Edge[] } {
  const app = d.apps.find((a) => a.appId === appId);
  // Layers 1, 2 and 4 come from RUM, which now carries the application id —
  // "exactly what refers to this application" starts with not showing another
  // application's CDN under this one's chain.
  /* The Consume layer reads the ORIGIN rows, not the device-profile rows.
   *
   * Profiles are a top-20 over the whole environment — grouped by application
   * and resolution and pixel ratio and orientation, twenty rows is a handful
   * of the busiest applications. Measured on guu84124: 248 profile rows across
   * 14 applications, the top twenty covering seven of them. easyTravel
   * mainframe has 431 sessions and 26 profile rows, none of which survive the
   * cut, so this layer drew "No coverage" while the Sessions app listed those
   * sessions with their browsers. The origin rows are grouped only by origin —
   * at most four per application, which no limit can truncate. */
  const devices = d.origins.filter((r) => r.appId === appId);
  const domains = d.domains.filter((r) => r.appId === appId);
  const devSessions = devices.reduce((a, r) => a + r.sessions, 0);

  /* ── measured harm, per origin ──
   * MEASURED now, per origin row (qOrigins carries max-error-per-session
   * summed by origin). The audit caught the old form: a proportional split
   * of the app-wide count, worn as an exact number on cards and edges. The
   * estimate survives only as the fallback for cached payloads written
   * before the column existed. Null while nothing has arrived — a node must
   * never be painted green because the evidence has not come. */
  const realSessions = devices.reduce((a, r) => {
    const o = originOf(r.agent, r.utype);
    return o === "Browsers" || o === "Mobile" ? a + r.sessions : a;
  }, 0);
  const hitPerOrigin = (o: Origin, total: number): number | null => {
    const rows = devices.filter((r) => originOf(r.agent, r.utype) === o);
    if (rows.length > 0 && rows.every((r) => r.hit != null)) {
      return Math.min(rows.reduce((a, r) => a + (r.hit ?? 0), 0), total);
    }
    if (!impacted) return null;
    if (o === "Robots") return Math.min(impacted.hitRobot, total);
    if (o === "Synthetic") return Math.min(impacted.hitSynth, total);
    return realSessions > 0
      ? Math.min(Math.round(impacted.hitReal * (total / realSessions)), total) : 0;
  };

  // rows arrive split by origin for the edges; cards aggregate per domain.
  // err now counts failed CALLS (fetch-source errors); on tenants whose
  // error events carry no url.domain they arrive under domain "" — those
  // failures are real but unattributable, so they gate the "clean" word
  // instead of joining a domain's tally.
  let unattribErr = 0;
  const domAgg = new Map<string, { domain: string; provider: string | null;
    reqs: number; p50: number; p90: number; err: number; bytes: number;
    late: number | null }>();
  for (const r of domains) {
    if (!r.domain) { unattribErr += r.err; continue; }
    const cur = domAgg.get(r.domain);
    if (cur) {
      // the DOMINANT segment's p50 names the domain — max() once let a
      // 39-request synthetic sliver (4.9ms) caption 922k real requests (~0ms);
      // per-segment p50s cannot be merged into a true p50, so the honest
      // approximation is the one that describes almost all of the traffic
      if (r.reqs > cur.reqs) { cur.p50 = r.p50; cur.p90 = r.p90; }
      cur.reqs += r.reqs; cur.err += r.err; cur.bytes += r.bytes;
      // one unknown half poisons the sum — a partial "late" would trend on
      // a fraction of the traffic while claiming the whole
      cur.late = cur.late == null || r.late == null ? null : cur.late + r.late;
    }
    else domAgg.set(r.domain, { domain: r.domain, provider: r.provider,
      reqs: r.reqs, p50: r.p50, p90: r.p90, err: r.err, bytes: r.bytes,
      late: r.late ?? null });
  }
  /* Latency with its dignity. Measured on this tenant: over half of the
   * 916k first-party requests report ZERO duration, so the median is 0 and
   * a bare "0ms" was truth wearing the clothes of nonsense. When the median
   * is silent the tail speaks, labelled as itself; the ledger says WHY. */
  const latShort = (p50: number, p90: number) =>
    p50 <= 0 && p90 > 0 ? fmtMs(p90) : fmtMs(p50);
  const latRows = (p50: number, p90: number): Array<[string, string]> =>
    p50 <= 0 && p90 > 0
      ? [["p50", "0ms — over half of these requests report zero duration"],
         ["p90", fmtMs(p90)]]
      : [["p50", fmtMs(p50)], ...(p90 > 0 ? [["p90", fmtMs(p90)] as [string, string]] : [])];
  const domList = [...domAgg.values()].sort((a, b) => b.reqs - a.reqs);
  const firstParty = domList.find((x) => x.provider === "first_party")
    ?? (promotedFp ? domList.find((x) => x.domain === promotedFp) : undefined);
  const others = domList.filter((x) => x !== firstParty);
  const fanOut = d.calls.reduce<Record<string, number>>((acc, c) => {
    acc[c.src] = (acc[c.src] ?? 0) + 1; return acc;
  }, {});
  // ids de entidade por elo — é o que liga cada sinal ao seu dono
  const svcIdOf = new Map<string, string>();
  d.calls.forEach((c) => { svcIdOf.set(c.src, c.srcId); svcIdOf.set(c.dst, c.dstId); });

  // When the application's backend is known, the lower layers narrow to it.
  // Unresolved means "we could not tell", not "nothing" — showing the whole
  // environment is the honest fallback, never an empty chain.
  // Loading is NOT "we could not tell": while the scope query runs, nothing is
  // in scope, so the lower layers stay empty and say they are measuring rather
  // than flashing the whole environment under the newly selected application.
  const inScope = (id?: string) =>
    scope.loading ? false : !scope.resolved || !id || scope.services.has(id);

  // Resolved scope: EVERY service the application's traces reach, by traces —
  // built from the scope itself, not from call edges. A leaf service receives
  // calls and makes none, so a fan-out-based list silently dropped it; measured
  // on Astroshop, that hid 5 of 12 services including the third busiest.
  const svcRows: Array<{ id: string; nm: string; vol: number; fan: number }> =
    scope.loading ? []
    : scope.resolved
      ? [...scope.traces.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([id, tr]) => {
            const nm = scope.names.get(id)
              ?? [...svcIdOf.entries()].find(([, v]) => v === id)?.[0]
              ?? id.replace("SERVICE-", "svc ");
            return { id, nm, vol: tr, fan: fanOut[nm] ?? 0 };
          })
      : [...new Set(d.calls.flatMap((c) => [c.src, c.dst]))]
          .map((nm) => ({ id: svcIdOf.get(nm) ?? "", nm, vol: fanOut[nm] ?? 0,
            fan: fanOut[nm] ?? 0 }))
          .sort((a, b) => b.fan - a.fan);
  const allSvc = svcRows.map((r) => [r.nm, r.fan] as [string, number]);
  // A pod belongs to the application only if the POD itself hosts one of the
  // app's services. Matching on the node too let every system pod that merely
  // SHARES the machine flood in — measured on AI Chatbot: RUN showed 200
  // elements, kube-proxy and friends included, for an app with one service.
  // With a resolved scope, EMPTY placement is an answer too: this app's
  // services have no measured runs_on, so its Run column must say that — not
  // fall back to every pod in the environment (measured: 200 system pods
  // under a one-service chatbot).
  const runtimeRows = scope.loading ? []
    : !scope.resolved || !scope.services.size
    ? d.runtime
    : d.runtime.filter((r) => scope.runtime.has(r.podId));

  /* ── what the services actually run on ──────────────────────────────────
   * Measured across this environment: services are placed on HOST (2,412
   * edges), CONTAINER (997), K8S_NODE (769) and PROCESS (154) — and on
   * K8S_POD exactly zero times. The layer below Services was built only from
   * pods, so for every application here it read "No measured placement" while
   * the machinery card beside it announced "0 nodes": components drawn with
   * nothing joining them to anything.
   *
   * These rows are the placements themselves, grouped by what they are, so a
   * host-based deployment maps as completely as a Kubernetes one.
   */
  /* A serverless function is a PLACEMENT, not a layer of its own: measured on
   * guu84124, `SERVICE runs_on AWS_LAMBDA_FUNCTION` exists five times, exactly
   * the shape of `runs_on HOST`. So a lambda-backed service maps with no new
   * query and no new column — the runtime card simply says "lambda" where
   * another says "host".
   *
   * Listed even though bwm98081 has none of those edges today, because the
   * list is read against what the placement query returned: a type absent from
   * the environment costs nothing, while a type missing from this list is a
   * service silently drawn as running on nothing. */
  const RUNTIME_ORDER = ["K8S_POD", "CONTAINER", "PROCESS", "K8S_NODE", "HOST",
    "AWS_LAMBDA_FUNCTION"];
  const placeRows = scope.resolved
    ? scope.placements.filter((p) => RUNTIME_ORDER.includes(p.type))
    : [];
  /** Placements grouped by type, biggest group first. */
  const placeByType = [...placeRows.reduce((m, p) => {
    const g = m.get(p.type); if (g) g.push(p); else m.set(p.type, [p]);
    return m;
  }, new Map<string, typeof placeRows>()).entries()]
    .sort((a, b) => RUNTIME_ORDER.indexOf(a[0]) - RUNTIME_ORDER.indexOf(b[0]));
  // pools and nodes follow the same cut — an app on 3 pods does not span 6 pools
  const rtRows = scope.loading ? [] : scope.resolved ? runtimeRows : d.runtime;
  const pools = new Set(rtRows.map((r) => r.node.split("-").slice(0, 3).join("-")));
  const scopedHosts = [...scope.runtime].filter((i) => i.startsWith("HOST-"));

  const nodeIds = [...new Set(rtRows.flatMap((r) => [r.nodeId, r.nodeClassic]).filter(Boolean))] as string[];
  const hostIds = d.signals.filter((sg) => sg.entityId.startsWith("HOST-")).map((sg) => sg.entityId);
  // No synthetic ids here on purpose. They used to be attached environment-wide,
  // and the first signal they attracted was a "PLOOMES" monitor outage painting
  // Astroshop's browser layer red — measured, unrelated. Until a synthetic test
  // is measurably linked to an application, its signals stay off this chain.

  const measuring: Elo = { nm: "Resolving…", mt: "finding this application's backend",
    v: "—", tone: "info", miss: true,
    det: [["State", "the scope query is still running"],
          ["Why the wait", "layers below the application narrow to what this app reaches"]] };
  const noData: Elo = { nm: "No coverage", mt: "nothing in Smartscape", v: "—", tone: "info", miss: true,
    det: [["Action", "instrument with OneAgent"]] };
  // Resolved-and-empty is a finding, not a gap in our data: this application's
  // sessions carry no trace that reaches any service.
  const unlinked = scope.resolved && scope.services.size === 0;
  const noPlace: Elo = { nm: "No measured placement", mt: "no runs_on for this app's services",
    v: "—", tone: "info", miss: true,
    det: [["Meaning", "Smartscape maps no pod/host under these services"],
          ["Action", "check OneAgent injection on the workload"]] };
  const noLink: Elo = { nm: "No measured link", mt: "no trace reaches a service", v: "—",
    tone: "info", miss: true,
    det: [["Meaning", "sessions of this application carry no backend trace"],
          ["Action", "check RUM–trace correlation or OneAgent coverage"]] };

  /* ── the data stores those services call ────────────────────────────────
   * One card per store, not per service-to-store pair: `easytrade-db` is one
   * database whether five services talk to it or one, and five identical
   * boxes would have said there are five databases.
   *
   * The card carries what the callers measured — calls, p50, p90 — because a
   * node on this chain has to be worth clicking. Errors are printed only when
   * something rated them: measured here, `span.status_code` is null on every
   * one of 36,430 database spans, and "0 errors" would have read as a clean
   * bill of health that nobody actually issued.
   */
  const storeCards: Elo[] = (() => {
    if (!stores?.length) return [];
    const by = new Map<string, typeof stores>();
    for (const s of stores) {
      const g = by.get(s.store); if (g) g.push(s); else by.set(s.store, [s]);
    }
    return [...by.entries()]
      .sort((a, b) => b[1].reduce((n, s) => n + s.calls, 0)
        - a[1].reduce((n, s) => n + s.calls, 0))
      .slice(0, 6)
      .map<Elo>(([store, rows]) => {
        const calls = rows.reduce((n, s) => n + s.calls, 0);
        const rated = rows.reduce((n, s) => n + s.rated, 0);
        const errors = rows.reduce((n, s) => n + s.errors, 0);
        // weighted by call volume — the busiest caller decides what this store
        // feels like, not the arithmetic mean of a chatty one and a quiet one
        const wAvg = (pick: (s: DataStore) => number) => calls
          ? rows.reduce((n, s) => n + pick(s) * s.calls, 0) / calls : 0;
        const sys = [...new Set(rows.map((s) => s.sys))].join(" · ");
        const nss = [...new Set(rows.map((s) => s.ns).filter(Boolean))];
        const callers = [...new Set(rows.map((s) => s.svc))];
        return {
          nm: store, mt: `${sys} · ${fmtN(calls)} calls`,
          v: fmtMs(wAvg((s) => s.p50)), tone: "info", vol: calls,
          store, grp: "stores",
          /* ids WHEN the DB entity resolves (batched, useDbEntities): the
           * tenant's database health alerts bind to the instances' classic
           * CUSTOM_DEVICE- ids, and a card with no ids could never light —
           * the Databases app showed a "Configuration" alert this chain
           * painted calm. A store with no DB_* node (redis, mongo) still
           * carries none, honestly. */
          ids: (() => { const e = dbIds?.get(store);
            return e ? [e.id, ...(e.classic ? [e.classic] : [])] : []; })(),
          det: [["Technology", sys],
                ...(nss.length ? [["Database", nss.join(" · ")] as [string, string]] : []),
                ["Calls (10m)", fmtN(calls)],
                ["p50", fmtMs(wAvg((s) => s.p50))],
                ["p90", fmtMs(wAvg((s) => s.p90))],
                ["Failed calls", rated > 0 ? `${fmtN(errors)} of ${fmtN(rated)} rated`
                  : "not reported on these spans"],
                ["Called by", `${callers.length} service(s)`]],
        };
      });
  })();

  /* ── what only the classic topology knows ───────────────────────────────
   * Same layer, same shape as any other service, because that is what these
   * are — the only thing that differs is which model found them. The card
   * says so: a box whose provenance is not the one every other box uses has
   * to declare it, or the screen quietly mixes two sources.
   */
  /* Cap at ten, not six. Six was arbitrary and it truncated a real chain:
   * the mainframe mobile application reaches its webserver, six services
   * through it, and only then the database and CheckDestination — the last
   * hop, the one the whole walk exists to find, fell off the end. Ten leaves
   * the Serve layer room for at least two of its own services while letting
   * a classic-only chain arrive whole. */
  const gen2Cards: Elo[] = (gen2 ?? [])
    .filter((g) => gen2CardKept(g, stores))
    .slice(0, 10).map<Elo>((g) => ({
    nm: g.name, mt: `${KIND_LABEL(g.kind)} · topology-mapped`,
    v: String(g.callers.length || "·"), tone: "info",
    vol: Math.max(g.callers.length * 40, 1),
    ids: [g.id], gen2: g.id, gen2Db: /DATABASE|DATASTORE/.test(g.kind),
    grp: "classic",
    det: [["Found in", "classic topology — Smartscape has no node for it"],
          ["Classic type", g.kind || "—"],
          ...(g.host ? [["Runs on", g.host] as [string, string]] : []),
          ["Called by", `${g.callers.length} service(s) in this chain`]],
  }));

  /* ── the Serve layer: services, and the stores they keep their data in ──
   * A store sits here rather than in a column of its own, because that is the
   * relation both Smartscape and the spans describe: a service CALLS a store,
   * exactly as it calls another service. A ninth column would have claimed the
   * request continues past it.
   *
   * The stores are placed BEFORE the tail of the service list, not after it.
   * Only the first twelve cards of a layer are drawn — and only a drawn card
   * can anchor an edge — so appending them cost Astroshop its one database:
   * thirteenth in the list, folded into "+1 more", its edge silently dropped.
   * A store the whole application writes to is worth more than the twelfth
   * service, so it takes the slot and the service goes to the overflow.
   */
  const serveCards: Elo[] = (() => {
    const svc = svcRows.map<Elo>((r) => ({
      nm: r.nm.split(" - ")[0],
      mt: scope.resolved ? (r.vol > 0 ? `${fmtN(r.vol)} traces` : "linked · topology")
        : `calls ${r.fan} service(s)`,
      v: String(r.fan || "·"), tone: "info", vol: Math.max(r.vol, 1),
      ids: r.id ? [r.id] : [],
      det: [["Smartscape", "SERVICE · " + r.nm],
            ["Traces (10m)", scope.resolved && r.vol > 0 ? fmtN(r.vol) : "—"],
            ["Fan-out (calls)", String(r.fan)],
            ["Calls", d.calls.filter((c) => c.src === r.nm)
              .map((c) => c.dst.split(" - ")[0]).slice(0, 6).join(" · ") || "—"]],
    }));
    const extra = [...gen2Cards, ...storeCards];
    if (!extra.length) return svc;
    // at least one service stays visible — an extra card with nothing calling
    // it would be the unconnected component all over again
    const keep = Math.max(NODE_CAP - extra.length, 1);
    return [...svc.slice(0, keep), ...extra, ...svc.slice(keep)];
  })();

  const svcTotal = d.topology.find((t) => t.type === "SERVICE")?.nodes ?? 0;
  const podTotal = d.topology.find((t) => t.type === "K8S_POD")?.nodes ?? d.runtime.length;
  const L = (items: Elo[], total: number, kpi: string, kpiLabel: string): Layer =>
    ({ items, total: Math.max(total, items.length), kpi, kpiLabel, tone: worstOf(items) });

  const layers: Layer[] = [
    L((() => {
        // one card per measured origin — a chain fed only by robots should say so
        const per = new Map<Origin, number>();
        for (const r of devices) {
          const o = originOf(r.agent, r.utype);
          per.set(o, (per.get(o) ?? 0) + r.sessions);
        }
        const rows = [...per.entries()].sort((a, b) => b[1] - a[1]);
        return rows.length ? rows.map<Elo>(([o, n]) => {
          // The audience layer wears the harm done to that audience. Without
          // this, an application whose every session hit an error drew a calm
          // green chain while the landing page showed 0% error-free.
          const hit = hitPerOrigin(o, n);
          // Robots and monitors are not people: their card reports its own
          // breakage but never wears the colour reserved for user harm, so a
          // chain fed only by robots cannot render Critical while the estate
          // table calls the same application "No users".
          const machine = o === "Robots" || o === "Synthetic";
          const vd = verdictOf({
            sessions: hit === null ? null : n, hit,
            realSessions: hit === null ? null : (machine ? 0 : n),
            realHit: machine ? 0 : (hit ?? 0),
          });
          return {
          nm: o, mt: ORIGIN_META[o], v: fmtK(n), tone: vd.tone, vol: n,
          det: [["Sessions", fmtN(n)],
                ["Sessions hit by errors",
                 hit === null ? "…" : `${fmtN(hit)} of ${fmtN(n)} · ${vd.label}`],
                ["Share", devSessions ? ((n / devSessions) * 100).toFixed(1) + "%" : "—"],
                ["Device profiles",
                 String(devices.filter((r) => originOf(r.agent, r.utype) === o)
                   .reduce((a, r) => a + r.profiles, 0))]],
        }; }) : [quiet ? (() => {
          /* "quiet" and "uninstrumented" are different findings — the reader
           * saw an empty chain and asked whether the app had users AT ALL.
           * Measured then: 0 sessions in the window, 21 in the day. The card
           * now answers instead of shrugging "No coverage". */
          const hoursAgo = quiet.last
            ? Math.max(1, Math.round((Date.now() - new Date(quiet.last).getTime()) / 3.6e6))
            : null;
          return quiet.sessions > 0 ? {
            nm: "No sessions in this window",
            mt: `quiet, not uninstrumented`, v: "—", tone: "info" as Tone, miss: true,
            det: [["Last 24 hours", `${fmtN(quiet.sessions)} sessions`],
                  ...(hoursAgo !== null
                    ? [["Last session", `≈${hoursAgo}h ago`] as [string, string]] : []),
                  ["Reading", "the agent reported sessions within the day — "
                    + "this window is simply quiet; widen the timeframe to see them"]],
          } : {
            nm: "No sessions in 24 hours",
            mt: "silent for a full day", v: "—", tone: "warn" as Tone, miss: true,
            det: [["Reading", "either genuinely no users, or the instrumentation "
              + "stopped reporting — a full-day silence is worth checking in "
              + "Experience Vitals"]],
          };
        })() : noData];
      })(),
      // the layer's KPI is the sum of the cards drawn under it, never a second
      // measurement of the same thing — the two used to disagree by ~100
      Math.max(devices.length, 1), fmtK(devSessions), "sessions"),

    L(others.length ? others.map<Elo>((x) => ({
        nm: x.domain, mt: `${x.provider ?? "—"} · ${fmtN(x.reqs)} req`,
        v: latShort(x.p50, x.p90), tone: "info", vol: x.reqs,
        domain: x.domain,
        det: [["Provider", x.provider ?? "—"], ["Requests", fmtN(x.reqs)],
              ...latRows(x.p50, x.p90),
              ["4xx/5xx errors", fmtN(x.err)],
              ["Transferred", x.bytes ? fmtK(Math.round(x.bytes / 1024)) + " KB" : "—"]] })) : [noData],
      // third parties only: this column's cards ARE the non-first-party
      // domains, and its header once said "922.5k requests" over a single
      // "No coverage" card because every request was first-party (audit)
      others.length, fmtK(others.reduce((a, x) => a + x.reqs, 0)), "requests"),

    L([{ nm: app?.name ?? "—", mt: `FRONTEND · ${fmtN(app?.views ?? 0)} views`, v: fmtK(app?.errors ?? 0),
        tone: "info", vol: app?.views ?? 0,
        // The real entity id when the inventory named one — a mobile app's RUM
        // id is a UUID, and "APPLICATION-"+uuid is an id no app resolves. The
        // hex fallback only holds for web, where the RUM id IS the hex suffix.
        ids: app?.entity ? [app.entity]
          : appId && /^[0-9a-f]{16}$/.test(appId) ? ["APPLICATION-" + appId.toUpperCase()] : [],
        det: [["Sessions", fmtN(app?.sessions ?? 0)], ["Views", fmtN(app?.views ?? 0)],
              ["Errors", fmtN(app?.errors ?? 0)], ["View p50", fmtMs(app?.p50View ?? 0)]] }],
      1, fmtMs(app?.p50View ?? 0), "view p50"),

    L(firstParty ? [{ nm: firstParty.domain, mt: `ingress · ${fmtN(firstParty.reqs)} req`,
        v: latShort(firstParty.p50, firstParty.p90),
        tone: "info", domain: firstParty.domain, vol: firstParty.reqs,
        det: [["Requests", fmtN(firstParty.reqs)],
              ...latRows(firstParty.p50, firstParty.p90),
              ["Failed calls", fmtN(firstParty.err)],
              ["Transferred", fmtK(Math.round(firstParty.bytes / 1048576)) + " MB"],
              // a promoted domain says WHY it sits here: RUM tagged it
              // third-party, the spans said otherwise
              ...(firstParty.provider !== "first_party"
                ? [["Classified by", "its traces — this app's own services serve "
                    + "this address (RUM tags it third-party)"] as [string, string]]
                : [])] }] : [noData],
      1, firstParty ? latShort(firstParty.p50, firstParty.p90) : "—",
      firstParty && firstParty.p50 <= 0 && firstParty.p90 > 0
        ? "ingress p90" : "ingress p50"),

    L(scope.loading ? [measuring] : unlinked ? [noLink]
      : svcRows.length ? serveCards : [noData],
      unlinked ? 1
        : scope.resolved ? svcRows.length + storeCards.length + gen2Cards.length
        : scope.loading ? 0 : svcTotal,
      unlinked ? "0" : fmtN(d.calls.length), unlinked ? "linked services" : "call relations"),

    L(unlinked ? [noLink] : runtimeRows.length ? (() => {
        // replicas of one workload collapse into one node — twelve pods named
        // checkout-7d89…-xxxxx are one thing scaled, not twelve things
        const wlOf = (pod: string) => pod.replace(/-[a-z0-9]{7,10}-[a-z0-9]{5}$/, "")
          .replace(/-[a-z0-9]{5}$/, "");
        const groups = new Map<string, typeof runtimeRows>();
        for (const r of runtimeRows) {
          const k = wlOf(r.pod);
          const g = groups.get(k); if (g) g.push(r); else groups.set(k, [r]);
        }
        return [...groups.entries()]
          .sort((a, b) => b[1].length - a[1].length)
          .map<Elo>(([wl, rows]) => rows.length === 1 ? {
            nm: rows[0].pod, mt: "K8S_POD · runs_on", v: "pod", tone: "info",
            // both id spaces: Smartscape's for matching signals, classic's for
            // the classic Kubernetes app, which 404s on a K8S_POD- id
            ids: [rows[0].podId, rows[0].nodeId, rows[0].podClassic, rows[0].nodeClassic]
              .filter(Boolean) as string[],
            det: [["Smartscape", "K8S_POD runs_on K8S_NODE"], ["Node", rows[0].node],
                  ["Cloud", rows[0].node.startsWith("gke") ? "GKE"
                    : rows[0].node.startsWith("aks") ? "AKS" : "—"]],
          } : {
            nm: wl, mt: `${rows.length} pods · workload`, v: `×${rows.length}`,
            tone: "info", vol: rows.length * 40,
            ids: rows.flatMap((r) => [r.podId, r.nodeId, r.podClassic, r.nodeClassic])
              .filter(Boolean) as string[],
            det: [["Workload", wl], ["Replicas", String(rows.length)],
                  ["Pods", rows.map((r) => r.pod).slice(0, 6).join(" · ")],
                  ["Nodes", [...new Set(rows.map((r) => r.node))].slice(0, 4).join(" · ")]],
          });
      })()
      /* Not Kubernetes? Still a chain. The placements say what these services
         run on, whatever that is, and one card per host / container / process
         carries the edge that the pod-only path could never draw. */
      : placeByType.length ? placeByType.flatMap(([type, rows]) => {
          const uniq = [...new Map(rows.map((p) => [p.id, p])).values()];
          const label = type.replace(/^K8S_/, "").toLowerCase();
          // one card each while they fit, one card for the group beyond that
          return uniq.length <= 4
            ? uniq.map<Elo>((p) => ({
                nm: p.name, mt: `${type} · runs_on`, v: label, tone: "info",
                // both id forms: Davis k8s events carry the classic one
                ids: [p.id, ...(p.classic ? [p.classic] : [])],
                det: [["Smartscape", `SERVICE runs_on ${type}`],
                      ["Serves", String(rows.filter((r) => r.id === p.id).length)
                        + " service(s)"]] }))
            : [{
                // "process" pluralised by suffix alone read "14 processs"
                nm: `${uniq.length} ${label.endsWith("s") ? `${label}es` : `${label}s`}`,
                mt: `${type} · runs_on`,
                v: `×${uniq.length}`, tone: "info" as Tone,
                vol: uniq.length * 40,
                ids: uniq.flatMap((p) => [p.id, ...(p.classic ? [p.classic] : [])]),
                det: [["Type", type], ["Count", String(uniq.length)],
                      ["Names", uniq.map((p) => p.name).slice(0, 6).join(" · ")]] }];
        })
      : [scope.loading ? measuring : scope.resolved ? noPlace : noData],
      unlinked ? 1
        : scope.resolved ? Math.max(runtimeRows.length || placeRows.length, 1)
        : scope.loading ? 0 : podTotal,
      unlinked ? "0"
        : runtimeRows.length ? fmtN(pools.size)
        // the caption names what was actually found, not what we hoped for
        : fmtN(new Set(placeRows.map((p) => p.id)).size),
      unlinked ? "linked pods"
        : runtimeRows.length ? "node pools"
        : placeByType.length
          ? placeByType.map(([t]) => t.replace(/^K8S_/, "").toLowerCase()).join(" · ")
          : "node pools"),

    L(scope.loading ? [measuring] : unlinked ? [noLink]
      : scope.resolved && !rtRows.length && !scopedHosts.length
      ? [noPlace]
      : scope.resolved ? [
        // scoped: only the machinery this application's services run on
        /* A card is drawn only when it counts something. "Nodes running this
           app: 0" was rendering on every application of this environment —
           a component standing for nothing, with no edge, next to a Runtime
           layer that had given up. If there are no cluster nodes, the layer
           simply says so once rather than printing a zero. */
        ...(new Set(rtRows.map((r) => r.nodeId)).size > 0
          ? [{ nm: "Nodes running this app", mt: `${pools.size} node pool(s)`,
               v: String(new Set(rtRows.map((r) => r.nodeId)).size), tone: "info" as Tone,
               ids: nodeIds,
               det: [...new Set(rtRows.map((r) => r.node))].slice(0, 5)
                 .map((n) => ["K8S_NODE", n] as [string, string]) } as Elo]
          : []),
        ...(scopedHosts.length
          ? [{ nm: "Hosts running this app", mt: "HOST · runs_on",
               v: fmtN(scopedHosts.length), tone: "info" as Tone, ids: scopedHosts,
               det: [["HOST nodes", fmtN(scopedHosts.length)] as [string, string]] } as Elo]
          : []),
      ] : [
        { nm: "Cluster topology", mt: `${pools.size} node pool(s)`, v: String(d.runtime.length), tone: "info",
          ids: nodeIds,
          det: d.topology.slice(0, 5).map((t) => [t.type, fmtN(t.nodes)] as [string, string]) },
        ...(d.topology.some((t) => t.type === "HOST")
          ? [{ nm: "Monitored hosts", mt: "HOST · Smartscape",
               v: fmtN(d.topology.find((t) => t.type === "HOST")!.nodes),
               tone: "info" as Tone, ids: hostIds,
               det: [["HOST nodes", fmtN(d.topology.find((t) => t.type === "HOST")!.nodes)] as [string, string]] } as Elo]
          : []),
      ],
      unlinked ? 1
        : scope.resolved ? new Set(rtRows.map((r) => r.nodeId)).size + scopedHosts.length
        : d.topology.reduce((a, t) => a + t.nodes, 0),
      unlinked ? "0" : fmtN(new Set(rtRows.map((r) => r.nodeId)).size),
      unlinked ? "linked nodes" : "nodes"),

    /* ── Cloud, and only where there is one ──
     * Present exactly when a host in scope has a provider behind it. On this
     * tenant that is 7 hosts of 49; for the rest this layer holds nothing and
     * the renderer drops it, so the chain ends at Infrastructure rather than
     * showing an eighth column with nothing in it.
     *
     * The instance NAME is not enough on its own — three EC2 instances here
     * are all called "live" — so the card carries the id beside it. */
    L(cloud && cloud.length ? (() => {
        const byInstance = [...new Map(cloud.map((c) => [c.instanceId, c])).values()];
        const zones = [...new Set(cloud.map((c) => c.zoneName).filter(Boolean))];
        return [
          ...byInstance.slice(0, 12).map<Elo>((c) => (c.kind === "lambda"
            ? {
                nm: c.instanceName, mt: "AWS Lambda · serverless",
                // a REGION, stated as one — a lambda has no availability zone
                v: c.region ?? "lambda", tone: "info" as Tone, ids: [c.instanceId],
                det: [["Provider", "AWS"],
                      ["Region", c.region ?? "—"],
                      ...(c.account ? [["Account", c.account] as [string, string]] : []),
                      ["Function", c.instanceName]],
              }
            : {
                nm: c.instanceName,
                mt: `${c.instanceType.replace(/_/g, " ").toLowerCase()} · runs_on`,
                v: c.instanceType.startsWith("AWS") ? "ec2"
                  : c.instanceType.startsWith("GCP") ? "gce" : "vm",
                tone: "info" as Tone, ids: [c.instanceId],
                det: [["Instance", c.instanceId],
                      ["Provider", c.instanceType.split("_")[0]],
                      ["Zone", c.zoneName ?? "—"],
                      ["Host", c.host]],
              })),
          ...(zones.length ? [{
            nm: zones.length === 1 ? zones[0]! : `${zones.length} zones`,
            mt: "availability zone", v: "zone", tone: "info" as Tone,
            ids: [...new Set(cloud.map((c) => c.zoneId).filter(Boolean))] as string[],
            det: [["Zones", zones.join(" · ")],
                  ["Instances", String(byInstance.length)]] } as Elo] : []),
        ];
      })() : [],
      cloud ? cloud.length : 0,
      cloud && cloud.length
        ? fmtN(new Set(cloud.map((c) => c.instanceId)).size) : "—",
      "instances"),
  ];

  // ── Component-to-component volumetry. ─────────────────────────────────
  // Every edge is a measured pair: origin→domain requests come from RUM rows
  // grouped by user type; ingress→service and service→pod volumes are the
  // traces observed per service. Only the three rendered cards per layer can
  // anchor an edge, so edges address render indexes directly.
  const edges: Edge[] = [];
  const idxIn = (ti: number, pred: (e: Elo) => boolean): number | null => {
    const i = layers[ti].items.findIndex(pred);
    return i >= 0 && i < NODE_CAP ? i : null;
  };
  // origin → third-party domain (and → ingress), per measured origin rows
  for (const r of domains) {
    const oi = idxIn(0, (e) => e.nm === originOf(r.agent, r.utype));
    if (oi === null) continue;
    if (r.provider === "first_party") {
      // first-party requests skip the third-party column visually — they are
      // the app talking to its own ingress, drawn app→ingress below
      continue;
    }
    const di = idxIn(1, (e) => e.nm === r.domain);
    if (di !== null) edges.push({ s: [0, oi], t: [1, di], v: r.reqs, label: "requests",
      bad: r.err, blind: unattribErr > 0, p50: r.p50, p90: r.p90, late: r.late ?? null });
  }
  // every origin also feeds the application itself
  for (const [oi, o] of layers[0].items.slice(0, NODE_CAP).entries()) {
    if (o.miss) continue;
    const rows = devices.filter((r) => originOf(r.agent, r.utype) === o.nm);
    const sess = rows.reduce((a, r) => a + r.sessions, 0);
    const late = rows.reduce<number | null>((a, r) =>
      a == null || r.late == null ? null : a + r.late, 0);
    if (sess) edges.push({ s: [0, oi], t: [2, 0], v: sess, label: "sessions",
      // the same split the origin cards use: how many of THIS origin's
      // sessions met an error (null while the impact scan is in flight)
      bad: hitPerOrigin(o.nm as Origin, sess), late });
  }
  // third-party domain ← the application's page (render order: app fetches it)
  for (const [di, dcard] of layers[1].items.slice(0, NODE_CAP).entries()) {
    if (dcard.miss) continue;
    const agg = domAgg.get(dcard.nm);
    if (agg) edges.push({ s: [1, di], t: [2, 0], v: agg.reqs, label: "requests",
      bad: agg.err, blind: unattribErr > 0, p50: agg.p50, p90: agg.p90, late: agg.late });
  }
  if (firstParty) edges.push({ s: [2, 0], t: [3, 0], v: firstParty.reqs,
    label: "ingress requests", bad: firstParty.err, blind: unattribErr > 0, p50: firstParty.p50,
    p90: firstParty.p90, late: firstParty.late });
  if (!unlinked) {
    // ingress → each rendered service, weighted by its observed traces
    for (const [si, svcCard] of layers[4].items.slice(0, NODE_CAP).entries()) {
      if (svcCard.miss) continue;
      // The Serve layer holds stores and classic-only services too now.
      // Neither is entered from the ingress — both are entered from the
      // service next to them — so they take no edge here, and their own
      // edges are drawn below.
      if (svcCard.store || svcCard.gen2) continue;
      const sid = svcCard.ids?.[0];
      const v = sid ? scope.traces.get(sid) ?? 0 : 0;
      const from: [number, number] = layers[3].items[0]?.miss ? [2, 0] : [3, 0];
      edges.push({ s: from, t: [4, si], v: Math.max(v, 1),
        label: v > 0 ? "traces" : "calls (topology)" });
      /* service → whatever it runs on, when that thing is rendered.
       *
       * This used to require `type === "K8S_POD"`. On an environment where no
       * service runs on a pod — measured here, not one of 118 does — the test
       * never passed, so the Serve layer connected to nothing and everything
       * below it floated. The rendered card is the authority now: if the id is
       * on screen, the edge is drawn, whatever kind of machine it names. */
      if (sid) {
        const drawn = new Set<number>();
        for (const pl of scope.placements) {
          if (pl.svc !== sid) continue;
          const pi = idxIn(5, (e) => (e.ids ?? []).includes(pl.id));
          // several placements can share one card (a grouped host set); the
          // edge is the relation, so it is drawn once
          if (pi !== null && !drawn.has(pi)) {
            drawn.add(pi);
            edges.push({ s: [4, si], t: [5, pi], v: Math.max(v, 1), label: "runs on" });
          }
        }
      }
    }
    /* service → the store it calls, inside the Serve layer.
     *
     * An edge that stays in one layer, like instance → availability zone in
     * the cloud layer: the store is not a further step down the delivery
     * path, it is a dependency of the step the request is already on. Weighted
     * by the calls actually measured, so a service that queries a database
     * thirty times a request draws a heavier line than one that caches. */
    {
      // one line per relation, not per row: a service that opens two databases
      // on the same host is still one service talking to one store
      const q = new Map<string, number>();
      for (const s of stores ?? []) {
        const si = idxIn(4, (e) => !e.store && (e.ids ?? []).includes(s.svc));
        const di = idxIn(4, (e) => e.store === s.store);
        if (si === null || di === null) continue;
        const k = `${si}:${di}`;
        q.set(k, (q.get(k) ?? 0) + s.calls);
      }
      for (const [k, v] of q) {
        const [si, di] = k.split(":").map(Number);
        edges.push({ s: [4, si], t: [4, di], v: Math.max(v, 1), label: "queries" });
      }
    }
    /* caller → the service only the classic model knows.
     *
     * Drawn from `called_by` the classic topology reports, so the line exists
     * for the same reason the node does. Where Smartscape has the pair, it has
     * already drawn it and this card never appears. */
    for (const g of gen2 ?? []) {
      const di = idxIn(4, (e) => e.gen2 === g.id);
      if (di === null) continue;
      for (const caller of g.callers) {
        const si = idxIn(4, (e) => !e.gen2 && !e.store && (e.ids ?? []).includes(caller));
        if (si === null) continue;
        edges.push({ s: [4, si], t: [4, di], v: 1, label: "calls (Gen2)" });
      }
    }
    // runtime → the machinery card, whatever kind of runtime it turned out
    // to be. The old label said "pod placed" on every edge, including the
    // ones that were never pods.
    for (const [pi, rtCard] of layers[5].items.slice(0, NODE_CAP).entries()) {
      if (rtCard.miss) continue;
      if (!layers[6].items[0] || layers[6].items[0].miss) continue;
      edges.push({ s: [5, pi], t: [6, 0], v: 1, label: "placed on" });
    }
    /* machinery → provider, and instance → zone. Drawn from the host each
     * placement names, so a chain with two clouds in it keeps them apart
     * instead of joining everything to everything. */
    if (layers[7]?.items.length) {
      const zoneIdx = layers[7].items.findIndex((e) => e.mt === "availability zone");
      for (const [ci, card] of layers[7].items.slice(0, NODE_CAP).entries()) {
        if (ci === zoneIdx) continue;
        /* A serverless provider card is entered from its own RUN card — the
         * lambda placement — not from the hosts: a function shares no machine
         * with anyone, and wiring it to every host would draw the exact
         * everything-to-everything this pass exists to prevent. */
        if (card.mt === "AWS Lambda · serverless") {
          const fnId = card.ids?.[0];
          const ri = fnId ? idxIn(5, (e) => (e.ids ?? []).includes(fnId)) : null;
          if (ri !== null) edges.push({ s: [5, ri], t: [7, ci], v: 1, label: "runs on" });
          continue;
        }
        for (const [hi, hostCard] of layers[6].items.slice(0, NODE_CAP).entries()) {
          if (hostCard.miss) continue;
          edges.push({ s: [6, hi], t: [7, ci], v: 1, label: "runs on" });
        }
        if (zoneIdx >= 0) {
          edges.push({ s: [7, ci], t: [7, zoneIdx], v: 1, label: "in zone" });
        }
      }
    }
  }

  // ── Colour is a signal, never a heuristic. ─────────────────────────────
  // An element is highlighted exactly when something detected it: an active
  // Davis problem (red), a baselining anomaly or custom alert (amber), or a
  // worsening forecast on the application (amber). Everything else stays
  // neutral, so the few coloured cards are the whole story of the screen.
  const sigFor = (ids: string[]) => ({
    prob: d.problems.filter((p) => (p.entityIds ?? []).some((e) => ids.includes(e))),
    anom: d.signals.filter((sg) => ids.includes(sg.entityId) && sg.provider === "BASELINING"),
    alert: d.signals.filter((sg) => ids.includes(sg.entityId)
      && (sg.provider === "METRIC_EVENTS" || sg.provider === "EVENTS_REST_API_INGEST")),
  });
  for (const layer of layers) {
    for (const n of layer.items) {
      if (n.miss || !n.ids?.length) continue;
      const g = sigFor(n.ids);
      if (g.prob.length) {
        n.tone = "bad";
        // the platform's own words: a Problem, named by its Davis category
        n.det.push(["Problem", g.prob.slice(0, 3)
          .map((p) => `${p.display_id} · ${davisCategory(p.category)}`).join("  ")]);
      } else if (g.anom.length) {
        n.tone = "warn";
        n.det.push(["Anomaly (baselining)", g.anom[0].name]);
      } else if (g.alert.length) {
        n.tone = "warn";
        n.det.push(["Custom alert", g.alert[0].name]);
      }
    }
  }
  // the fourth signal: the analyzer projects this application's errors rising
  const appElo = layers[2]?.items[0];
  if (appElo && ahead) {
    appElo.spark = { pts: ahead.point, rising: ahead.slope > 0 };
    // NOT pushed as a detail row: the Vitals block below already prints the
    // same forecast, coloured. The drawer was stating it twice, three lines
    // apart, with identical numbers.
  }
  /* ── the application card carries the application's verdict ──
   * Same call, same thresholds as the landing page and the estate table. A
   * Davis problem is not the only way to be broken: if the measured share of
   * sessions hit by errors says this application is failing, this card says
   * failing too, and names the reason it was judged by. */
  if (appElo && !appElo.miss) {
    const appProbs = d.problems.filter((p) => problemIds(p)
      .some((e) => (appElo.ids ?? []).includes(e)));
    const appVd = verdictOf({
      problems: appProbs.length,
      categories: appProbs.map((p) => p.category),
      anomalies: d.signals.filter((sg) => (appElo.ids ?? []).includes(sg.entityId)).length,
      sessions: impacted?.sessions, hit: impacted?.hit,
      // the same people-first rule the landing page and the estate table use
      realSessions: impacted?.realSessions, realHit: impacted?.hitReal,
      forecastRising: !!ahead && ahead.slope > 0,
    });
    appElo.tone = appVd.tone;
    appElo.det.push(["Status", `${appVd.label} — ${appVd.reason}`]);
    // "Sessions hit by errors" is not pushed either — the Users impacted block
    // renders the same count WITH the real/robot/synthetic split, which is the
    // version worth keeping.
  }
  // captions re-judge after decoration — they summarise the elements' state
  for (const layer of layers) layer.tone = worstOf(layer.items);
  return { layers, edges };
}

export function DeliveryChain({ data, appId, sel, onSel, highlight, onHighlightClear }: {
  data: ChainData; appId: string;
  /** The selected element, held in the URL so the view can be shared. */
  sel: string | null;
  onSel: (sel: string | null) => void;
  /**
   * "anomalies" spotlights the anomalous components on arrival — the header
   * button's answer to "where are the seven?": amber cards were not findable
   * at a glance inside a highlighted trail. Everything else dims; the first
   * selection clears it, because from there the reader is navigating.
   */
  highlight?: "anomalies" | null;
  onHighlightClear?: () => void;
}) {
  // narrows the lower layers to what this application's traces actually reach
  const scope = useAppScope(appId,
    data.apps.find((a) => a.appId === appId)?.entity);
  const ahead = useAppForecast(appId, data.tf);
  // Not lazy any more: measured impact now decides colour, so it has to be
  // here before the first paint. Memoised per application and window, and the
  // landing page asks for the same key — arriving from the overview is free.
  const impacted = useImpacted(appId, data.tf, true);
  // The provider behind the machines AND the serverless placements: a
  // lambda-backed service produces no HOST, and the Provider column born
  // only from hosts never existed for it — the chain ended at Run while the
  // function node itself knew its provider, region and account.
  const cloud = useCloudScope(
    [...scope.runtime].filter((i) => i.startsWith("HOST-")),
    scope.placements.filter((p) => p.type === "AWS_LAMBDA_FUNCTION")
      .map((p) => p.id),
    scope.resolved);
  // the stores this application's services query, asked only once the scope
  // named them — no services, no question worth paying for
  const stores = useDataStores([...scope.services], scope.resolved);
  /* the DB entities behind those stores, batched — health alerts bind to
   * their classic ids, and an id-less card can never light */
  const dbIds = useDbEntities(stores);
  // what the classic topology knows and Smartscape does not — asked with the
  // same key, so an application whose two models agree pays for one query and
  // draws nothing extra
  const gen2 = useGen2Closure([...scope.services], scope.resolved);
  /* frontend.name per entity — the sessions hand-off's vocabulary */
  const feNames = useFrontendNames();
    /* FIRST-PARTY BY TRACES. RUM's provider tag failed the audit: the Android
   * app's only contacted domain is its own backend, tagged third_party —
   * firstParty = 0 and the Route layer read "No coverage" forever. When no
   * domain wears the tag, the top contacted domains are asked the direct
   * question instead: do spans with this server.address exist? A CDN or a
   * font host has none; the app's own ingress has tens of thousands
   * (measured: 93,250 in 30m for the Android backend). One memoised spans
   * scan, only for apps the tag already failed. */
  const appDomainRows = data.domains.filter((r) => r.appId === appId);
  const hasTaggedFp = appDomainRows.some((r) => r.provider === "first_party");
  const fpCandidates = useMemo(() => {
    if (hasTaggedFp) return [];
    const agg = new Map<string, number>();
    for (const r of appDomainRows) agg.set(r.domain, (agg.get(r.domain) ?? 0) + r.reqs);
    return [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([dm]) => dm);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasTaggedFp, appId, data.domains]);
  const servedDomains = useDomainTraces(fpCandidates, data.tf, fpCandidates.length > 0);
  const promotedFp = !hasTaggedFp && servedDomains
    ? fpCandidates.find((dm) => servedDomains.has(dm)) ?? null : null;
  /* the 24h probe, asked only when THIS window's sessions are zero —
   * "quiet" and "uninstrumented" must not share a card */
  const appSessions = data.origins.filter((r) => r.appId === appId)
    .reduce((a, r) => a + r.sessions, 0);
  /* the entity, derived when the qApps row is gone — which is EXACTLY the
   * quiet case: zero events in the window means no row to read it from.
   * Measured: a mobile RUM id is the entity's hex as a dashed uuid
   * (21cb4989-d0a5-46c7-… ⇔ MOBILE_APPLICATION-21CB4989D0A546C7); a web
   * RUM id is the 16-hex itself. */
  const quietEntity = data.apps.find((a) => a.appId === appId)?.entity
    ?? (/^[0-9a-f]{16}$/.test(appId) ? `APPLICATION-${appId.toUpperCase()}`
      : /^[0-9a-f-]{36}$/.test(appId)
        ? `MOBILE_APPLICATION-${appId.replace(/-/g, "").slice(0, 16).toUpperCase()}`
        : undefined);
  const quiet = useQuietProbe(quietEntity, !data.loading && appSessions === 0);
  const built = useMemo(
    () => buildTiers(data, appId, scope, ahead, impacted, cloud, stores, gen2, dbIds,
      quiet, promotedFp),
    [data, appId, scope, ahead, impacted, cloud, stores, gen2, dbIds, promotedFp, quiet]);
  const tiers = built.layers;
  /* Density decides the SCALE, not just the height: a chain of one node per
   * layer drew the same 18–44px icons and 11px type as a nine-node estate,
   * so a sparse diagram was small figures adrift in dark. Sparse gets big. */
  const chainRows = Math.max(...tiers.map((t) => Math.min(t.items.length, 12)), 1);
/* One fixed scale. Two attempts at a data-driven one both failed the eye:
   recomputed per render it shrank as data arrived; latched at settle it
   jumped mid-viewing. Size that depends on streaming data cannot be stable,
   so the diagram is simply DRAWN LARGER for everyone — which is what was
   asked for in the first place. */
  const gscale = 1.25;
  /* THE PIVOT: mapping every backend relation stopped being this app's job.
   * Smartscape and the problem path already own that picture; what only this
   * app sees is the RUM side (Consume→Route) and the BRIDGE — which backend
   * this application's sessions actually reach. So the chain draws its four
   * RUM layers and hands the rest to one summarised Backend block, keyed on
   * everything the scope still measures. The deep edges keep being computed
   * (their tones and counts feed the block); they are no longer drawn. */
  const edges = useMemo(() => {
    const kept = built.edges.filter((e) => e.s[0] < 4 && e.t[0] < 4);
    // the seam: everything past the edge/ingress funnels into one block
    const from: [number, number] =
      built.layers[3]?.items[0]?.miss ? [2, 0] : [3, 0];
    const vol = [...scope.traces.values()].reduce((a, v) => a + v, 0);
    // only when the Serve layer holds a REAL card: `miss` covers noData,
    // noLink and noPlace, and drawing "reaches the backend" into a card that
    // says "no trace reaches a service" contradicted it (audit)
    if (!built.layers[4]?.items[0]?.miss) {
      kept.push({ s: from, t: [4, 0], v: Math.max(vol, 1),
        label: vol > 0 ? "traces" : "reaches the backend" });
    }
    return kept;
  }, [built, scope]);
  // the setter mirrors useState's signature so the existing toggles still read
  // naturally, but the value it writes lands in the query string
  const setSel = (v: string | null | ((cur: string | null) => string | null)) => {
    // selecting anything ends the spotlight — the reader is navigating now
    if (highlight) onHighlightClear?.();
    onSel(typeof v === "function" ? v(sel) : v);
  };
  const shellRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const { t: view, fit, zoomIn, zoomOut, reset } = usePanZoom(shellRef, canvasRef);
  // Assist may be off for this tenant or this user; the routes ask before offering
  const assist = useAssist();
  // which app owns each capability here — Gen3 if installed, classic otherwise
  const apps = useApps();

  // Escape closes the overlay, like any screen laid over another
  useEffect(() => {
    if (!sel) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") setSel(null); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel]);

  /* Signals are matched by entity id, so a problem, alert or extension event
     only shows up under the link it actually affects. */
  const idsOfTier = useMemo(() => {
    const m: Record<number, Set<string>> = {};
    tiers.forEach((layer, ti) => {
      m[ti] = new Set(layer.items.flatMap((n) => n.ids ?? []));
    });
    return m;
  }, [tiers]);

  const problemsFor = (ids: string[]) =>
    data.problems.filter((p) => problemIds(p).some((id) => ids.includes(id)));
  const signalsFor = (ids: string[]) =>
    data.signals.filter((sg) => ids.includes(sg.entityId));

  /* animated mesh between columns */
  useEffect(() => {
    const draw = () => {
      const svg = svgRef.current, host = canvasRef.current;
      if (!svg || !host) return;
      const box = host.getBoundingClientRect();
      const z = box.width / Math.max(1, host.offsetWidth); // escala aplicada pelo transform
      svg.setAttribute("viewBox", `0 0 ${host.offsetWidth} ${host.offsetHeight}`);
      const anchor = (id: string, side: "l" | "r") => {
        const el = document.getElementById(id);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: ((side === "r" ? r.right : r.left) - box.left) / z,
                 y: (r.top + r.height / 2 - box.top) / z };
      };
      // Every measured pair is drawn, always: width and speed come from the
      // volume, so the picture is literally the traffic. Selecting a card
      // turns its edges to their semantic tone and dims the rest.
      // Every measured pair, always drawn: ~20 edges over ~18 nodes is the
      // whole story, so nothing waits behind a click. Selection recolours its
      // own path and fades the rest.
      // A line answers two questions at a glance: HOW MUCH (width, normalised
      // to the busiest edge on screen so 68k is visibly fatter than 914) and
      // WHICH WAY (an arrowhead that scales with the line, plus the dashes
      // travelling the same direction).
      const parts: string[] = [];
      const defs = (["accent", "good", "warn", "bad"] as const).map((t) =>
        `<marker id="ar-${t}" viewBox="0 0 8 8" refX="6.5" refY="4"
           markerWidth="2.6" markerHeight="2.6" orient="auto-start-reverse"
           markerUnits="strokeWidth">
           <path d="M0,0 L8,4 L0,8 Z" fill="${t === "accent" ? "var(--accent)" : TVAR[t]}"/>
         </marker>`).join("");
      const vmax = Math.max(1, ...edges.map((e) => e.v));
      const drawn: Array<{ mx: number; my: number; v: number; label: string; op: number;
        next: number | null; fcArrow: string; gapL: number; gapR: number }> = [];
      for (const e of edges) {
        const a = anchor(`nd-${e.s[0]}-${e.s[1]}`, "r");
        const b = anchor(`nd-${e.t[0]}-${e.t[1]}`, "l");
        if (!a || !b) continue;
        const src = tiers[e.s[0]]?.items[e.s[1]];
        const dst = tiers[e.t[0]]?.items[e.t[1]];
        if (!src || !dst) continue;
        const touches = sel === `${e.s[0]}-${e.s[1]}` || sel === `${e.t[0]}-${e.t[1]}`;
        /* THE ROUTE'S OWN HEALTH, not just its endpoints'. One rule with the
         * CARDS the leg connects (utils/verdict HIT_BAD/HIT_WARN) — the old
         * inline 25% floor turned a leg red while the card at its end, on
         * the same numbers, stayed amber. Locations keep their own three-arm
         * rule (geoVerdict); components and their legs speak verdict.ts. */
        const rate = e.bad != null && e.v > 0 ? e.bad / e.v : null;
        const own: Tone = rate == null ? "info"
          : rate >= HIT_BAD ? "bad" : rate >= HIT_WARN ? "warn" : "info";
        const RANK: Record<Tone, number> = { info: 0, good: 0, warn: 1, bad: 2 };
        const endp: Tone = src.tone === "bad" || dst.tone === "bad" ? "bad"
          : src.tone === "warn" || dst.tone === "warn" ? "warn" : "info";
        const worse: Tone = RANK[own] > RANK[endp] ? own : endp;
        const w = 1.4 + 8.6 * (Math.log10(e.v + 1) / Math.log10(vmax + 1));
        const dur = Math.max(1.1, 8 - 1.6 * Math.log10(e.v + 1));
        // Health IS the colour, always — no click required: green means no
        // Davis signal on either end AND a clean leg; amber and red mean one
        // of them said otherwise. Selection only adjusts brightness; it
        // never changes what a colour means.
        const toneKey = worse === "info" ? "good" : worse;
        const stroke = TVAR[toneKey];
        const op = sel ? (touches ? 1 : 0.5) : 0.9;
        /* the hover carries the leg's facts: casualties and cost */
        const hurtWord = e.label === "sessions" ? "met an error" : "failed";
        // "clean" is EARNED, not defaulted: a transport leg whose app has
        // failed calls that carry no domain cannot claim it — silence there,
        // never a false all-clear
        const hurt = e.bad == null || rate == null ? ""
          : e.bad === 0 ? (e.blind ? "" : " · clean")
          : ` · ${fmtN(e.bad)} ${hurtWord} (${(rate * 100).toFixed(rate >= 0.1 ? 0 : 1)}%)`;
        const lat = e.p50 && e.p50 > 0 ? ` · p50 ${fmtMs(e.p50)}`
          : e.p90 && e.p90 > 0 ? ` · p90 ${fmtMs(e.p90)} (the median reports 0)` : "";
        /* THE LEG'S FORECAST: second half of the window against the first,
         * continued for one FULL window ahead — next = 2·(2·h2 − h1)
         * = 6·late − 2·v, so steady traffic projects ≈v. The first cut
         * projected only the next HALF and compared it against the whole,
         * which read every steady leg as "falling to half". Free — the scan
         * already paid for the split; small legs (<10) stay quiet because a
         * two-point line through noise is not a forecast. */
        const next = e.late != null && e.v >= 10
          ? Math.max(0, 6 * e.late - 2 * e.v) : null;
        const fcArrow = next == null ? ""
          : next > e.v * 1.1 ? "↗" : next < e.v * 0.9 ? "↘" : "→";
        const pace = next == null ? ""
          : fcArrow === "→" ? " · steady pace"
          : ` · heading to ≈${fmtN(next)} at the current pace`;
        // circuit-trace routing: straight runs with a 45° bend, like a PCB —
        // the geometry itself reads as technology, no decoration needed
        const mx = (a.x + b.x) / 2;
        const span = Math.max(1, b.x - a.x);
        const dxDiag = Math.min(Math.abs(b.y - a.y), span * 0.6);
        const x1 = mx - dxDiag / 2, x2 = mx + dxDiag / 2;
        const d = `M ${a.x} ${a.y} L ${x1} ${a.y} L ${x2} ${b.y} L ${b.x} ${b.y}`;
        parts.push(`<path class="e-base" d="${d}"
          stroke="${stroke}" marker-end="url(#ar-${toneKey})"
          style="color:${stroke};opacity:${op};stroke-width:${w.toFixed(1)}">
          <title>≈ ${fmtN(e.v)} ${e.label}${hurt}${lat}${pace}</title></path>`);
        // the data pulse: one bright packet travelling the trace, speed by volume
        if (op > 0.3) {
          parts.push(`<path class="e-pulse" d="${d}"
            stroke="color-mix(in srgb, ${stroke} 40%, #ffffff)"
            style="opacity:${Math.min(1, op + 0.15)};stroke-width:${(w * 0.5).toFixed(1)};animation-duration:${dur.toFixed(1)}s"/>`);
        }
        /* The label must live in the GAP between the two columns, not at the
         * geometric midpoint of the curve — on a narrow window the midpoint
         * slides under the neighbouring column's cards and the number is the
         * part that disappears. The gap is what the anchors already know:
         * a.x is the source column's right edge, b.x the target's left. */
        drawn.push({ mx, my: (a.y + b.y) / 2, v: e.v, label: e.label, op,
          next, fcArrow,
          /* The RIGHT edge of the writable gap is the target COLUMN's border,
           * not the target node: the backend elbow sits deep inside its band,
           * so clamping to the node let "288" slide under the panel and be
           * cut at its border. The node's column element knows where the band
           * begins. */
          gapL: a.x + 8,
          gapR: (() => {
            const el = document.getElementById(`nd-${e.t[0]}-${e.t[1]}`);
            const col = el?.closest(".gcol");
            if (col) {
              const cb = col.getBoundingClientRect();
              return (cb.left - box.left) / z - 8;
            }
            return b.x - 8;
          })() });
      }
      // A label EARNS its place or the line stays clean. Volume is already
      // said twice — on the card and by the line's width — and repeating it
      // here was called out as clutter. So the only thing written on a line
      // is a FINDING: this leg is leaving its pace (±10%), and where it
      // lands. Steady legs carry nothing; the full facts stay on hover.
      drawn.sort((x, y) => y.v - x.v);
      const seen = new Set<string>();
      for (const dd of drawn.filter((x) => x.op > 0.3)) {
        if (dd.next == null || dd.fcArrow === "→") continue;
        // one label per distinct figure: consecutive hops carry the same volume
        const k = `${dd.v}|${dd.label}`;
        if (seen.has(k)) continue;
        seen.add(k);
        // ~7.4px per mono glyph at the label's 12px (theme: .dcf-svg text).
        // A PERCENTAGE, because "↘ ≈24.1k" had to be decoded ("o que quer
        // dizer?") while "sessions ↘ 21%" reads itself. The absolute
        // projection moves into the label's own hover, which spells the
        // whole mechanism out.
        const pct = Math.round(Math.abs(dd.next / dd.v - 1) * 100);
        const full = `${dd.label} ${dd.fcArrow} ${pct}%`;
        /* the NOUN survives the squeeze, not the percentage: two bare
         * "↘ 17%" labels on neighbouring legs read as the same thing, and
         * the reader asked why one origin had two lines — the words
         * "requests" vs "sessions" ARE the answer */
        const short = `${dd.label} ${dd.fcArrow}`;
        const fit = (s: string) => dd.gapR - dd.gapL >= s.length * 7.4;
        const txt = fit(full) ? full : fit(short) ? short : null;
        if (!txt) continue;
        const need = txt.length * 7.4;
        const lx = Math.min(Math.max(dd.mx, dd.gapL + need / 2), dd.gapR - need / 2);
        const word = dd.fcArrow === "↘" ? "slowing" : "growing";
        parts.push(`<text x="${lx}" y="${dd.my - 7}">${txt}
          <title>This flow is ${word}: the window's second half ran ${pct}% ${dd.fcArrow === "↘" ? "under" : "over"} the first. At that pace the next window carries ≈${fmtN(dd.next)} ${dd.label} (now: ${fmtN(dd.v)}).</title></text>`);
      }
      svg.innerHTML = `<defs>${defs}</defs>` + parts.join("");
    };
    draw();
    const id = setTimeout(draw, 60);
    window.addEventListener("resize", draw);
    return () => { clearTimeout(id); window.removeEventListener("resize", draw); };
  }, [tiers, edges, sel, view]);

  const selAll = sel?.endsWith("-all") ? Number(sel.split("-")[0]) : null;
  const selElo = sel && selAll === null
    ? tiers[Number(sel.split("-")[0])]?.items[Number(sel.split("-")[1])] : null;
  const selTier = sel ? Number(sel.split("-")[0]) : null;

  // The entrance: once per application, the chain asserts itself — bands
  // sweep in, traces draw themselves, pulses join, and the signal lands last.
  const [intro, setIntro] = useState(false);
  useEffect(() => {
    // the show starts when the SCOPED graph is on stage, not when the
    // component mounts — the scope arrives seconds after the first paint
    if (!scope.resolved && scope.services.size === 0) return;
    setIntro(true);
    const t = window.setTimeout(() => setIntro(false), 1900);
    return () => window.clearTimeout(t);
  }, [appId, scope.resolved]);

  // The clicked component's vitals, fetched on selection only
  const metTarget = useMemo<MetricTarget | null>(() => {
    if (!selElo) return null;
    const svc = (selElo.ids ?? []).find((i) => i.startsWith("SERVICE-"));
    if (svc) return { kind: "service", id: svc };
    if (selTier === 2) return { kind: "app", id: appId };
    if (selElo.domain) return { kind: "domain", appId, domain: selElo.domain };
    return null;
  }, [selElo, selTier, appId]);
  const met = useNodeMetrics(metTarget);
  /* The Databases app's entity behind the selected store, resolved only
   * while its drawer is open. The namespace rides along because the measured
   * exact match was on it (TradeManagement), not on the address. */
  const selStore = selElo?.store ?? null;
  const selStoreNs = selStore
    ? stores?.find((st) => st.store === selStore && st.ns)?.ns : undefined;
  const dbEntity = useDbEntity(selStore, selStoreNs, !!selStore);

  // Whether the selected domain- or store-kind card has spans behind it —
  // decides whether its investigation route can offer Distributed Tracing
  // (Gen3) or has to fall back to a query. `store` doubles as an address
  // here exactly as it does in the route builder: a data store has no
  // `domain` field of its own, but it needs the identical span check.
  const selAddress = selElo?.domain ?? selElo?.store;
  const selDomainTraces = useDomainTraces(
    selAddress ? [selAddress] : [], data.tf, !!selAddress);


  // Whether the open drawer's element carries detected signals — it decides
  // which rows the drawer offers, not whether impact gets fetched (impact is
  // now loaded up front, because it colours the graph).
  const selHasSignals = !!selElo &&
    (problemsFor(selElo.ids ?? []).length > 0 || signalsFor(selElo.ids ?? []).length > 0);
  // Whatever made this element amber or red, the reader is owed the count of
  // people behind it — measured harm earns the row exactly as a Davis problem does.
  /* the layer drawer folds its unremarkable tail; a new selection folds it back */
  const [drawerAll, setDrawerAll] = useState(false);
  /* the reshape the reader asked for ("ao selecionar vejo isso… confuso"):
   * verdict + one primary action above the fold; the ledger and the persona
   * routes behind their own ▸. A new selection folds both back. */
  const [ledgerOpen, setLedgerOpen] = useState(false);
  /* routes OPEN by default — the reader tried the fold and asked for them
   * loaded; the button stays so they can be put away */
  const [routesOpen, setRoutesOpen] = useState(true);
  const [tpickAll, setTpickAll] = useState(false);
  /* the retired "-all" drawer's own data, fetched only if someone opens it */
  const layerStats = useLayerStats(data.tf, sel !== null && sel.endsWith("-all"));
  const layerJourneys = useJourneys(data.tf, sel !== null && sel.endsWith("-all"));
  useEffect(() => { setDrawerAll(false); setLedgerOpen(false); setRoutesOpen(true);
    setTpickAll(false); }, [sel]);
  /* Opening a LAYER lands on its most deserving element — the reader kept
   * arriving at the wall of 21 rows ("ao clicar ainda vejo isso") when the
   * element view now carries the picker to switch targets. Worst first,
   * busiest on a tie; the "-all" list survives only for direct links. */
  const openLayer = (ti: number, only?: (n: Elo) => boolean) => {
    const items = tiers[ti]?.items ?? [];
    let best = -1; let bestScore = Infinity;
    items.forEach((n, i) => {
      // the row's own filter travels: "Services" landed on the DATA STORE
      // (92% of the shared tier's volume) until the pick respected it
      if (n.miss || (only && !only(n))) return;
      const r = problemsFor(n.ids ?? []).length > 0 ? 0
        : signalsFor(n.ids ?? []).length > 0 ? 1
        : n.tone === "bad" ? 2 : n.tone === "warn" ? 3 : 4;
      const score = r * 1e12 - (n.vol ?? 0);
      if (score < bestScore) { bestScore = score; best = i; }
    });
    setSel((x) => {
      const target = best >= 0 ? `${ti}-${best}` : `${ti}-all`;
      return x === target ? null : target;
    });
  };

  const selShowsImpact = !!selElo && (selElo.tone === "bad" || selElo.tone === "warn");

  /* The element's investigation routes, computed once: the drawer's TOP
   * proposes the destination apps from them (the reader's rule — summarise
   * what matters, then name where to act), and the bottom still walks the
   * full routes. */
  const elRoutes = React.useMemo(() => {
    if (!selElo) return null;
    const fcObj = metTarget?.kind === "app" ? ahead : met?.fc;
    const fcRising = (!!fcObj && fcObj.slope > 0) || selElo.spark?.rising === true;
    const nProbs = problemsFor(selElo.ids ?? []).length;
    const nSigs = signalsFor(selElo.ids ?? []).length;
    const scopedApp = data.apps.find((a) => a.appId === appId);
    return {
      list: investigationPaths({
                  ids: selElo.ids ?? [],
                  name: selElo.nm,
                  tf: data.tf,
                  // buildTiers already knows exactly what kind of card this
                  // is — decided once, here, not re-guessed from ids prefixes
                  // inside investigationPaths (see kindOf's own comment).
                  kind: kindOf(selTier ?? -1, selElo),
                  problems: nProbs,
                  problem: problemsFor(selElo.ids ?? [])[0],
                  problemHints: problemsFor(selElo.ids ?? [])
                    .map((x) => `${x.category} ${x.name}`),
                  // Every element in this chain belongs to the one scoped
                  // application, whichever layer it sits in — not only the
                  // application card itself. A Consume-layer origin bucket
                  // (Mobile, Robots…) used to have no way to reach "Sessions
                  // and conversion" at all because this was gated to tier 2.
                  rumAppId: appId,
                  scopedAppName: scopedApp?.name,
                  // the sessions-store vocabulary for the Frontends chip —
                  // the inventory name filled it with a value the bar
                  // accepts and matches nothing (audit, EasyTrade LD)
                  scopedFrontend: scopedApp?.entity
                    ? feNames?.get(scopedApp.entity) : undefined,
                  scopedEntity: scopedApp?.entity,
                  // lets the route offer Error Inspector — the Gen3 app whose
                  // whole subject is the thing this element is failing at.
                  // Passed for every card; the kind switch decides which of
                  // them actually offer it (the app card and the origins).
                  errors: scopedApp?.errors,
                  // the processes this service card runs on, for the logs
                  // hop's arms — a VM service's logs are keyed by PGI only
                  logPgis: scope.placements
                    .filter((p) => (selElo.ids ?? []).includes(p.svc)
                      && p.type === "PROCESS" && p.classic)
                    .map((p) => p.classic!) as string[],
                  // an origin card's vol IS its session count — the sessions
                  // hand-off is gated on it, so a segment with nothing to
                  // list offers no list
                  sessions: selTier === 0 ? selElo.vol : undefined,
                  // the fatal subset, so a mobile application's route can
                  // lead with the thing its card leads with
                  crashes: scopedApp?.crashes,
                  dbEntity: dbEntity ?? undefined,
                  // A store card carries no `domain`, it carries `store` — the
                  // same address shape, just named for what it is.
                  domain: selElo.domain ?? selElo.store,
                  domainHasSpans: !!selAddress && !!selDomainTraces?.has(selAddress),
                  impacted: selShowsImpact && impacted && impacted.hit > 0 ? impacted : undefined,
                  signals: nSigs,
                  forecastRising: fcRising,
                  assist,
                  apps,
                  // the element's own measured numbers travel as hidden context,
                  // so Assist reads this element rather than the environment
                  facts: { lines: selElo.det.map(([k, v]) => `${k}: ${v}.`) },
      }),
      mode: (selElo.tone === "good" ? "optimize" : "incident") as "optimize" | "incident",
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selElo, selTier, appId, data, met, ahead, dbEntity, selAddress,
      selDomainTraces, impacted, assist, apps, feNames, scope]);


  const bar = (items: Array<[string, number]>, tone: (k: string) => Tone) => {
    const tot = items.reduce((a, i) => a + i[1], 0) || 1;
    return items.map(([k, v]) => (
      <div className="db" key={k}>
        <span className="db__n">{k}</span>
        <span className="db__t"><span className="db__f" style={{ width: `${(v / tot) * 100}%`, background: TVAR[tone(k)] }} /></span>
        <span className="db__v">{fmtN(v)} · {((v / tot) * 100).toFixed(1)}%</span>
      </div>
    ));
  };

  /* per-layer statistics, all coming from the queries */
  const stats = () => {
    if (selTier === null) return null;
    if (selTier === 0) {
      // the pillar header is this application's — so is the drawer now
      const devices = (layerStats?.devices ?? []).filter((r) => r.appId === appId);
      const tot = devices.reduce((a, r) => a + r.sessions, 0) || 1;
      return (<>
        <div className="dd">
          <Kpi l="Sessions" v={fmtN(tot)} t="info" />
          <Kpi l="Distinct profiles" v={String(devices.length)} t="good" />
          <Kpi l="Views" v={fmtK(devices.reduce((a, r) => a + r.views, 0))} t="warn" />
        </div>
        <div className="dd__h">Screen resolution <em>device.screen · measured</em></div>
        {bar(Object.entries(devices.reduce<Record<string, number>>((a, r) => {
          a[r.res] = (a[r.res] ?? 0) + r.sessions; return a;
        }, {})).sort((a, b) => b[1] - a[1]), (k) => (Number(k.split("×")[0]) < 800 ? "info" : "good"))}
        <div className="dd__h">Device profiles <em>{devices.length} combinations</em></div>
        <Table cols={["Resolution", "DPR", "Orientation", "Agent", "Type", "Sessions", "Views"]}
          rows={devices.map((r) => [r.res, r.dpr ?? "—", r.orient ?? "—", r.agent ?? "—",
            r.utype ?? "—", fmtN(r.sessions), fmtN(r.views)])} />
      </>);
    }
    if (selTier === 1 || selTier === 3) {
      // the pillar header is this application's — so is the drawer now
      const doms = data.domains.filter((r) => r.appId === appId);
      const pths = (layerStats?.paths ?? []).filter((r) => r.appId === appId);
      return (<>
        <div className="dd">
          <Kpi l="Domains" v={String(new Set(doms.map((r) => r.domain)).size)} t="good" />
          <Kpi l="Requests" v={fmtK(doms.reduce((a, r) => a + r.reqs, 0))} t="good" />
          <Kpi l="4xx/5xx errors" v={fmtN(doms.reduce((a, r) => a + r.err, 0))} t="good" />
        </div>
        <div className="dd__h">Contacted domains <em>url.domain · this application</em></div>
        <Table cols={["Domain", "Provider", "Req", "p50", "Errors"]}
          rows={doms.map((r) => [r.domain, r.provider ?? "—", fmtN(r.reqs), fmtMs(r.p50), fmtN(r.err)])} />
        <div className="dd__h">Most requested paths <em>url.path · this application</em></div>
        <Table cols={["Path", "Method", "Status", "Req", "p50", "p90"]}
          rows={pths.slice(0, 8).map((r) => [r.path, r.method ?? "—", r.status ?? "—",
            fmtN(r.reqs), fmtMs(r.p50), fmtMs(r.p90)])} />
      </>);
    }
    if (selTier === 2) {
      const vs = (layerJourneys?.views ?? []).filter((v) => v.appId === appId).slice(0, 8);
      return (<>
        <div className="dd">
          <Kpi l="Detected views" v={String(vs.length)} t="good" />
          <Kpi l="Sequences" v={String((layerJourneys?.sequences ?? []).filter((s) => s.appId === appId).length)} t="info" />
        </div>
        <div className="dd__h">Application views <em>view_summary · measured</em></div>
        <Table cols={["View", "Sessions", "Views", "p50", "Perf"]}
          rows={vs.map((v) => [v.view, fmtN(v.sessions), fmtN(v.views), fmtMs(v.p50), String(perfScore(v.p50))])} />
        <div className="dd__h">Discovered sequences <em>mined per session</em></div>
        <Table cols={["Journey", "Sessions"]}
          rows={(layerJourneys?.sequences ?? []).filter((s) => s.appId === appId).slice(0, 6)
            .map((s) => [s.journey.join(" → "), fmtN(s.sessions)])} />
      </>);
    }
    /* THE DRILL-DOWN RULE, sharpened again by the reader ("muitos dados que
     * não fazem nada"): the environment-wide KPI tiles and the dependency
     * table were inventory wearing the clothes of a finding — twelve rows of
     * service→service pairs nobody acts on here, when the relation map has
     * an owner (Smartscape, one hop from any element above). What remains is
     * the ONE scope fact the counts need so the header's totals never look
     * like the list's length. */
    if (selTier === 4) {
      const mine = new Set((tiers[4]?.items ?? []).map((n) => n.nm));
      const chainCalls = data.calls.filter((c) =>
        mine.has(c.src.split(" - ")[0]) || mine.has(c.dst.split(" - ")[0]));
      return (
        <p className="dd__note">
          {fmtN(chainCalls.length)} of the environment&apos;s {fmtN(data.calls.length)} call
          relations touch this chain. The relation map itself is Smartscape&apos;s job —
          open an element above and take &quot;See its relations&quot;.
        </p>
      );
    }
    const mineNames = new Set((selTier !== null ? tiers[selTier]?.items ?? [] : []).map((n) => n.nm));
    const chainPods = data.runtime.filter((r) => mineNames.has(r.pod) || mineNames.has(r.node));
    return (
      <p className="dd__note">
        {chainPods.length > 0
          ? `${fmtN(chainPods.length)} of the environment's ${fmtN(data.runtime.length)} mapped pods serve this chain.`
          : data.runtime.length > 0
            ? `None of the environment's ${fmtN(data.runtime.length)} mapped pods serve this chain — this layer runs elsewhere.`
            : "No pods are mapped in this environment."}
        {" "}The placement map is Smartscape&apos;s job — open an element above and take
        &quot;See its relations&quot;.
      </p>
    );
  };

  return (
    <div className="stack">
      <div className={`panel dcf-shell stage ${intro ? "intro" : ""}`} ref={shellRef}>
        <div className="stage__canvas" ref={canvasRef}
             style={view.z === 1 && view.x === 0 && view.y === 0
               ? undefined
               : { transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}>
          <svg className="dcf-svg" ref={svgRef} aria-hidden="true" />
          {/* THE FRAME FOLLOWS THE DENSEST COLUMN. The column height was a
              fixed 540px sized for a busy estate; an application with one node
              per layer drew five icons floating in a page of dark. The busiest
              column decides the height it needs, the fixed number only remains
              as a ceiling — a chain diagram should be as tall as its chain. */}
          <div className={`graph graph--sum${highlight ? " graph--hl" : ""}`} role="list"
            style={{ ["--chain-rows" as string]: String(chainRows),
              ["--gs" as string]: String(gscale) }}>
            {highlight && (
              <button className="hlbar" onClick={() => onHighlightClear?.()}
                title="Clear the spotlight">
                ⚠ {fmtN((() => {
                  // distinct anomalies matched to DRAWN cards — the banner
                  // once counted a scope-set the cards did not share, and
                  // "each lit card wears its count" could disagree with it
                  const lit = new Set<string>();
                  for (const t of tiers) for (const n of t.items) {
                    if (n.miss) continue;
                    for (const sg of signalsFor(n.ids ?? []))
                      if (sg.provider === "BASELINING") lit.add(`${sg.entityId}|${sg.name}`);
                  }
                  return lit.size;
                })())} anomalies spotlighted —
                each lit card wears its count · click anywhere to dismiss ✕
              </button>
            )}
            {tiers.slice(0, 4).map((layer, ti) => {
              // A layer with nothing in it is not drawn. Only the last one can
              // be empty — Cloud, where the machines have no provider behind
              // them — and an empty eighth column would be the very thing this
              // pass removed everywhere else: a component joined to nothing.
              if (!layer.items.length) return null;
              const tierIds = [...(idsOfTier[ti] ?? [])];
              const probs = tierIds.length ? problemsFor(tierIds).length : 0;
              const shown = layer.items.slice(0, 12);
              const hidden = layer.total - shown.length;
              const bandMod = layer.tone === "bad" ? "gcol--bad"
                : layer.tone === "warn" ? "gcol--warn" : "";
              return (
                <div className={`gcol ${bandMod}`} key={ti} role="listitem"
                  style={{ ["--ci" as string]: String(ti) }}>
                  <button
                    className={`gcol__hd ${sel === `${ti}-all` ? "gcol__hd--on" : ""}`}
                    onClick={() => openLayer(ti)}>
                    <span className="gcol__ic" aria-hidden="true">
                      {React.createElement(LAYER_ICON[ti], { size: 16 })}
                    </span>
                    <b>{TIERS[ti][2]}</b>
                    <span className="gcol__n">{fmtN(layer.total)}</span>
                    {probs > 0 && (
                      <span className="pb" title={`${probs} active problem${probs > 1 ? "s" : ""}`}>⚠ {probs}</span>
                    )}
                    {(() => {
                      const nSig = tierIds.length ? signalsFor(tierIds)
                        .filter((sg) => sg.provider === "BASELINING").length : 0;
                      return nSig > 0 ? (
                        <span className="pb pb--warn"
                          title={`${nSig} baselining anomal${nSig === 1 ? "y" : "ies"} in this layer`}>
                          ⚠ {nSig}
                        </span>
                      ) : null;
                    })()}
                  </button>
                  <span className="gcol__name">{TIERS[ti][0]}</span>
                  <span className="gcol__sub">{layer.kpi} {layer.kpiLabel}</span>
                  <div className="gcol__nodes">
                    {shown.map((n, ni) => {
                      const id = `${ti}-${ni}`;
                      /* The Serve column mixes three natures, and the reader
                         asked for a visible seam: a labelled divider is drawn
                         where the group changes — services, then classic
                         topology (the mainframe's home), then data stores.
                         Only drawn when the seam exists; a column of plain
                         services keeps its clean run. */
                      const seam = ti === 4 && n.grp
                        && shown[ni - 1]?.grp !== n.grp ? n.grp : null;
                      /* The card wears its anomaly count. Seven signals can
                         bind to two cards — a grouped workload, a "Nodes
                         running this app" card holding several nodes — and a
                         count that only exists on the Overview button cannot
                         be reconciled with what the eye finds here. */
                      const nSig = n.miss ? 0 : signalsFor(n.ids ?? [])
                        .filter((sg) => sg.provider === "BASELINING").length;
                      // measured volume sets the radius — 68k requests reads
                      // bigger than 3 pods before any label is read
                      const r = gscale * (9 + (n.vol ? Math.min(13, 3.4 * Math.log10(n.vol + 1)) : 2));
                      return (<React.Fragment key={id}>
                        {seam && (
                          <div className="gdiv" aria-hidden="true">
                            {/* Not "classic": in this platform's vocabulary
                                Classic names the Gen2 APPS, and the seam is
                                about these ELEMENTS' origin — they were
                                mapped from the topology model, not from
                                traces. The reader flagged the collision. */}
                            <b>{seam === "classic" ? "mapped from topology" : "data stores"}</b>
                          </div>
                        )}
                        <div data-node
                          className={`gnode ${n.miss ? "gnode--miss" : ""} ${sel === id ? "gnode--sel" : ""}`
                            + (highlight ? (n.tone === "warn" || n.tone === "bad"
                              ? " gnode--spot" : " gnode--dimmed") : "")}
                          role="button" tabIndex={0} title={n.nm}
                          onClick={() => setSel((x) => (x === id ? null : id))}
                          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault(); setSel((x) => (x === id ? null : id)); } }}>
                          <i id={"nd-" + id} className={`gnode__c gnode__c--${n.tone}`}
                            style={{ width: r * 2, height: r * 2 }} aria-hidden="true">
                            {!n.miss && React.createElement(nodeIcon(ti, n),
                              { size: Math.max(12, Math.round(r * 1.15)) })}
                          </i>
                          {nSig > 0 && (
                            <i className="gnode__sig"
                              title={`${nSig} Davis baselining anomal${nSig === 1 ? "y" : "ies"} on this component`}>
                              {nSig}
                            </i>
                          )}
                          <span className="gnode__nm">{n.nm}</span>
                          <span className="gnode__v">{n.v} {n.spark?.rising && (
                            <em className="gnode__fc" title={ahead ? `Forecast: errors rising over the next ${aheadOf(ahead)} — the platform's own predictive analyzer, over this application's error series` : "This component's error count is rising across the window"}>↗ forecast</em>
                          )}</span>
                        </div>
                      </React.Fragment>);
                    })}
                    {hidden > 0 && (
                      <button className="gnode gnode--more" data-node
                        onClick={() => openLayer(ti)}>
                        <i className="gnode__c gnode__c--info" style={{ width: 18, height: 18 }} aria-hidden="true" />
                        <span className="gnode__nm">+{fmtN(hidden)} more</span>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}

            {/* ── THE BACKEND, summarised ──
                Everything the four RUM layers hand off to, as one block: the
                counts the scope still measures, the worst verdict among them,
                and one row per subject pointing at the platform app that
                already manages it. The deep per-node mapping this replaced is
                Smartscape's job — and the problem path draws it on demand. */}
            {(() => {
              const beIds = [4, 5, 6, 7].flatMap((ti) => [...(idsOfTier[ti] ?? [])]);
              const beProbs = problemsFor(beIds).length;
              const beAnoms = signalsFor(beIds)
                .filter((sg) => sg.provider === "BASELINING").length;
              const beTone: Tone = [4, 5, 6, 7].reduce<Tone>(
                (acc, ti) => worseOf(acc, tiers[ti]?.tone ?? "good"), "good");
              const storeCount = new Set((stores ?? []).map((st) => st.store)).size;
              /* THIS app's runtime, not the tenant's: `data.runtime` is the
               * whole environment, and it sent a VM-deployed application's
               * reader to the Kubernetes app — measured, easytravel's 8
               * services run on zero pods. While the scope is still
               * resolving, the environment-wide guess stands in. */
              const isK8s = scope.resolved
                ? scope.placements.some((pl) => pl.type === "K8S_POD")
                : data.runtime.length > 0;
              const lam = (cloud ?? []).filter((c) => c.kind === "lambda");
              const inst = (cloud ?? []).filter((c) => c.kind !== "lambda");
              const region = [...new Set([
                ...lam.map((c) => c.region).filter(Boolean),
                ...inst.map((c) => c.zoneName).filter(Boolean)])].join(" · ");
              const row = (
                ti: number, label: string, value: string,
                target: keyof AppMap | null, sub?: string,
                /** A destination MORE specific than the app's home — an
                 *  intent URL already scoped to this chain's entities. */
                go?: { href: string; title: string },
                /** Which of the tier's cards this row actually summarises —
                 *  Services and Data stores SHARE tier 4, and without the
                 *  split the store row wore the service row's aching names
                 *  and problem badges verbatim (the reader's screenshot). */
                only?: (n: Elo) => boolean,
              ) => {
                const t = target ? apps[target] : undefined;
                const tone = tiers[ti]?.tone ?? "info";
                const mine = (tiers[ti]?.items ?? []).filter(only ?? (() => true));
                const ids = only
                  ? mine.flatMap((n) => n.ids ?? [])
                  : [...(idsOfTier[ti] ?? [])];
                const rProbs = ids.length ? problemsFor(ids).length : 0;
                const rAnoms = ids.length ? signalsFor(ids)
                  .filter((sg) => sg.provider === "BASELINING").length : 0;
                /* "If the layer has a problem, I need to know WHICH entity" —
                   the aching ones are named on the row itself, worst first.
                   The FIRST name only, clamped: a Spring service's full name
                   with its [eks] tags ran the row across the screen. */
                const aching = mine
                  .filter((n) => !n.miss && (n.tone === "bad" || n.tone === "warn"))
                  .sort((a, b) => (a.tone === "bad" ? 0 : 1) - (b.tone === "bad" ? 0 : 1))
                  .map((n) => n.nm).slice(0, 2);
                return (
                  <div key={label}
                    className={`bsum__row bsum__row--ent bsum__row--${tone}`}
                    role="button" tabIndex={0}
                    title="Investigate this layer — opens its most deserving element, with the picker to switch"
                    onClick={() => openLayer(ti, only)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault(); openLayer(ti, only); } }}>
                    <i className={`gnode__c gnode__c--${tone} bsum__ic`} aria-hidden="true">
                      {React.createElement(LAYER_ICON[ti], { size: 13 })}
                      {rAnoms > 0 && <em className="gnode__sig bsum__sig">{rAnoms}</em>}
                    </i>
                    <span className="bsum__l">{label}
                      {rProbs > 0 && <b className="bsum__pb"> ⚠ {rProbs}</b>}
                    </span>
                    <b className="bsum__v">{value}</b>
                    {(aching.length > 0 || sub) && (
                      <em className={`bsum__s${aching.length ? " bsum__s--hurt" : ""}`}>
                        {aching.length ? aching.join(" · ") : sub}
                      </em>
                    )}
                    {/* THE READER'S RULE, stated after the audit: an
                        unfiltered door is not a drilldown — "Services →"
                        opening the app's home says nothing about THIS chain,
                        so it says nothing at all. A row's foot link renders
                        only when it arrives already scoped (today: the
                        Kubernetes namespace). The row itself still opens the
                        layer drawer, where every element carries its own
                        filtered routes. */}
                    {t && go && (
                      <a className="bsum__go" href={go.href}
                        target="_blank" rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        title={go.title}>
                        {t.name} →
                      </a>
                    )}
                  </div>
                );
              };
              return (
                <div className={`gcol gcol--bsum ${beTone === "bad" ? "gcol--bad"
                    : beTone === "warn" ? "gcol--warn" : ""}`
                    + (highlight ? (beAnoms > 0 || beProbs > 0
                      ? " bsum--spot" : " bsum--dim") : "")}
                  role="listitem">
                  <div className="gcol__hd" style={{ cursor: "default" }}>
                    <span className="gcol__ic" aria-hidden="true">
                      {React.createElement(ServicesIcon, { size: 16 })}
                    </span>
                    <b>BACKEND</b>
                    {beProbs > 0 && <span className="pb">⚠ {beProbs}</span>}
                    {beAnoms > 0 && <span className="pb pb--warn">⚠ {beAnoms}</span>}
                  </div>
                  <span className="gcol__name">Serve · Run · Host · Cloud</span>
                  <span className="gcol__sub">managed by the platform&apos;s own apps</span>
                  <div className="bsum" >
                    {/* the seam's landing point — the mesh draws into this */}
                    <i id="nd-4-0" className={`gnode__c gnode__c--${beTone} bsum__c`}
                      aria-hidden="true">
                      {React.createElement(ServicesIcon, { size: 15 })}
                    </i>
                    {scope.loading
                      ? <div className="bsum__row"><em className="bsum__s">resolving the scope…</em></div>
                      : (<>
                        {row(4, "Services", fmtN(Math.max(0, (tiers[4]?.total ?? 0) - storeCount)), "services",
                          (() => { const n = (gen2 ?? []).filter((g) => gen2CardKept(g, stores)).length;
                            return n > 0 ? `${n} topology-mapped` : undefined; })(),
                          undefined, (n) => !n.store)}
                        {storeCount > 0 && row(4, "Data stores", fmtN(storeCount), "databases",
                          undefined, undefined, (n) => !!n.store)}
                        {/* NO namespace shortcut. Both declared intents were
                           tried and BOTH opened the Kubernetes app's home,
                           reader-verified twice: view-entity-dt.smartscape.
                           k8s_namespace (nodeId, Smartscape id) and
                           view-entity-dt.entity.cloud_application_namespace
                           (meId, classic id — the pod pattern's form). An
                           unfiltered door is not a drilldown; the filtered
                           path to Kubernetes is each pod's own route in the
                           drawer, whose intent IS navigation-verified. */}
                        {row(5, "Runtime", fmtN(tiers[5]?.total ?? 0),
                          isK8s ? "kubernetes" : "hosts",
                          tiers[5]?.kpiLabel)}
                        {row(6, "Infrastructure", fmtN(tiers[6]?.total ?? 0), "hosts",
                          tiers[6]?.kpiLabel)}
                        {(lam.length > 0 || inst.length > 0) && row(7, "Cloud",
                          lam.length ? `${lam.length} lambda` : `${inst.length} instances`,
                          null, region || undefined)}
                      </>)}
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
        <div className="zoomctl">
          <button onClick={zoomOut} title="Zoom out" aria-label="Zoom out">−</button>
          <span className="lvl">{Math.round(view.z * 100)}%</span>
          <button onClick={zoomIn} title="Zoom in" aria-label="Zoom in">+</button>
          <button onClick={fit} title="Fit to view" aria-label="Fit to view">⤢</button>
          <button onClick={reset} title="Reset to 100%" aria-label="Reset">1:1</button>
        </div>
      </div>

      {/* Click = a screen of its own: the details slide OVER the graph as a
          drawer. ✕, Escape or the backdrop hand the stage back untouched. */}
      {(selElo || selAll !== null) && (
      <div className="ovl" onClick={(e) => {
        if (e.target === e.currentTarget) setSel(null);
      }}>
        <aside className="panel drawer" role="dialog" aria-modal="true"
          aria-label={selElo ? `Details: ${selElo.nm}` : "Layer details"}>
        <div className="panel__hd">
          {/* say WHAT it is, not "Selected link · layer 05" — the reader
              opened a database and the header spoke internal jargon */}
          <span className="lbl">{selAll !== null
            ? `${TIER_NAME[selAll] ?? "layer"} — all elements`
            : selElo ? ENTITY_WORD[kindOf(selTier ?? -1, selElo)] : "element"}</span>
          <span className="hint">{TIER_NAME[selTier ?? selAll ?? 0] ?? ""}</span>
          <button className="drawer__x" onClick={() => setSel(null)} aria-label="Close">✕</button>
        </div>
        <div className="pad side__body drawer__body">
          {selAll !== null ? (
            <>
              {/* Impact leads, always: the elements dragging this layer come
                  first, wearing their signals — a drill-down that buries the
                  aching element under the healthy ones answers nothing. The
                  original index rides along so selection still lands right. */}
              {(() => {
                const rows = tiers[selAll].items.map((n, i) => ({
                  n, i,
                  probs: n.miss ? 0 : problemsFor(n.ids ?? []).length,
                  sigs: n.miss ? 0 : signalsFor(n.ids ?? []).length,
                }));
                const impacted = rows.filter((r) => r.probs > 0 || r.sigs > 0).length;
                const rank = (r: typeof rows[number]) =>
                  (r.probs > 0 ? 0 : r.sigs > 0 ? 1 : r.n.tone === "bad" ? 2
                    : r.n.tone === "warn" ? 3 : 4);
                const orderly = [...rows].sort((a, b) =>
                  rank(a) - rank(b) || (b.probs - a.probs) || (b.sigs - a.sigs)
                    || (b.n.vol ?? 0) - (a.n.vol ?? 0));
                /* THE CALCULATING CUT, sharpened by the reader's second rule:
                 * show only what needs attention. When anything aches — a
                 * problem, a signal, an amber or red tone — ONLY the aching
                 * open; even high-traffic healthy elements fold, because
                 * during an incident they are noise. Only when the whole
                 * layer is quiet does volume earn a place: the three
                 * heaviest, where optimisation pays. Either way the fold is
                 * honest — counted on the button, one click away. */
                const topVol = new Set([...rows]
                  .sort((a, b) => (b.n.vol ?? 0) - (a.n.vol ?? 0))
                  .slice(0, 3).map((r) => r.i));
                const aching = orderly.filter((r) => r.probs > 0 || r.sigs > 0
                  || r.n.tone === "bad" || r.n.tone === "warn");
                const lead = aching.length > 0 ? aching
                  : orderly.filter((r) => topVol.has(r.i));
                const shown = drawerAll ? orderly : lead;
                const hidden = orderly.length - shown.length;
                const layerVol = rows.reduce((acc, r) => acc + (r.n.vol ?? 0), 0);
                return (<>
                  <div className="dd__h">All elements in this layer
                    <em>{fmtN(tiers[selAll].total)} total · {fmtN(tiers[selAll].items.length)} mapped
                      {impacted > 0 && <> · <b className="lrow__impn">{impacted} under an active signal</b></>}</em></div>
                  {aching.length === 0 && rows.length > 1 && (
                    <p className="dd__calm">Nothing here needs attention. The elements shown
                      carry the most traffic — where optimisation pays; the rest are healthy
                      and folded.</p>
                  )}
                  {shown.map(({ n, i, probs, sigs }) => (
                    <div key={i}
                         className={`lrow${probs > 0 || sigs > 0 ? " lrow--imp" : ""}`}
                         style={{ ["--tone" as string]: TVAR[n.tone] }}
                         role="button" tabIndex={0}
                         onClick={() => setSel(`${selAll}-${i}`)}
                         onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") {
                           e.preventDefault(); setSel(`${selAll}-${i}`); } }}>
                      <span className="lrow__n">{n.nm}
                        {probs > 0 && <i className="lrow__tag lrow__tag--p"
                          title="Active Davis problems on this element">
                          {probs} problem{probs > 1 ? "s" : ""}</i>}
                        {sigs > 0 && <i className="lrow__tag lrow__tag--a"
                          title="Anomalies Davis is watching on this element">
                          {sigs} anomal{sigs > 1 ? "ies" : "y"}</i>}
                      </span>
                      <span className="lrow__m">{n.mt}
                        {probs === 0 && sigs === 0 && topVol.has(i) && layerVol > 0
                          && (n.vol ?? 0) / layerVol >= 0.05
                          && <> · carries {Math.round(((n.vol ?? 0) / layerVol) * 100)}% of the layer&apos;s volume</>}
                      </span>
                      <span className="lrow__v">{n.v}</span>
                    </div>
                  ))}
                  {hidden > 0 && (
                    <button className="lrow lrow--fold" onClick={() => setDrawerAll(true)}>
                      {aching.length > 0
                        ? `show ${fmtN(hidden)} healthy — folded while ${fmtN(aching.length)} element${aching.length > 1 ? "s" : ""} need${aching.length > 1 ? "" : "s"} attention ▾`
                        : `show ${fmtN(hidden)} more — nothing failing, nothing remarkable ▾`}
                    </button>
                  )}
                  {drawerAll && orderly.length > lead.length && (
                    <button className="lrow lrow--fold" onClick={() => setDrawerAll(false)}>
                      fold the healthy tail ▴
                    </button>
                  )}
                </>);
              })()}
              {tiers[selAll].total > tiers[selAll].items.length && (
                <p className="dd__note">
                  {fmtN(tiers[selAll].total - tiers[selAll].items.length)} further elements exist in this layer
                  but carry no relation to the selected application, so they are counted and not listed.
                </p>
              )}
              <div style={{ marginTop: 14 }}>{stats()}</div>
            </>
          ) : !selElo ? null : (
            <>
              <div className="chain" style={{ marginBottom: 12 }}>
                <span className="chain__node">
                  <i className="sig" style={{ background: TVAR[selElo.tone] }} />{selElo.nm}
                </span>
                {/* the identity line: an IP alone said nothing — the card's
                    own meta (technology · volume) travels with the name */}
                {selElo.mt && (
                  <em style={{ display: "block", marginTop: 4, fontStyle: "normal",
                    font: "400 10.5px var(--mono)", color: "var(--ink-3)" }}>
                    {selElo.mt}
                  </em>
                )}
              </div>

              {/* THE TARGET PICKER — the reader's own design: the routes and
                  the "which one do I investigate" choice live in one place.
                  Siblings of the same layer as chips, the aching first and
                  wearing their signal; a click re-aims the verdict, the
                  primary action and the routes without going back. */}
              {(() => {
                const sibs = (tiers[selTier ?? -1]?.items ?? [])
                  .map((n, i) => ({ n, i,
                    probs: n.miss ? 0 : problemsFor(n.ids ?? []).length,
                    sigs: n.miss ? 0 : signalsFor(n.ids ?? []).length }))
                  .filter((x) => !x.n.miss);
                if (sibs.length < 2) return null;
                const rank = (x: typeof sibs[number]) =>
                  x.probs > 0 ? 0 : x.sigs > 0 ? 1
                    : x.n.tone === "bad" ? 2 : x.n.tone === "warn" ? 3 : 4;
                const ordered = [...sibs].sort((a, b) =>
                  rank(a) - rank(b) || (b.n.vol ?? 0) - (a.n.vol ?? 0));
                const shown = tpickAll ? ordered : ordered.slice(0, 8);
                return (
                  <div className="tpick">
                    <span className="tpick__l">investigate</span>
                    {shown.map(({ n, i, probs: p, sigs: sg }) => {
                      const on = sel === `${selTier}-${i}`;
                      const hurt = p > 0 || n.tone === "bad" ? "bad"
                        : sg > 0 || n.tone === "warn" ? "warn" : "good";
                      return (
                        <button key={i}
                          className={`tpick__c tpick__c--${hurt}${on ? " tpick__c--on" : ""}`}
                          onClick={() => setSel(`${selTier}-${i}`)}
                          title={p > 0 ? `${n.nm} — ${p} active problem${p > 1 ? "s" : ""}`
                            : sg > 0 ? `${n.nm} — ${sg} signal${sg > 1 ? "s" : ""} on it`
                            : n.nm}>
                          <i />{n.nm.length > 22 ? `${n.nm.slice(0, 21)}…` : n.nm}
                          {p > 0 && <b>⚠{p}</b>}
                        </button>
                      );
                    })}
                    {ordered.length > 8 && (
                      <button className="tpick__c" style={{ borderStyle: "dashed" }}
                        onClick={() => setTpickAll((o) => !o)}>
                        {tpickAll ? "fewer ▴" : `+${ordered.length - 8} more ▾`}
                      </button>
                    )}
                  </div>
                );
              })()}

              {/* THE VERDICT, FOR EVERY ELEMENT — the reshape the reader
                  asked for: a click used to open on seven key-value rows and
                  only then propose apps ("confuso"). One sentence now
                  answers "is this ok and what matters", composed from the
                  facts already fetched; the ledger becomes evidence behind
                  a fold, and one primary action stands where three persona
                  walls stood. */}
              {(() => {
                const probs = problemsFor(selElo.ids ?? []);
                const sigs = signalsFor(selElo.ids ?? []);
                const d0 = (k: RegExp) =>
                  selElo.det.find(([kk]) => k.test(kk))?.[1] as string | undefined;
                const v = (() => {
                  // ONE verdict vocabulary (Critical/Warning/Healthy) — the
                  // ledger box below says "Critical" and this sentence said
                  // "Needs attention" for the same state
                  if (probs.length) return { t: "bad" as const,
                    txt: `Critical — ${probs[0].name}`,
                    sub: `${probs[0].display_id} · ${probs[0].category}`
                      + (probs.length > 1 ? ` · +${probs.length - 1} more` : "") };
                  if (selElo.tone === "bad" || selElo.tone === "warn") {
                    const hit = d0(/hit by errors/i);
                    return { t: selElo.tone,
                      txt: hit ? `Users are feeling it — ${hit}`
                        : `Wearing a ${selElo.tone === "bad" ? "critical" : "warning"} signal`,
                      sub: "the evidence is below" };
                  }
                  if (sigs.length) return { t: "warn" as const,
                    txt: `Warning — ${sigs[0].name} under watch`,
                    sub: `anomaly under watch${sigs.length > 1 ? ` · +${sigs.length - 1} more` : ""}; nothing failing yet` };
                  const short = (s?: string) => s && s.length <= 28 ? s : undefined;
                  const calls = short(d0(/^calls/i)); const p50 = short(d0(/^p50$/i));
                  // only a COUNT may ride the sentence — a service card's
                  // "Called by" lists callers by name and rebuilt the very
                  // wall this verdict replaces
                  const servedRaw = d0(/^called by/i);
                  const served = servedRaw && /^\d+\s/.test(servedRaw) ? servedRaw : undefined;
                  const sess = short(d0(/^sessions$/i));
                  const reqs = short(d0(/^requests$/i));
                  const fact = calls
                    ? `${calls} calls at p50 ${p50 ?? "—"}${served ? `, answering ${served}` : ""}`
                    : sess ? `${sess} sessions in the window`
                    : reqs ? `${reqs} requests${p50 ? ` at p50 ${p50}` : ""}`
                    : "nothing from Davis on it";
                  const silence = /not reported/i.test(String(d0(/failed/i) ?? ""))
                    ? " Failure is not reported on these spans — silence is not proof of clean."
                    : "";
                  return { t: "good" as const, txt: `Healthy — ${fact}.${silence}`, sub: null };
                })();
                return (
                  <div className="elsum">
                    <span className={`elsum__v elsum__v--${v.t}`}>
                      {v.t === "good" ? "" : "⚠ "}{v.txt}
                      {v.sub && <em>{v.sub}</em>}
                    </span>
                  </div>
                );
              })()}
              {/* ONE PRIMARY ACTION — the technical route's own first step,
                  which the route builder already orders best-first (a Davis
                  problem leads when one exists). The full persona walk waits
                  behind the fold at the bottom. */}
              {elRoutes && (() => {
                const first = elRoutes.list[0]?.steps?.[0] as
                  { label?: string; app?: string; href?: string; proves?: string } | undefined;
                if (!first?.href || !first.label) return null;
                return (
                  <a className="drill-primary" href={first.href}
                    target="_blank" rel="noreferrer"
                    title={first.proves ?? undefined}>
                    {first.label}{first.app ? ` — ${first.app}` : ""} →
                  </a>
                );
              })()}
              {met && (() => {
                const fc = metTarget?.kind === "app" ? ahead : met.fc;
                const fcRising = !!fc && fc.slope > 0;
                return (<>
                  {/* The window is part of the number. These come from the
                      metric store's last 30 minutes while the ledger below
                      counts the selected timeframe — which is why "failures 1"
                      could sit above "errors 10" and read as a contradiction.
                      Both windows are now stated where their numbers are. */}
                  <div className="dd__h">How it is answering right now
                    <em>live · last 30 min</em></div>
                  <div className="dd" style={{ marginBottom: 6 }}>
                    {/* The metric store keeps an average, not percentiles.
                        Printing it under p50, p90 and p95 would be the same
                        number three times, each claiming to be something it
                        is not — so a fallback reading says what it is. */}
                    {met.avgOnly && (
                      <Kpi l="avg (metric store)"
                        v={met.ready ? fmtMs(met.p50) : "…"} t="info" />
                    )}
                  </div>
                  {/* TRAFFIC AS ONE FACT, NOT TWO NUMBERS.
                    * "Throughput 216.3k" beside "Failures 0" is two boxes the
                    * reader has to divide in their head, and on an element with
                    * no percentiles they were the whole panel. One strip says
                    * it: the volume, the failing share drawn against it, and
                    * the rate spelled out. A clean element reads as a full
                    * green bar — an answer, where before there was arithmetic
                    * homework. */}
                  {met.ready && (() => {
                    const rate = met.thr > 0 ? met.fails / met.thr : 0;
                    // one failure-rate rule with the overview card:
                    // bad >= 1%, warn >= 0.1% — 'any failure = amber' made
                    // one blip in a million wear a warning here only
                    const bad = rate >= 0.01, warn = rate >= 0.001 && rate < 0.01;
                    const col = bad ? "var(--bad)" : warn ? "var(--warn)" : "var(--good)";
                    return (
                      <div className="trf">
                        <div className="trf__top">
                          <b className="num">{fmtK(met.thr)}</b>
                          <span>calls · last 30 min</span>
                          <em style={{ color: col }}>
                            {met.fails === 0 ? "none failed"
                              : `${fmtN(met.fails)} failed · ${(rate * 100).toFixed(rate < 0.001 ? 3 : 2)}%`}
                          </em>
                        </div>
                        <div className="trf__bar">
                          <i className="trf__ok" />
                          <i className="trf__no" style={{
                            width: `${Math.min(100, Math.max(rate > 0 ? 1.5 : 0, rate * 100))}%`,
                            background: col }} />
                        </div>
                      </div>
                    );
                  })()}
                  {/* THE LATENCY LADDER. Three boxes reading 1.4s · 9.7s · 11.5s
                    * hid the only thing that matters about them: the SPREAD.
                    * The same three numbers on one logarithmic rail show the
                    * tail as distance — a p95 eight times the median stops
                    * being three tidy figures and becomes a gap you can see.
                    * Log, because latency spans decades and a linear rail
                    * would pin the median to the left edge. */}
                  {!met.avgOnly && met.ready && met.p95 > 0 && (() => {
                    const lo = Math.max(1, Math.min(met.p50, 100));
                    const hi = Math.max(met.p95 * 1.15, lo * 2);
                    const at = (v: number) => {
                      const t = (Math.log(Math.max(v, lo)) - Math.log(lo))
                        / Math.max(Math.log(hi) - Math.log(lo), 0.0001);
                      return Math.min(97, Math.max(0, t * 100));
                    };
                    const tail = met.p50 > 0 ? met.p95 / met.p50 : 0;
                    const marks: Array<[string, number, string]> = [
                      ["p50", met.p50, "var(--t-cyan)"],
                      ["p90", met.p90, "var(--warn)"],
                      ["p95", met.p95, "var(--bad)"],
                    ];
                    return (
                      <div className="lad">
                        <div className="lad__rail">
                          <i className="lad__fill" style={{ left: `${at(met.p50)}%`,
                            width: `${Math.max(2, at(met.p95) - at(met.p50))}%` }} />
                          {marks.map(([k, v, c]) => (
                            <i key={k} className="lad__tick" style={{ left: `${at(v)}%`, background: c }} />
                          ))}
                        </div>
                        <div className="lad__legend">
                          {marks.map(([k, v, c]) => (
                            <span key={k}><i style={{ background: c }} />{k}
                              {" "}<b className="num">{fmtMs(v)}</b></span>
                          ))}
                          {tail >= 2 && (
                            <em className={tail >= 5 ? "lad__tail lad__tail--bad" : "lad__tail"}>
                              the slowest 5% wait {tail.toFixed(1)}× the median
                            </em>
                          )}
                        </div>
                      </div>
                    );
                  })()}
                  {fc && (
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 14,
                      fontSize: 12, padding: "5px 0", borderTop: "1px solid var(--border)" }}>
                      <span className="dim">Forecast (next {aheadOf(fc)})</span>
                      <b className="num" style={{ fontSize: 12,
                        color: fcRising && metTarget?.kind === "app" ? "var(--warn)" : "var(--ink)" }}>
                        ≈ {fmtK(Math.round(fc.total))} {metTarget?.kind === "app" ? "errors" : "calls"}
                        {" "}· {fcRising ? "rising" : "easing"}
                      </b>
                    </div>
                  )}
                </>);
              })()}
              {/* Who the errors reached — rendered exactly when the element
                  has signals, because impact with nothing driving it is just
                  a scary number. "Users" is measured as sessions: this RUM
                  carries no user identity, and the split says who the
                  sessions belong to. */}
              {selShowsImpact && impacted && impacted.hit > 0 && (() => {
                const split = [
                  impacted.hitReal > 0 ? `${fmtN(impacted.hitReal)} real` : "",
                  impacted.hitRobot > 0 ? `${fmtN(impacted.hitRobot)} robots` : "",
                  impacted.hitSynth > 0 ? `${fmtN(impacted.hitSynth)} synthetic` : "",
                ].filter(Boolean).join(" · ");
                return (
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 14,
                    fontSize: 12, padding: "5px 0", borderTop: "1px solid var(--border)" }}>
                    <span className="dim">Users impacted <em style={{ fontStyle: "normal" }}>
                      (errors · last {data.tf.label})</em></span>
                    <b className="num" style={{ fontSize: 12, color: "var(--bad)", textAlign: "right" }}>
                      {fmtN(impacted.hit)} of {fmtN(impacted.sessions)} sessions
                      {split ? ` — ${split}` : ""}
                    </b>
                  </div>
                );
              })()}
              {/* THE VERDICT FIRST, THE LEDGER AFTER.
                *
                * This was a flat key-value dump with the verdict last: a
                * reader met "Sessions / Views / Errors / View p50" and only at
                * the bottom learned the thing was in Warning. Worse, the
                * numbers read as contradictory — "FAILURES 1" in the vitals
                * card beside "Errors 10" in the list — because the two are
                * measured over DIFFERENT WINDOWS and neither said so. The
                * status is lifted to the top as a verdict, and the ledger
                * below carries the window it belongs to. */}
              {(() => {
                const rows = selElo.det;
                const status = rows.find(([k]) => /^status$/i.test(k));
                const rest = rows.filter(([k]) => !/^status$/i.test(k));
                /* the verdict WORD decides the colour — the old regex
                 * defaulted everything else to green, so "No users" and
                 * "Not measured" (info verdicts, not judgements) wore the
                 * healthy colour. Info renders in ink, as everywhere. */
                const sv = String(status?.[1] ?? "");
                const tone = /^warning/i.test(sv) ? "var(--warn)"
                  : /^critical/i.test(sv) || /(down|fail)/i.test(sv) ? "var(--bad)"
                  : /^healthy/i.test(sv) ? "var(--good)"
                  : "var(--ink-2)";
                return (<>
                  {status && (
                    <div style={{ display: "flex", alignItems: "baseline", gap: 9,
                      margin: "10px 0 2px", padding: "8px 11px", borderRadius: 8,
                      border: `1px solid color-mix(in srgb, ${tone} 45%, var(--border))`,
                      background: `color-mix(in srgb, ${tone} 10%, transparent)` }}>
                      <span className="dim" style={{ fontSize: 9, letterSpacing: ".12em",
                        textTransform: "uppercase", color: tone }}>verdict</span>
                      <b style={{ fontSize: 12, color: tone }}>{status[1]}</b>
                    </div>
                  )}
                  {/* evidence, one click away — the open drawer used to BE
                      this wall, and the verdict above now carries what it
                      proves */}
                  {rest.length > 0 && (
                    <button onClick={() => setLedgerOpen((o) => !o)}
                      style={{ display: "block", width: "100%", textAlign: "left",
                        background: "none", border: "none", cursor: "pointer",
                        fontSize: 9, letterSpacing: ".12em", textTransform: "uppercase",
                        color: "var(--ink-3)", margin: "12px 0 2px", padding: 0,
                        fontFamily: "var(--mono)" }}>
                      the ledger · {data.tf.label} · {rest.length} facts {ledgerOpen ? "▾" : "▸"}
                    </button>
                  )}
                  {ledgerOpen && rest.map(([k, v]) => (
                    <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 14,
                      fontSize: 12, padding: "5px 0", borderTop: "1px solid var(--border)" }}>
                      <span className="dim">{k}</span>
                      <b className="num" style={{ fontSize: 12, textAlign: "right" }}>{v}</b>
                    </div>
                  ))}
                </>);
              })()}
              {/* Signals only, as data: each block exists exactly when the
                  Davis has something on THIS entity — no prose, no empty
                  states, no environment-wide tables. Routes stay below. */}
              {(() => {
                const ids = selElo.ids ?? [];
                const probs = problemsFor(ids);
                const sigs = signalsFor(ids);
                const anom = sigs.filter((x) => x.provider === "BASELINING");
                const custom = sigs.filter((x) =>
                  x.provider === "METRIC_EVENTS" || x.provider === "EVENTS_REST_API_INGEST");
                const exts = sigs.filter((x) => x.provider !== "BASELINING"
                  && x.provider !== "METRIC_EVENTS" && x.provider !== "EVENTS_REST_API_INGEST");
                if (!probs.length && !anom.length && !custom.length && !exts.length) return null;
                return (
                  <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--border-2)" }}>
                    {probs.length > 0 && (<>
                      <div className="dd__h" style={{ color: "var(--bad)" }}>
                        Problems <em>Davis</em>
                      </div>
                      <Table cols={["ID", "Problem", "Category"]}
                        rows={probs.map((p) => [p.display_id, p.name, p.category])} />
                    </>)}
                    {anom.length > 0 && (<>
                      <div className="dd__h" style={{ color: "var(--warn)" }}>
                        Anomalies <em>baselining</em>
                      </div>
                      <Table cols={["Signal", "Status", "Events"]}
                        rows={anom.slice(0, 8).map((a) => [a.name, a.status, fmtN(a.events)])} />
                    </>)}
                    {custom.length > 0 && (<>
                      <div className="dd__h" style={{ color: "var(--info)" }}>
                        Custom alerts
                      </div>
                      <Table cols={["Alert", "Status", "Events"]}
                        rows={custom.slice(0, 8).map((a) => [a.name, a.status, fmtN(a.events)])} />
                    </>)}
                    {exts.length > 0 && (<>
                      <div className="dd__h" style={{ color: "var(--accent)" }}>
                        Extension events <em>24h · first line of each signal</em>
                      </div>
                      {/* A signal's name can be a page of process dumps (the
                          zombie-accumulation event ships its samples inline).
                          The row keeps the first line — the finding — and the
                          detail stays in the platform that raised it. */}
                      <Table cols={["Provider", "Signal", "Events"]}
                        rows={exts.slice(0, 6).map((x) => {
                          const one = String(x.name).split(/[.;](\s|$)/)[0];
                          return [x.provider,
                            one.length > 110 ? one.slice(0, 110) + "…" : one,
                            fmtN(x.events)];
                        })} />
                    </>)}
                  </div>
                );
              })()}

              {/* WHY THERE IS NO "OPEN THE DATABASE" here — said, not implied.
                  The Databases app's vendor list was READ OFF ITS OWN FILTER
                  BAR (observed 2026-08-25): PostgreSQL, MSSQL, HanaDB, MySQL,
                  Oracle — plus a SAP instance in its inventory. A store on
                  any other engine has no page there, and an absent button
                  with no reason reads as our defect, not their coverage. */}
              {selStore && !dbEntity && (() => {
                const sys = (stores ?? []).find((st) => st.store === selStore)?.sys ?? "";
                const covered = /postgres|mssql|sqlserver|hana|mysql|oracle|sap/i.test(sys);
                return !covered && sys ? (
                  <p className="dd__note">
                    No Databases-app door for this store: that app covers
                    PostgreSQL, MSSQL, HanaDB, MySQL, Oracle and SAP —
                    {" "}{sys} is not among them. Its truth lives in the
                    traces route below.
                  </p>
                ) : null;
              })()}
              {/* the persona walks, folded: three sections of circles were
                  the wall AFTER the wall — useful, never the first gesture */}
              {elRoutes && elRoutes.list.length > 0 && (
                <button onClick={() => setRoutesOpen((o) => !o)}
                  style={{ display: "block", width: "100%", textAlign: "left",
                    background: "none", border: "1px dashed var(--border-2)",
                    borderRadius: 8, cursor: "pointer", marginTop: 18,
                    padding: "8px 11px", fontSize: 10, letterSpacing: ".1em",
                    textTransform: "uppercase", color: "var(--ink-2)",
                    fontFamily: "var(--mono)" }}>
                  {routesOpen ? "▾" : "▸"} all investigation routes — technical · tactical · executive
                </button>
              )}
              {routesOpen && elRoutes && <Routes list={elRoutes.list} mode={elRoutes.mode} />}
            </>
          )}
        </div>
        </aside>
      </div>
      )}
    </div>
  );
}

const P_HUE: Record<Persona, string> = {
  technical: "var(--t-cyan)", tactical: "var(--t-violet)", executive: "var(--t-pink)",
};
const P_LABEL: Record<Persona, string> = {
  technical: "technical", tactical: "tactical", executive: "executive",
};

/**
 * Three ordered ways out of this app, one per audience. Each step is a platform
 * intent, so Dynatrace routes it to whichever installed app handles the payload
 * — following a route in order lands on a conclusion instead of a data dump.
 */
/** One colour and one glyph per destination app, as an entity type would have. */
const APP_STYLE: Array<[RegExp, string, string]> = [
  [/^Assist/,          "var(--t-magenta)", "✦"],
  [/Problems/,         "var(--bad)",       "!"],
  [/Infrastructure|Hosts|Technologies/, "var(--t-orange)", "▤"],
  [/Services/,         "var(--t-cyan)",    "⬡"],
  [/Sessions|Frontend|Mobile/, "var(--t-indigo)", "▣"],
  [/Kubernetes/,       "var(--t-pink)",    "⬢"],
  [/Logs/,             "var(--t-teal)",    "≡"],
  [/Tracing|Traces/,   "var(--t-azure)",   "⤳"],
];
const styleOf = (app: string) => {
  const hit = APP_STYLE.find(([re]) => re.test(app));
  return hit ? { hue: hit[1], icon: hit[2] } : { hue: "var(--t-violet)", icon: "◆" };
};

/**
 * The routes drawn the way Davis draws a resolution path: circular app nodes
 * joined by arrows, read left to right. A node is an app that already holds
 * the data — opening it lands on the analysis, not on a blank query.
 */
function Routes({ list, mode = "incident" }: {
  list: Route[];
  /** "optimize" when nothing is wrong — the section announces opportunity,
   *  not investigation, because the routes inside changed their question. */
  mode?: "incident" | "optimize";
}) {
  if (!list.length) return null;
  return (
    <div style={{ marginTop: 22, paddingTop: 16, borderTop: "1px solid var(--border-2)" }}>
      <div className="dd__h">
        {mode === "optimize" ? "Improvement routes" : "Investigation routes"}{" "}
        <em>{mode === "optimize" ? "nothing is failing — invest where it pays"
          : intentsAvailable() ? "each node opens that app, already filtered"
                               : "resolve inside Dynatrace"}</em>
      </div>

      {list.map((r) => (
        <div className="path" key={r.persona} style={{ ["--hue" as string]: P_HUE[r.persona] }}>
          <div className="path__hd">
            <span className="path__p">{P_LABEL[r.persona]}</span>
            <span className="path__t">{r.title}</span>
            <span className="path__g">{r.goal}</span>
          </div>

          {/* No origin node. It was the selected element's name repeated as
              the first circle of all three routes — the drawer's own title
              says it once, three feet above. Dropping it also buys back a
              node's width, which is what pushed the last step off the edge. */}
          <div className="path__row path__row--noorigin">
            {r.steps.map((s, k) => {
              const st = styleOf(s.app);
              return (
                <a className="path__step" key={k} href={s.href}
                  // A step with no action named still opens, and still carries
                  // its data — the platform just asks which view to show it in.
                  title={`${s.app} — ${s.proves}` + (s.intentId ? ""
                    : "\n\nAsks which view to open: this environment's app has not "
                      + "published one. The filter travels either way.")}
                  style={{ ["--app" as string]: st.hue }}
                  // Every step leaves in a NEW TAB (the anchor's own default);
                  // only Assist and the rare url-less step go through the bus —
                  // Assist because it is a panel over this screen, not a departure.
                  {...(s.app !== "Assist" && s.href && s.href !== "#"
                    ? { target: "_blank", rel: "noreferrer" } : {})}
                  onClick={s.app === "Assist" || !s.href || s.href === "#"
                    ? (e) => { e.preventDefault(); open(s); }
                    : undefined}>
                  <i className="path__node" aria-hidden="true">{st.icon}</i>
                  <em className="path__app">{s.app}</em>
                  {/CLASSIC/i.test(s.app) && <em className="path__gen">gen2</em>}
                  {/* Assist nodes said "ASSIST / Ask Assist / why it is failing"
                      — the app name twice, then the only line that differed.
                      The question IS the label for them; the three routes ask
                      three different ones and now that is what shows. */}
                  <em className="path__lbl">{s.app === "Assist" ? s.meta : s.label}</em>
                  {s.app !== "Assist" && <em className="path__meta">{s.meta}</em>}
                </a>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Only what the data actually supports — an empty list says so plainly. */

function Kpi({ l, v, t }: { l: string; v: string; t: Tone }) {
  return (
    <div className="dd__k" style={{ borderBottomColor: TVAR[t] }}>
      <div className="dd__kl">{l}</div><div className="dd__kv">{v}</div>
    </div>
  );
}
function Table({ cols, rows }: { cols: string[]; rows: string[][] }) {
  if (!rows.length) return <p className="dim" style={{ fontSize: 12, margin: 0 }}>No data in the period.</p>;
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="dt">
        <thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}
