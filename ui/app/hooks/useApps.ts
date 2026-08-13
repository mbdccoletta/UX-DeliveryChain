// Which analysis app owns each capability in THIS environment.
//
// A route has to name the app the user will actually land in, and that is not
// the same everywhere: an environment on the new platform has the Gen3 apps,
// an older one only has the classic (Gen2) ones, and many have both. So the
// app registry is read at runtime and Gen3 wins whenever it is present —
// classic is the fallback, never the default. Where the Gen3 app has no action
// for a payload, the step falls back to the chooser rather than being routed
// to a classic app behind the user's back.
import { useEffect, useState } from "react";

export type Capability =
  | "services" | "hosts" | "processes" | "kubernetes"
  | "logs" | "traces" | "problems" | "rum" | "mobile";

export interface AppTarget {
  appId: string;
  name: string;
  /** True when this is a classic app, shown only because no Gen3 one exists. */
  classic: boolean;
}

/**
 * Gen3 first, classic second. Both ids are checked against the registry, so a
 * capability with neither installed simply drops out of the route instead of
 * pointing at an app that is not there.
 */
const CANDIDATES: Record<Capability, Array<[string, string, boolean]>> = {
  services:   [["dynatrace.services", "Services", false],
               ["dynatrace.classic.services", "Services Classic", true]],
  hosts:      [["dynatrace.infraops", "Infrastructure", false],
               ["dynatrace.classic.hosts", "Hosts Classic", true]],
  processes:  [["dynatrace.infraops", "Infrastructure", false],
               ["dynatrace.classic.technologies", "Technologies Classic", true]],
  kubernetes: [["dynatrace.kubernetes", "Kubernetes", false],
               ["dynatrace.classic.kubernetes", "Kubernetes Classic", true]],
  logs:       [["dynatrace.logs", "Logs", false],
               ["dynatrace.classic.logs.events", "Logs Classic", true]],
  traces:     [["dynatrace.distributedtracing", "Distributed Tracing", false],
               ["dynatrace.classic.distributed.traces", "Traces Classic", true]],
  problems:   [["dynatrace.davis.problems", "Problems", false],
               ["dynatrace.classic.problems", "Problems Classic", true]],
  // Experience Vitals, not Users & Sessions: the sessions app declares no
  // action for an application entity, so naming it here sent every "open the
  // application" step to the chooser. Experience Vitals declares view-frontend
  // and its `frontend` property accepts APPLICATION-, MOBILE_APPLICATION- and
  // CUSTOM_APPLICATION- ids alike — one owner for both RUM capabilities.
  rum:        [["dynatrace.experience.vitals", "Experience Vitals", false],
               ["dynatrace.classic.web", "Web Classic", true]],
  mobile:     [["dynatrace.experience.vitals", "Experience Vitals", false],
               ["dynatrace.classic.mobile", "Mobile Classic", true]],
};

export type AppMap = Partial<Record<Capability, AppTarget>>;

/**
 * Resolves each capability against the ids actually installed.
 *
 * Strictly Gen3 first: a classic app is used only where no Gen3 app for that
 * capability exists in this environment. An earlier version preferred whichever
 * app could perform the action, which quietly sent Kubernetes to the classic app
 * even though the Gen3 one was installed — the right outcome for that one step,
 * the wrong rule for the product.
 */
export function resolve(installed: Set<string>): AppMap {
  const out: AppMap = {};
  for (const [cap, options] of Object.entries(CANDIDATES) as Array<[Capability, Array<[string, string, boolean]>]>) {
    const hit = options.find(([id]) => installed.has(id));
    if (hit) out[cap] = { appId: hit[0], name: hit[1], classic: hit[2] };
  }
  return out;
}

/**
 * Reads the installed apps once per session. On failure the map stays empty,
 * which makes every route fall back to letting the platform choose — degraded,
 * but never pointing somewhere that does not exist.
 */
export function useApps(): AppMap {
  const [map, setMap] = useState<AppMap>({});

  useEffect(() => {
    let cancelled = false;
    fetch("/platform/app-engine/registry/v1/apps?page-size=300",
      { headers: { accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: { apps?: Array<{ id: string }> }) => {
        if (cancelled) return;
        setMap(resolve(new Set((j.apps ?? []).map((a) => a.id))));
      })
      .catch(() => { /* leave empty: routes degrade to platform choice */ });
    return () => { cancelled = true; };
  }, []);

  return map;
}
