// Loads everything the app needs, in parallel.
// Each query fails in isolation: a missing scope never takes the screen down.
import { useCallback, useEffect, useRef, useState } from "react";
import * as Q from "../utils/dql";
import { normalizeView, num, runDql, type Timeframe } from "../utils/dql";
import * as cache from "../utils/cache";

export interface AppRow {
  appId: string;
  name: string;
  /** Classic entity id (APPLICATION-/MOBILE_APPLICATION-), for topology bridges. */
  entity?: string;
  /** The platform's own classification: "web" | "mobile" (Smartscape's
   *  frontend.type). Undefined when the app has no FRONTEND node. */
  kind?: string;
  sessions: number;
  views: number;
  errors: number;
  /**
   * The FATAL subset of `errors`, mobile only — measured on a live estate:
   * crashes are classifier "error" with error.type "crash" (289 events /
   * 288 sessions on Astroshop Android in 24h), and ANRs — the app frozen
   * until Android kills it — are error.type "anr" (247 more). Both are
   * already inside `errors`; these fields surface them because a crash ends
   * the session where an ordinary error merely dents it. Zero for web apps
   * by construction, not by assumption: the types only occur on mobile.
   */
  crashes: number;
  anrs: number;
  p50View: number;
  /** View-duration tail, same units as p50View — the overview reads all three. */
  p90View: number;
  p95View: number;
  /** Load (hard navigation) and XHR action durations — the classic
   *  performance-analysis pair, in ns like every duration here. */
  p50Load: number;
  p50Xhr: number;
  /** Average resources fetched per user action, from the agent's own count. */
  resPerAct: number;
}
export interface ViewRow {
  appId: string;
  view: string;
  views: number;
  sessions: number;
  p50: number;
}
/** `plat` is the RUM agent's own platform word — "javascript" | "ios" |
 *  "android" — null on rows old enough to predate the mine carrying it. */
export interface SeqRow {
  appId: string; journey: string[]; sessions: number; plat: string | null;
}
export interface DeviceRow {
  appId: string;
  res: string; dpr: string | null; orient: string | null;
  agent: string | null; utype: string | null; sessions: number; views: number;
}
/**
 * Sessions per application and per origin.
 *
 * Separate from DeviceRow on purpose: those are a top-20 over the whole
 * environment, which is the right shape for "the busiest device profiles" and
 * the wrong one for "who consumes this application" — measured, the top twenty
 * profile rows covered seven of fourteen applications, and the rest drew "No
 * coverage" while their sessions existed.
 */
export interface OriginRow {
  appId: string;
  agent: string | null; utype: string | null;
  sessions: number; views: number;
  /** Distinct screen sizes this origin arrived on. */
  profiles: number;
  /** Sessions that STARTED in the window's second half — the free trend
   *  split (same scan). null on cached payloads from before the column
   *  existed, and on shifted windows, where a trend would claim to be a
   *  forecast of the past. */
  late: number | null;
  /** Sessions of THIS origin that met an error — measured, not the old
   *  proportional estimate. null on pre-column cached payloads. */
  hit: number | null;
}
export interface DomainRow {
  appId: string;
  domain: string;
  /** Traffic origin: user_type (robot/synthetic/…) and agent, for the split. */
  utype?: string | null; agent?: string | null; provider: string | null; reqs: number;
  p50: number; err: number; bytes: number;
  /** Tail latency — carried because p50 alone measured 0 on 916k requests
   *  (over half report zero duration) and read as nonsense. */
  p90: number;
  /** Requests in the window's second half — see OriginRow.late. */
  late: number | null;
}
export interface PathRow {
  appId: string;
  path: string; method: string | null; status: string | null;
  reqs: number; p50: number; p90: number;
}
export interface CallRow { srcId: string; src: string; dstId: string; dst: string }
export interface RuntimeRow {
  podId: string; pod: string; nodeId: string; node: string;
  /** Classic entity ids — the only form the classic Kubernetes app accepts. */
  podClassic?: string; nodeClassic?: string;
}
export interface ProblemRow {
  /** event.id — the key the Problems app opens a problem with. */
  eventId: string;
  display_id: string; name: string; category: string;
  affected: string[] | null; entityIds: string[] | null; start: string;
}
/** One signal already bound to the entity it affects. */
export interface SignalRow {
  name: string; provider: string; status: string; etype: string;
  entityId: string; events: number;
}
/** One move between two views, with what the user experienced making it. */
export interface TransitionRow {
  appId: string; src: string; dst: string;
  sessions: number; actions: number;
  p50: number; p90: number;
  abandoned: number; timeouts: number; slowInp: number;
}
/** The element the user was on when an action failed. */
export interface FrictionRow {
  appId: string; view: string;
  tag: string | null; xpath: string | null;
  actions: number; abandoned: number; timeouts: number; cls: number;
}
export interface ProviderRow { type: string; provider: string; events: number }
export interface AlertRow { name: string; provider: string; status: string; events: number }

