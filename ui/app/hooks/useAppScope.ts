// Which part of the environment belongs to the selected application.
//
// The delivery chain used to show the same services, pods and hosts whichever
// application was picked, because those layers come from Smartscape and
// Smartscape does not know about RUM applications. Switching application then
// changed one layer out of seven, which reads as a filter that does not work.
//
// Two queries resolve it, and only the first costs anything: RUM events carry
// `trace.id`, spans carry `dt.entity.service`, so the trace is the bridge.
// Everything below the service — pods, hosts, containers, processes — comes
// from Smartscape's `runs_on`, which is free.
//
// Fetched lazily and memoised: most sessions never switch application, and a
// scope that has been resolved once does not change while the user looks at it.
import { useCallback, useEffect, useState } from "react";
import { qAppSeedGen2, qAppServices, qAppTraceIds,
  qAppServicesTopo, qAppServicesTopoMobile,
  qServiceRuntime, runDql } from "../utils/dql";

export interface AppScope {
  /**
   * How many distinct traces this application's RUM actually carried.
   *
   * Zero and "some but none matched a span" are different findings with
   * different actions, and the chain used to print one sentence for both.
   * Measured on a live estate: of twenty applications, nine carried
   * thousands of requests and NOT ONE trace id, while others on the same
   * estate carried tens of thousands — so an empty backend there is a
   * per-application tracing-context gap, not a topology fact.
   */
  tracesSeen: number;
  /**
   * Has the reader asked for the SPAN measurement on this application?
   *
   * Topology is free and answers most of the time; spans cost real money on a
   * large estate (~32 GiB for ten minutes on a live estate carrying 169M spans in
   * two hours) and must never be spent by the act of opening a page.
   */
  measured: boolean;
  /** The span read is running. */
  measuring: boolean;
  /** Ask for it. Costs a scan, so it is a button, not a side effect. */
  measure: () => void;
  /** Service entity ids this application's traces actually reach. */
  services: Set<string>;
  /** Traces observed per service — the volume an edge into it carries. */
  traces: Map<string, number>;
  /** Service display names, from Smartscape — call edges cannot name leaves. */
  names: Map<string, string>;
  /** Pods, hosts, containers and processes those services run on. */
  runtime: Set<string>;
  /**
   * Which service runs on which target, for component-to-component edges.
   *
   * `type` is whatever Smartscape says — K8S_POD, HOST, CONTAINER, PROCESS,
   * K8S_NODE. Nothing here assumes Kubernetes: an application whose services
   * run straight on hosts has a full chain too, and reading only pods was what
   * left this layer blank and the machinery below it unattached.
   */
  placements: Array<{ svc: string; id: string; type: string; name: string; classic?: string }>;
  /** True when membership came from classic topology, not from traces —
   *  volumes are unknown then, and the UI says "linked" instead of counting. */
  topo?: boolean;
  /** False while loading, or when the application has no traced backend. */
  resolved: boolean;
  /**
   * True while the answer is still being fetched.
   *
   * Loading and "we could not tell" are different facts and used to share one
   * flag: switching application reset the scope to unresolved, and the chain's
   * honest fallback for unresolved — show the whole environment — briefly
   * painted every service in a live estate under the new application before the
   * real scope arrived. A flash of the wrong answer is worse than a pause.
   */
  loading: boolean;
}

const EMPTY: AppScope = { services: new Set(), traces: new Map(), names: new Map(),
  runtime: new Set(), placements: [], resolved: false, loading: false,
  tracesSeen: 0, measured: false, measuring: false, measure: () => {} };
const memo = new Map<string, AppScope>();

