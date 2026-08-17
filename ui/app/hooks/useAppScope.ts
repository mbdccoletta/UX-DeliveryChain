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
import { useEffect, useState } from "react";
import { qAppSeedGen2, qAppServices, qAppServicesTopo, qAppServicesTopoMobile,
  qServiceRuntime, runDql } from "../utils/dql";

export interface AppScope {
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
   * painted every service in the tenant under the new application before the
   * real scope arrived. A flash of the wrong answer is worse than a pause.
   */
  loading: boolean;
}

const EMPTY: AppScope = { services: new Set(), traces: new Map(), names: new Map(),
  runtime: new Set(), placements: [], resolved: false, loading: false };
const memo = new Map<string, AppScope>();

export function useAppScope(rumAppId?: string, appEntity?: string): AppScope {
  const [scope, setScope] = useState<AppScope>(
    rumAppId ? memo.get(rumAppId) ?? EMPTY : EMPTY,
  );

  useEffect(() => {
    if (!rumAppId) { setScope(EMPTY); return; }
    const memoKey = `${rumAppId}|${appEntity ?? ""}`;
    const hit = memo.get(memoKey);
    if (hit) { setScope(hit); return; }

    let live = true;
    setScope({ ...EMPTY, loading: true });
    (async () => {
      let out: AppScope = { services: new Set(), traces: new Map(), names: new Map(),
        runtime: new Set(), placements: [], resolved: false, loading: false };
      try {
        // UNION of the two discovery engines, so nothing measured OR declared
        // is lost: traces catch what topology has not declared; topology
        // catches what a 300-trace sample missed and everything classic RUM
        // (PurePath ids, absent from Grail spans) cannot join at all.
        const rows = await runDql<{ svc: string; traces: number; name?: string }>(
          qAppServices(rumAppId), 60);
        const topoRows = await (async () => {
          try {
            if (/^[0-9a-f]{16}$/.test(rumAppId))
              return await runDql<{ svc: string; traces: number; name?: string }>(
                qAppServicesTopo(rumAppId), 60);
            if (appEntity?.startsWith("MOBILE_APPLICATION-"))
              return await runDql<{ svc: string; traces: number; name?: string }>(
                qAppServicesTopoMobile(appEntity), 60);
          } catch { /* topology view unavailable — traces alone still stand */ }
          return [];
        })();
        for (const t of topoRows) {
          if (!rows.some((r) => r.svc === t.svc)) rows.push(t);
        }
        /* THIRD source, asked only when the first two came back empty.
         *
         * Traces need the application to send RUM into Grail and Smartscape
         * needs it to have a Gen3 node; an application with neither is not
         * an application without a backend, it is one whose backend only the
         * classic model still describes. Measured: `easyTravel Mobile
         * (mainframe)` has no events in seven days and no Smartscape edge,
         * and `dt.entity.mobile_application.calls` names its webserver in one
         * hop — from which the chain walks the rest.
         *
         * Last, never first: where the other two answer, they answer with
         * measured volumes, and this one has none to give. */
        if (!rows.length && appEntity) {
          try {
            const seed = await runDql<{ svc: string; name?: string }>(
              qAppSeedGen2(appEntity), 40);
            for (const r of seed) {
              if (r.svc) rows.push({ svc: r.svc, traces: 0, name: r.name });
            }
          } catch { /* the classic model is unavailable too — the scope is empty */ }
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
          resolved: true, loading: false };
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
            // this tenant, that is everywhere: 2,412 runs_on edges point at a
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
  }, [rumAppId, appEntity]);

  return scope;
}