export interface ChainData {
  loading: boolean;
  errors: string[];
  /** The window every figure was measured over — deep links reuse it. */
  tf: Timeframe;
  /** When these numbers were fetched, or null when they came fresh just now. */
  cachedAt: number | null;
  apps: AppRow[];
  views: ViewRow[];
  sequences: SeqRow[];
  transitions: TransitionRow[];
  friction: FrictionRow[];
  devices: DeviceRow[];
  origins: OriginRow[];
  domains: DomainRow[];
  paths: PathRow[];
  calls: CallRow[];
  runtime: RuntimeRow[];
  topology: Array<{ type: string; nodes: number }>;
  problems: ProblemRow[];
  providers: ProviderRow[];
  alerts: AlertRow[];
  signals: SignalRow[];
  refresh: () => void;
}

/**
 * Normalises every view name, then merges the journeys that become identical.
 * DQL can only collapse numeric ids safely, so paths that differ by a product
 * code or a UUID arrive as separate rows and are folded together here.
 */
export function mergeJourneys(rows: Array<Record<string, unknown>>): SeqRow[] {
  const byKey = new Map<string, SeqRow>();
  for (const r of rows) {
    const appId = String(r.appId ?? "");
    const journey = (Array.isArray(r.journey) ? (r.journey as string[]) : [])
      .map(normalizeView)
      // navigation and view_summary describe the same step twice — one opens
      // it, one closes it — so consecutive repeats collapse to the step itself
      .filter((v, i, arr) => i === 0 || v !== arr[i - 1]);
    const plat = r.plat ? String(r.plat) : null;
    const key = appId + "\u0000" + (plat ?? "") + "\u0000" + journey.join("\u0001");
    const hit = byKey.get(key);
    if (hit) hit.sessions += num(r.sessions);
    else byKey.set(key, { appId, journey, sessions: num(r.sessions), plat });
  }
  return [...byKey.values()].sort((a, b) => b.sessions - a.sessions);
}