export function useAppScope(rumAppId?: string, appEntity?: string): AppScope {
  const [scope, setScope] = useState<AppScope>(
    rumAppId ? memo.get(rumAppId) ?? EMPTY : EMPTY,
  );
  /* Which applications the reader has paid the span scan for, this session.
   * Keyed rather than boolean so switching application does not inherit
   * someone else's decision to spend. */
  const [paid, setPaid] = useState<Set<string>>(() => new Set());
  const wantSpans = !!rumAppId && paid.has(rumAppId);

  useEffect(() => {
    if (!rumAppId) { setScope(EMPTY); return; }
    const memoKey = `${rumAppId}|${appEntity ?? ""}|${wantSpans ? "spans" : "free"}`;
    const hit = memo.get(memoKey);
    if (hit) { setScope(hit); return; }

    let live = true;
    setScope({ ...EMPTY, loading: true });
    (async () => {
      let out: AppScope = { services: new Set(), traces: new Map(), names: new Map(),
        runtime: new Set(), placements: [], resolved: false, loading: false,
        tracesSeen: 0, measured: false, measuring: false, measure: () => {} };
      try {
        /* ORDER IS A PRICE LIST, and this used to be in the wrong order.
         *
         * Three engines answer "which services does this application reach",
         * and they do not cost the same. Smartscape topology is metadata: a
         * FRONTEND-to-SERVICE `calls` edge costs nothing to read. The RUM side
         * is small. SPANS are the biggest store in Grail, billed by the window,
         * and on a live estate carrying 169M spans in two hours a single
         * ten-minute span read scans ~32 GiB — about $0.11 EVERY TIME a reader
         * opens an application. A diagnostic that bills per click is not a
         * diagnostic, it is a subscription.
         *
         * So: topology first and always, because it is free. Trace ids next,
         * because they are cheap and they answer the question the chain most
         * often needs — whether this application propagates trace context at
         * all. Spans only when the reader asks for them by name.
         */
        const topoRows = await (async () => {
          try {
            // No id-shape gate: qAppServicesTopo keys on the FRONTEND node's
            // own dt.rum.instrumentation.id, which every RUM application has
            // whatever its id looks like. The old /^[0-9a-f]{16}$/ test skipped
            // every UUID-shaped application for no reason a measurement backs.
            const viaFrontend = await runDql<{ svc: string; traces: number; name?: string }>(
              qAppServicesTopo(rumAppId), 60);
            if (viaFrontend.length) return viaFrontend;
            if (appEntity?.startsWith("MOBILE_APPLICATION-"))
              return await runDql<{ svc: string; traces: number; name?: string }>(
                qAppServicesTopoMobile(appEntity), 60);
          } catch { /* topology view unavailable — the cheaper reads still stand */ }
          return [];
        })();
        const rows: Array<{ svc: string; traces: number; name?: string }> = [...topoRows];

        /* Does this application propagate trace context? Cheap, and worth
         * knowing even when topology already answered: an empty backend has two
         * causes and they call for opposite actions. */
        const idsIn = async (since: string) =>
          (await runDql<Record<string, unknown>>(qAppTraceIds(rumAppId, since), 300))
            .map((r) => String((r as { "trace.id"?: unknown })["trace.id"] ?? ""))
            .filter(Boolean);
        let since = "now()-10m";
        /* THE PROBE FAILS ALONE. This shared the outer try with the whole
           scope construction, so a RUM permission or query failure threw
           away a topology lookup that had already SUCCEEDED — and the chain
           fell back to environment-wide services, as if the application's
           own services were unknown. They were not; only trace-context
           availability was. Those are different facts and they now fail
           separately: an empty traceIds says "this application does not
           propagate trace context, or we could not find out", and the
           topology-derived scope stands either way. */
        let traceIds: string[] = [];
        try {
          traceIds = await idsIn(since);
          if (!traceIds.length) {
            // the escalation stays on the CHEAP side of the wall
            since = "now()-30m";
            traceIds = await idsIn(since);
          }
        } catch { /* no trace probe; the topology above still stands */ }

        /* THE EXPENSIVE READ, and the only one behind a decision. Topology
         * declares what the platform knows; spans measure what actually ran,
         * including links topology never declared. That extra truth is worth
         * paying for sometimes — which is exactly why a person, not a page
         * load, should decide when. */
        if (wantSpans && traceIds.length) {
          try {
            const measured = await runDql<{ svc: string; traces: number; name?: string }>(
              qAppServices(traceIds, since), 60);
            for (const m of measured) {
              const hit = rows.find((r) => r.svc === m.svc);
              // a measured volume always beats a declared zero
              if (hit) hit.traces = Number(m.traces) || 0;
              else rows.push(m);
            }
          } catch { /* the span read failed; declared topology still stands */ }
        }

        const topo = rows.length > 0 && rows.every((r) => !Number(r.traces));
        const services = new Set(rows.map((r) => String(r.svc)).filter(Boolean));
        const traces = new Map(rows.map((r) => [String(r.svc), Number(r.traces) || 0]));
        const names = new Map(rows.filter((r) => r.name)
          .map((r) => [String(r.svc), String(r.name)]));
        // An empty answer IS the answer: a completed query that found no
        // services means this application has no traced backend, and the chain
        // must say so — not display the whole environment as if it belonged to
        // the app. Only a FAILED query leaves the scope unresolved.
        out = { services, traces, names, topo, runtime: new Set(), placements: [],
          resolved: true, loading: false, tracesSeen: traceIds.length,
          measured: wantSpans, measuring: false, measure: () => {} };
        if (services.size) {
          try {
            const rt = await runDql<{ src: string; id: string; type: string;
              name: string; classic?: string }>(
              qServiceRuntime([...services]), 800);
            // both id forms enter the scope set: Davis names k8s entities in
            // classic form, and a set without them can never match its events
            out.runtime = new Set(rt.flatMap((r) => [String(r.id), r.classic ? String(r.classic) : ""])
              .filter(Boolean));
            // The NAME travels with the placement now. The runtime layer used
            // to be drawn from a pod-centric query and named from there, which
            // left it empty wherever services do not run on pods — measured on
            // a live estate, that is everywhere: 2,412 runs_on edges point at a
            // HOST, 997 at a CONTAINER, 154 at a PROCESS, and not one at a
            // K8S_POD. The placements already knew; they just arrived nameless.
            out.placements = rt.map((r) => ({
              svc: String(r.src), id: String(r.id), type: String(r.type),
              name: r.name ? String(r.name) : String(r.id),
              classic: r.classic ? String(r.classic) : undefined,
            }));
          } catch {
            /* Smartscape unavailable — services still narrow, runtime does not */
          }
        }
      } catch {
        /* no scope or the join failed; the chain stays environment-wide */
      }
      memo.set(memoKey, out);
      if (live) setScope(out);
    })();

    return () => { live = false; };
  }, [rumAppId, appEntity, wantSpans]);

  const measure = useCallback(() => {
    if (rumAppId) setPaid((s) => (s.has(rumAppId) ? s : new Set(s).add(rumAppId)));
  }, [rumAppId]);

  return { ...scope, measured: wantSpans, measure,
    measuring: wantSpans && scope.loading };
}
