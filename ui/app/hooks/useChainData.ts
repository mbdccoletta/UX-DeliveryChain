// Loads everything the app needs, in parallel.
// Each query fails in isolation: a missing scope never takes the screen down.
import { useCallback, useEffect, useRef, useState } from "react";
import * as Q from "../utils/dql";
import { bumpMemoGen } from "../utils/memo";
import { noteCachedTruncation } from "../utils/cost";
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
  /** True while the screen is drawn from PREVIEW rows — see runDql. */
  partial?: boolean;
  /** Every application the inventory knows — the picker's list, free to read. */
  inventory: Array<{ appId: string; name: string; kind?: string; entity?: string }>;
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

/** Runs a query tolerating failure (returns [] and records the error).
 *
 *  `cut` collects the truncation of THESE queries. The page-wide counter in
 *  cost.ts is right for the banner and wrong for the cache: it is sticky, it
 *  includes every unrelated drill-down, and a payload stamped from it
 *  inherits somebody else's partial scan — and then re-raises it forever on
 *  every restore. */
async function safe<T>(
  label: string, q: string, bag: string[], limit = 200, cut?: { hit: boolean },
  /** Partial rows, while the query is still running — see runDql. */
  onPartial?: (rows: T[]) => void,
  /** Let it settle on a stable preview — Overview summaries only. */
  settle = false,
): Promise<T[]> {
  try {
    return await runDql<T>(q, limit, cut ? () => { cut.hit = true; } : undefined,
      onPartial, { settle });
  } catch (e: unknown) {
    bag.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

/**
 * `appId` scopes the two per-application RUM scans (origins, domains) to the
 * application on screen. Every consumer of those rows filters by it anyway,
 * so the estate-wide form was scanning and paying for rows it then dropped —
 * which is what pushed a production tenant's landing page past Grail's scan
 * limit. Null until an application is chosen, and the scans stay estate-wide
 * then, which is correct: the picker has to see the estate to offer it.
 */
export function useChainData(
  tf: Timeframe, session?: string | null, appId?: string | null,
): ChainData {
  const [state, setState] = useState<Omit<ChainData, "refresh">>({
    loading: true, errors: [], tf, cachedAt: null, apps: [], inventory: [],
    views: [], sequences: [],
    transitions: [], friction: [], devices: [], origins: [],
    domains: [], paths: [], calls: [], runtime: [], topology: [],
    problems: [], providers: [], alerts: [], signals: [],
  });
  const [tick, setTick] = useState(0);
  /** Set while a refresh is in flight, so it skips the cache. */
  const skipCache = useRef(false);
  const refresh = useCallback(() => {
    skipCache.current = true;
    /* AND EVERY OTHER CACHE ON THE PAGE. This reloaded the shared estate and
       nothing else: twenty-six hooks keep their own module-level memo keyed
       by the question, so after a refresh the header said "live" over a page
       that was part fresh and part cached, with nothing to tell them apart.
       Clearing those Maps would not help — a hook only re-fetches when its
       KEY changes — so the generation is part of every key, and bumping it
       sends the whole page back to Grail together. */
    bumpMemoGen();
    setTick((t) => t + 1);
  }, []);

  useEffect(() => {
    // the cache is keyed by window AND session: a one-session view must never
    // read back the whole environment's numbers
    /* The scope is part of the key. Without it a cached estate-wide payload
       would answer a scoped request — and, worse, a payload scoped to one
       application would answer for the next one, which looks like data and
       is another application's. */
    const cacheKey = `${tf.from}|${tf.to}` + (session ? `:s:${session}` : "")
      + (appId ? `:a:${appId}` : "");
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, errors: [] }));
    const bag: string[] = [];

    (async () => {
      const bypass = skipCache.current;
      skipCache.current = false;

      // A hit skips all 16 queries. The age travels with it so the screen can
      // say how old the numbers are rather than passing them off as live.
      if (!bypass) {
        const hit = await cache.read<Omit<ChainData, "refresh" | "cachedAt">
          & { truncated?: boolean }>(cacheKey);
        if (hit && !cancelled) {
          /* COMPLETENESS TRAVELS WITH THE PAYLOAD. The partial-data banner
             reads a counter in cost.ts, which only knows about queries this
             page has just run. Restore a cached window and the counter is
             clean, so figures that came back from a truncated scan lose the
             warning that was their whole point. The flag is stored with the
             result and re-raised when it comes back. */
          if (hit.value.truncated) noteCachedTruncation();
          setState({ ...hit.value, loading: false, cachedAt: hit.at });
          return;
        }
      }

      /* collects the truncation of THIS load's own queries — see safe() */
      const cut = { hit: false };
      /* THE COLD LOAD IS A DISCOVERY LOAD.
       *
       * With no application chosen there is nothing to scope to, so the
       * census reads the estate — and on a production tenant that one scan
       * reached Grail's 500 GB limit and took the page with it. But the cold
       * load does not need measurements: it needs to know WHICH application
       * to measure. Ranking is a far cheaper question than reporting, so it
       * is asked of a short window — the window is linear in bytes, and
       * fifteen minutes ranks an estate as well as two hours does.
       *
       * The per-application scans sit out this pass entirely: they would read
       * the estate for an application nobody has chosen yet. The moment the
       * choice lands in the url (App.tsx writes it), this hook runs again
       * with a scope and everything is measured properly, once.
       *
       * The page stays in its loading state through the discovery pass, so
       * nothing is ever drawn from the short window and labelled with the
       * long one. */
      const discovery = !appId;
      /** The two slow legs, in flight from the start and awaited at the end. */
      const slow = discovery
        ? Promise.resolve([[], []] as [Record<string, unknown>[], Record<string, unknown>[]])
        : Promise.all([
            safe<Record<string, unknown>>("origins",
              Q.qOrigins(tf, session, appId), bag, 200, cut),
            safe<Record<string, unknown>>("domains", Q.qDomains(tf, appId), bag, 200, cut),
          ]);
      const censusTf: Timeframe = discovery
        ? { ...tf, from: `now()-${Math.max(15, Math.min(tf.minutes, 30))}m`, to: "now()" }
        : tf;
      const none = Promise.resolve([] as Record<string, unknown>[]);

      /* THE CENSUS UNBLOCKS THE PAGE ON ITS PREVIEW.
       *
       * Measured on production with previews enabled: this query answers with
       * real rows in about three seconds and keeps polling for its final
       * figure until t+88s. The page waited for the second one — so the
       * reader stared at a spinner for a minute and a half while the app had
       * the application, its name and its numbers in hand the whole time.
       *
       * Whichever arrives first settles the barrier; the final lands after as
       * a patch, exactly like origins and domains. `partial` travels with the
       * state so the screen can say the figures are still firming rather than
       * presenting a preview as a measurement. */
      let settleEarly: (rows: Record<string, unknown>[]) => void = () => {};
      const censusEarly = new Promise<Record<string, unknown>[]>(
        (r) => { settleEarly = r; });
      const censusFinal = safe<Record<string, unknown>>("applications",
        Q.qApps(censusTf, session, appId), bag, 200, cut,
        (rows) => { if (rows.length) settleEarly(rows); },
        false);
      void censusFinal.then((rows) => settleEarly(rows)).catch(() => settleEarly([]));

      /* ONLY THE CENSUS AND THE NAMES HOLD THE FIRST PAINT.
       *
       * Measured on production: with previews the census answers in about
       * two seconds, and the first landing still waited another five for
       * Davis, the topology counts and the signal rollups to finish polling.
       * None of those draws anything the reader is waiting for — the card
       * needs the application and its name. Everything else patches in.
       *
       * They are all started together, as before; the difference is only
       * which of them the first setState waits for. */
      /* names are free (Smartscape) and the picker cannot be drawn without
         them, so they are the one other thing the first paint waits for */
      const namesP = safe<{ id: string; name: string; rumId?: string; kind?: string }>(
        "names", Q.qAppNames(), bag, 2000, cut);
      const rest = Promise.all([
        discovery ? none
          : safe<Record<string, unknown>>("classic applications", Q.qAppsGen2(), bag, 200, cut),
        /* ORIGINS AND DOMAINS DO NOT HOLD THE PAGE.
           Measured on production: these two are the per-session summarizes
           over the window, they each ran past the 30-second execute timeout
           and polled until t+84s — and the nine queries beside them had
           finished by t+19s and waited. Worse, nothing downstream could
           start either: the card, the map and the detail all wait for this
           loader, and the application they needed was known at t+19s.
           They are started here, with everything else, and awaited AFTER the
           first state lands. The page draws what it has; these two fill in
           when they arrive. */
        none, none,
        /* DISCOVERY ASKS ONE QUESTION: which application. Everything else on
           this list is for a page that will not be drawn until the scoped
           pass lands, and running it here only to run it again a moment
           later is what turned a cheaper first load into a slower one — two
           full round trips where there had been one expensive one.
           Smartscape stays, because it is free and it names the picker. */
        discovery ? Promise.resolve([] as CallRow[])
          : safe<CallRow>("smartscape calls", Q.qServiceCalls(), bag, 200, cut),
        discovery ? Promise.resolve([] as RuntimeRow[])
          : safe<RuntimeRow>("smartscape runtime", Q.qRuntime(), bag, 200, cut),
        discovery ? none
          : safe<Record<string, unknown>>("topology", Q.qTopologyCounts(), bag, 200, cut),
        discovery ? Promise.resolve([] as ProblemRow[])
          // the client cap must not re-cap what the query is allowed to return:
          // see qProblems — problems this application has must never fall off
          // the end of a list sized for a demo
          : safe<ProblemRow>("davis problems", Q.qProblems(tf), bag, 500, cut),
        discovery ? none
          : safe<Record<string, unknown>>("davis rollup", Q.qDavisRollup(tf), bag,
              Q.DAVIS_ROLLUP_CAP, cut),
        discovery ? none
          : safe<Record<string, unknown>>("entity signals", Q.qSignalsByEntity(tf),
              bag, 300, cut),
      ]);

      // the first paint waits for these two only
      const [scopedApps, appNames] = await Promise.all([censusEarly, namesP]);
      if (cancelled) return;
      /* The rest fill in. They start empty so the payload can be built
         immediately, and the same builder runs again when they land — one
         mapping, written once, so the two landings cannot disagree. */
      type Rec = Record<string, unknown>;
      let gen2Apps: Rec[] = [], origins: Rec[] = [], domains: Rec[] = [];
      let calls: CallRow[] = [], runtime: RuntimeRow[] = [], topology: Rec[] = [];
      let problems: ProblemRow[] = [], davis: Rec[] = [], signals: Rec[] = [];

      /* A SCOPE THAT MATCHED NOTHING IS NOT AN EMPTY ESTATE.
         The census is scoped to the application in the url, which is the
         whole saving — but a url can carry an id this window has never seen:
         a share link from another tenant, a stale pick, an id that was never
         a RUM application at all. Scoped, that returns zero rows, and the
         page rendered an estate with no applications in it while the picker
         sat on a placeholder. When the scope finds nothing, the estate
         answers once, the way it did before any of this. */
      const rawApps = scopedApps.length || !appId
        ? scopedApps
        : await safe<Record<string, unknown>>(
            "applications", Q.qApps(tf, session), bag, 200, cut);

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
      /* THE INVENTORY COUNTS AS SEEN. This set was built from the measured
         census alone, which was the whole estate — until the census was
         scoped to one application. From then on `seen` held one app, every
         classic-model entry passed as "classic only" and was appended beside
         the same application the inventory had already listed, under the
         other model's name: "BSPI - PIX-BGS - Web - External" and
         "BSPI | PIX-BGS | Web | External", twice in the picker. The inventory
         carries both ids for every frontend, so it decides what is new. */
      for (const n of appNames) {
        const rum = String(n.rumId ?? "").toLowerCase();
        const cid = String(n.id ?? "").toLowerCase();
        if (rum) seen.add(rum);
        if (cid) { seen.add(cid); seen.add(cid.replace(/^[a-z_]*application-/, "")); }
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

      const build = () => ({
        /* STILL LOADING, ON PURPOSE. A discovery pass has ranked the estate
           over a short window and nothing else; its numbers must never reach
           a screen labelled with the selected window. The page keeps its
           loading state until the scoped pass — which App.tsx triggers the
           moment it writes the resolved choice into the url — comes back. */
        /* ...and only while there is something to pick. A discovery pass that
           found no application has nothing to hand the next pass, so staying
           in loading would be a spinner with no end behind it. */
        loading: discovery && rawApps.length > 0,
        /* These figures came from previews and are still firming up. Real,
           measured, not yet whole — and said so rather than shown as final. */
        partial: true,
        errors: bag,
        tf,
        cachedAt: null,
        /* THE PICKER'S OWN LIST, from Smartscape rather than from the scan.
           Measured in production: five Smartscape queries scanned 0 bytes
           between them, while the estate's RUM census was most of a 1.12 TB
           page. The census answers for the application on screen; the list of
           applications a reader may choose comes from the inventory, which is
           free. An application the inventory knows and RUM has not reported
           on still appears — and the app already has a page for exactly that,
           which is better than hiding it. */
        /* ONLY ENTRIES THAT CARRY A RUM ID.
           The first cut fell back to the entity id when Smartscape had no
           instrumentation id — and every query in this app keys on the RUM
           application id, so picking one of those entries scoped the whole
           page to an id that matches nothing: 33 sessions, zero errors, zero
           requests, an empty picker. A name that cannot be measured is worse
           than a name that is absent, because the screen fills with zeros
           instead of saying it does not know. */
        inventory: appNames
          .map((n) => ({
            appId: String(n.rumId ?? "").trim(),
            name: String(n.name ?? ""),
            kind: n.kind ? String(n.kind) : undefined,
            entity: n.id ? String(n.id) : undefined,
          }))
          .filter((a) => a.appId && a.name),
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
      });
      /* FIRST PAINT. Census and names only — everything else is empty here
         and arrives below. */
      const fresh = build();
      setState(fresh);

      /* THE SECOND LANDING. The page is already on screen; these only add
         the origin split, the contacted domains and the census's final
         figures, so they arrive as a patch rather than as a reason to have
         waited. The cache is written after them, because a cached payload
         must be the whole answer. */
      const [[slowOrigins, slowDomains], finalApps, restParts] =
        await Promise.all([slow, censusFinal.catch(() => scopedApps), rest]);
      if (cancelled) return;
      [gen2Apps, origins, domains, calls, runtime, topology, problems, davis, signals]
        = restParts;
      // the same builder, now over the complete parts
      const whole = build();
      /* mapped exactly as the eager batch maps them — one shape, one place
         it is written, or the two landings would disagree about a row */
      const withSlow = {
        ...whole,
        loading: false,
        partial: false,
        // the census's final figures replace the preview's, row for row
        apps: finalApps.length
          ? whole.apps.map((a) => {
              const f = finalApps.find((r) => String(r.appId ?? "") === a.appId);
              return f ? {
                ...a,
                sessions: num(f.sessions), views: num(f.views),
                errors: num(f.errors), crashes: num(f.crashes), anrs: num(f.anrs),
                p50View: num(f.p50View), p90View: num(f.p90View),
                p95View: num(f.p95View), p50Load: num(f.p50Load),
                p50Xhr: num(f.p50Xhr), resPerAct: num(f.resPerAct),
              } : a;
            })
          : whole.apps,
        origins: slowOrigins.map((r) => ({
          appId: String(r.appId ?? ""),
          agent: r.agent as string | null, utype: r.utype as string | null,
          sessions: num(r.sessions), views: num(r.views),
          profiles: num(r.profiles),
          late: r.late == null ? null : num(r.late),
          hit: r.hitSessions == null ? null : num(r.hitSessions),
        })),
        domains: slowDomains.map((r) => ({
          appId: String(r.appId ?? ""),
          utype: (r.utype as string | null) ?? null,
          agent: (r.agent as string | null) ?? null,
          domain: String(r.domain ?? ""), provider: r.provider as string | null,
          reqs: num(r.reqs), p50: num(r.p50), p90: num(r.p90), err: num(r.err),
          bytes: num(r.bytes),
          late: r.late == null ? null : num(r.late),
        })),
      };
      setState(withSlow);
      // store what was just measured; failure here never reaches the user
      const { loading: _l, cachedAt: _c, ...payload } = withSlow;
      /* the window's LENGTH decides how long this keeps — the cache key is
         its identity, which is a different question (see ttlFor) */
      // a discovery payload is not an answer about this window; caching it
      // would serve short-window numbers under the long window's label
      if (!discovery) void cache.write(cacheKey, { ...payload, truncated: cut.hit }, tf.minutes);
    })();

    return () => { cancelled = true; };
  }, [tf, tick, session, appId]);

  return { ...state, refresh };
}