/** Runs a query tolerating failure (returns [] and records the error). */
async function safe<T>(label: string, q: string, bag: string[], limit = 200): Promise<T[]> {
  try {
    return await runDql<T>(q, limit);
  } catch (e: unknown) {
    bag.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

export function useChainData(tf: Timeframe, session?: string | null): ChainData {
  const [state, setState] = useState<Omit<ChainData, "refresh">>({
    loading: true, errors: [], tf, cachedAt: null, apps: [], views: [], sequences: [],
    transitions: [], friction: [], devices: [], origins: [],
    domains: [], paths: [], calls: [], runtime: [], topology: [],
    problems: [], providers: [], alerts: [], signals: [],
  });
  const [tick, setTick] = useState(0);
  /** Set while a refresh is in flight, so it skips the cache. */
  const skipCache = useRef(false);
  const refresh = useCallback(() => {
    skipCache.current = true;
    setTick((t) => t + 1);
  }, []);

  useEffect(() => {
    // the cache is keyed by window AND session: a one-session view must never
    // read back the whole environment's numbers
    const cacheKey = `${tf.from}|${tf.to}` + (session ? `:s:${session}` : "");
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, errors: [] }));
    const bag: string[] = [];

    (async () => {
      const bypass = skipCache.current;
      skipCache.current = false;

      // A hit skips all 16 queries. The age travels with it so the screen can
      // say how old the numbers are rather than passing them off as live.
      if (!bypass) {
        const hit = await cache.read<Omit<ChainData, "refresh" | "cachedAt">>(cacheKey);
        if (hit && !cancelled) {
          setState({ ...hit.value, loading: false, cachedAt: hit.at });
          return;
        }
      }

      const [
        rawApps, appNames, gen2Apps, origins, domains,
        calls, runtime, topology, problems, davis, signals,
      ] = await Promise.all([
        safe<Record<string, unknown>>("applications", Q.qApps(tf, session), bag),
        safe<{ id: string; name: string; rumId?: string; kind?: string }>(
          "names", Q.qAppNames(), bag),
        safe<Record<string, unknown>>("classic applications", Q.qAppsGen2(), bag),
        safe<Record<string, unknown>>("origins", Q.qOrigins(tf, session), bag),
        safe<Record<string, unknown>>("domains", Q.qDomains(tf), bag),
        safe<CallRow>("smartscape calls", Q.qServiceCalls(), bag),
        safe<RuntimeRow>("smartscape runtime", Q.qRuntime(), bag),
        safe<Record<string, unknown>>("topology", Q.qTopologyCounts(), bag),
        safe<ProblemRow>("davis problems", Q.qProblems(tf), bag),
        safe<Record<string, unknown>>("davis rollup", Q.qDavisRollup(tf), bag,
          Q.DAVIS_ROLLUP_CAP),
        safe<Record<string, unknown>>("entity signals", Q.qSignalsByEntity(tf), bag, 300),
      ]);
      if (cancelled) return;

      /* Names are keyed three ways. A web app's RUM id is the entity id's hex
       * suffix (ea7c… ↔ APPLICATION-EA7C…), while a mobile app's is a UUID
       * that shares only its first half with MOBILE_APPLICATION-… — that
       * used to make mobile a guess. Smartscape's FRONTEND node carries
       * `dt.rum.instrumentation.id`, which IS dt.rum.application.id, so the
       * mobile join is now EXACT; the other two keys stay for the entity
       * hand-offs the chain does elsewhere. */
      const nameOf = new Map<string, string>();
      const kindOf = new Map<string, string>();
      const entityOf = new Map<string, string>();
      for (const a of appNames) {
        const id = String(a.id ?? "");
        if (id) {
          nameOf.set(id.toLowerCase(), a.name);
          // strip any *_APPLICATION- prefix, not just the web one
          nameOf.set(id.replace(/^[A-Z_]*APPLICATION-/, "").toLowerCase(), a.name);
        }
        if (a.rumId) nameOf.set(String(a.rumId).toLowerCase(), a.name);
        // the platform's own web/mobile classification, keyed the same ways
        if (a.kind) {
          for (const k of [id, id.replace(/^[A-Z_]*APPLICATION-/, ""), String(a.rumId ?? "")]) {
            if (k) kindOf.set(k.toLowerCase(), String(a.kind));
          }
        }
        /* THE ENTITY ID, RECOVERED. dt.rum.application.entity is null on
         * a live estate, and the chain needs that id for two things it silently
         * lost without it: kindOf() reads the *_APPLICATION- prefix to know
         * it is looking at an application (without it a RUM app became a
         * generic "element" and its whole investigation route — Error
         * Inspector included — disappeared), and useAppScope feeds it to the
         * topology walk that finds the backend (without it the chain reported
         * "no trace reaches a service" for an app that has one). Smartscape
         * knows the classic id; key it by the RUM id so the events row can
         * find it. */
        if (id && a.rumId) entityOf.set(String(a.rumId).toLowerCase(), id);
      }
      const kindFor = (appId: string, entity: unknown) =>
        (entity ? kindOf.get(String(entity).toLowerCase()) : undefined)
        ?? kindOf.get(appId.toLowerCase());
      const nameFor = (appId: string, entity: unknown) =>
        (entity ? nameOf.get(String(entity).toLowerCase()) : undefined)
        ?? nameOf.get(appId.toLowerCase());

      /* Applications RUM never reported on, from the classic model.
       *
       * The selector is built from user.events, so an application that sends
       * no RUM to Grail could not be picked at all — measured, `easyTravel
       * Mobile (mainframe)` has zero events in seven days while the
       * platform's own service flow draws its entire backend. It is listed
       * here with its RUM figures at zero, which is what they are, and the
       * chain resolves its services from the classic model.
       *
       * Matched on the entity id and on its hex suffix, because a web app's
       * RUM id IS that suffix while a mobile app's is a UUID that only shares
       * its first half — one of the two always matches an app already listed.
       */
      const seen = new Set<string>();
      for (const a of rawApps) {
        const id = String(a.appId ?? "").toLowerCase();
        if (id) seen.add(id);
        if (a.entity) seen.add(String(a.entity).toLowerCase());
      }
      /* The dedupe now has the EXACT rum id to compare (Smartscape's
       * FRONTEND carries it), so the "shares a hex prefix" guess is only the
       * last resort it always should have been. */
      const gen2Only = gen2Apps.filter((g) => {
        const e = String(g.id ?? "");
        const rum = String(g.rumId ?? "").toLowerCase();
        if (rum && seen.has(rum)) return false;
        const hex = e.replace(/^[A-Z_]*APPLICATION-/, "").toLowerCase();
        return e && !seen.has(e.toLowerCase()) && !seen.has(hex)
          && ![...seen].some((s2) => s2.startsWith(hex));
      });

      const fresh = {
        loading: false,
        errors: bag,
        tf,
        cachedAt: null,
        apps: rawApps.map((r) => {
          const appId = String(r.appId ?? "");
          return {
            appId,
            // the events row's own entity, or Smartscape's when RUM omits it
            entity: r.entity ? String(r.entity) : entityOf.get(appId.toLowerCase()),
            name: nameFor(appId, r.entity) ?? `Application ${appId.slice(0, 8)}`,
            kind: kindFor(appId, r.entity),
            sessions: num(r.sessions), views: num(r.views),
            errors: num(r.errors), crashes: num(r.crashes), anrs: num(r.anrs),
            p50View: num(r.p50View),
            p90View: num(r.p90View), p95View: num(r.p95View),
            p50Load: num(r.p50Load), p50Xhr: num(r.p50Xhr),
            resPerAct: num(r.resPerAct),
          };
        }).concat(gen2Only.map((g) => ({
          // the entity id IS the key for these: there is no RUM id to use,
          // and inventing one would be inventing the join that follows it
          appId: String(g.id), entity: String(g.id),
          name: String(g.name ?? g.id),
          // these carry the platform's classification too — they came from
          // the same FRONTEND nodes
          kind: g.kind ? String(g.kind) : undefined,
          sessions: 0, views: 0, errors: 0, crashes: 0, anrs: 0,
          p50View: 0, p90View: 0, p95View: 0,
          p50Load: 0, p50Xhr: 0, resPerAct: 0,
        }))),
        /* views, sequences, transitions and friction moved to useJourneys:
         * four more user.events scans that only Journeys and Business
         * Control read — Overview and the chain stopped paying for them. */
        views: [], sequences: [], transitions: [], friction: [],
        /* devices and paths moved OUT of the eager batch: measured, their
         * two scans cost 10.1 GB of the load's 30.4 GB and feed only the
         * retired "-all" layer drawer. useLayerStats fetches them on the
         * first open of that drawer instead. */
        devices: [],
        origins: origins.map((r) => ({
          appId: String(r.appId ?? ""),
          agent: r.agent as string | null, utype: r.utype as string | null,
          sessions: num(r.sessions), views: num(r.views),
          profiles: num(r.profiles),
          late: r.late == null ? null : num(r.late),
          hit: r.hitSessions == null ? null : num(r.hitSessions),
        })),
        domains: domains.map((r) => ({
          appId: String(r.appId ?? ""),
          utype: (r.utype as string | null) ?? null,
          agent: (r.agent as string | null) ?? null,
          domain: String(r.domain ?? ""), provider: r.provider as string | null,
          reqs: num(r.reqs), p50: num(r.p50), p90: num(r.p90), err: num(r.err),
          bytes: num(r.bytes),
          late: r.late == null ? null : num(r.late),
        })),
        paths: [],
        calls, runtime,
        topology: topology.map((r) => ({ type: String(r.type ?? ""), nodes: num(r.nodes) })),
        problems,
        /* BOTH VIEWS FROM ONE SCAN. qDavisRollup returns the finer grain
         * (type × provider × name × status); the provider view is those rows
         * added up, and the alerts view is those rows filtered. Two reads of
         * the same 24 hours of the same store cost 8.7 GiB each on a customer
         * estate — this is the second one, not taken. */
        providers: (() => {
          const by = new Map<string, ProviderRow>();
          for (const r of davis) {
            const type = String(r.type ?? ""), provider = String(r.provider ?? "");
            const k = `${type}\u0000${provider}`;
            const hit = by.get(k);
            if (hit) hit.events += num(r.events);
            else by.set(k, { type, provider, events: num(r.events) });
          }
          return [...by.values()].sort((a, b) => b.events - a.events);
        })(),
        alerts: davis
          .filter((r) => r.provider === "METRIC_EVENTS"
            || r.provider === "EVENTS_REST_API_INGEST")
          .map((r) => ({
            name: String(r.name ?? ""), provider: String(r.provider ?? ""),
            status: String(r.status ?? ""), events: num(r.events),
          }))
          .sort((a, b) => b.events - a.events),
        /* AND IF THE SCAN WAS CUT, the two sums above are short. Spread last,
         * because in an object literal the later key wins — placed earlier it
         * would have been silently overwritten by the very values it exists to
         * suppress, which is the same class of bug as the numbers it guards. */
        ...(davis.length >= Q.DAVIS_ROLLUP_CAP
          ? (bag.push("davis rollup: hit the row cap — provider and alert counts "
              + "would be short, so they are withheld"), { providers: [], alerts: [] })
          : {}),
        signals: signals.map((r) => ({
          name: String(r.name ?? ""), provider: String(r.provider ?? ""),
          status: String(r.status ?? ""), etype: String(r.etype ?? ""),
          entityId: String(r.entityId ?? ""), events: num(r.events),
        })),
      };
      setState(fresh);
      // store what was just measured; failure here never reaches the user
      const { loading: _l, cachedAt: _c, ...payload } = fresh;
      void cache.write(cacheKey, payload);
    })();

    return () => { cancelled = true; };
  }, [tf, tick, session]);

  return { ...state, refresh };
}
