// Which action each app should perform when a step opens it.
//
// Naming an app AND its action skips the "Open with…" chooser. Naming a wrong
// pair does not: the shell answers "Couldn't find app or intent" and falls back
// to the dialog. So every entry here has to be real.
//
// HOW THESE WERE OBTAINED. They are not documented — the platform publishes
// only four pairs, none of them for these apps, and no registry endpoint
// exposes intent declarations. They were read off the chooser itself: each
// option it renders is an anchor carrying
//
//     data-dt-properties="appId:…,intentId:…"
//     href="/ui/intent/<appId>/<intentId>/#<payload>"
//
// so sending a payload with no recommendation and scraping the dialog lists
// every app that accepts it, with its action id. Each pair below was captured
// that way against this tenant, and `dynatrace.infraops/view_host` was then
// confirmed end to end — it navigated straight to the host, no dialog.
//
// Two of them could never have been guessed: the Logs app uses snake_case
// (`view_query`) while its neighbours use kebab-case, and the Services app's
// generic action is literally `view-entity-dt.entity.service`.
import type { Capability } from "../hooks/useApps";

export interface IntentRef {
  intentId: string;
  /** "verified" — captured from this environment's own chooser. */
  source: "verified";
  /** Set when the platform marks the action deprecated; we never target those. */
  deprecated?: true;
}

const INTENTS: Partial<Record<Capability, Record<string, IntentRef>>> = {
  // The Services app has no plain "open this service" action any more — the
  // generic one is deprecated, and deprecated actions may be ignored outright.
  // What it does offer are the two analyses a route actually wants.
  services: {
    "dynatrace.services": { intentId: "view-service-failure-analysis", source: "verified" },
    "dynatrace.classic.services": { intentId: "view-service", source: "verified" },
  },
  hosts: {
    "dynatrace.infraops": { intentId: "view_host", source: "verified" },
    "dynatrace.classic.hosts": { intentId: "view-host", source: "verified" },
  },
  logs: {
    // snake_case here, kebab-case in every neighbouring app. Not guessable.
    "dynatrace.logs": { intentId: "view_query", source: "verified" },
    "dynatrace.classic.logs.events": { intentId: "view-logs", source: "verified" },
  },
  traces: {
    // Reachable by trace id only: no tracing app accepts a DQL query over
    // spans, which is why a `fetch spans` hand-off offered nothing but
    // notebooks and dashboards.
    "dynatrace.distributedtracing": { intentId: "view-trace", source: "verified" },
  },
  kubernetes: {
    // The Gen3 app's actions follow a generated pattern, view-entity-<key> —
    // invisible in the chooser for pods, but real: verified navigating to
    // /smartscape/workload/K8S_POD with the pod's details open. It even accepts
    // the classic CLOUD_APPLICATION_INSTANCE- id and translates it itself.
    "dynatrace.kubernetes": {
      intentId: "view-entity-dt.entity.cloud_application_instance", source: "verified",
    },
    "dynatrace.classic.kubernetes": {
      intentId: "view-cloud-application-instance", source: "verified",
    },
  },
  // Captured from the chooser a dt.entity.application payload opens, and the
  // Gen3 pair verified navigating: Experience Vitals translated the entity to
  // its own FRONTEND- id and landed on the overview, timeframe applied. Its
  // `frontend` property accepts MOBILE_APPLICATION- and CUSTOM_APPLICATION-
  // ids under the same keys, so the pair serves the mobile capability too.
  rum: {
    "dynatrace.experience.vitals": { intentId: "view-frontend", source: "verified" },
    "dynatrace.classic.web": { intentId: "view-application", source: "verified" },
  },
  mobile: {
    "dynatrace.experience.vitals": { intentId: "view-frontend", source: "verified" },
  },
  problems: {
    // "View problem details in the problems app." The platform's published
    // pair is real after all — an earlier note here claimed the Gen3 app
    // declared nothing, which was wrong: the payload was missing `event.kind`,
    // so NO app matched and the absence looked like the app's fault.
    "dynatrace.davis.problems": { intentId: "view-problem", source: "verified" },
    "dynatrace.classic.problems": { intentId: "view-problem", source: "verified" },
  },
};

/** The action a given app should perform for a capability, if one is known. */
export function intentFor(cap: Capability, appId: string): IntentRef | undefined {
  const hit = INTENTS[cap]?.[appId];
  return hit && !hit.deprecated ? hit : undefined;
}


/** A second action on the same app, used where a route wants a different lens. */
export const SERVICE_RESPONSE_TIME: IntentRef = {
  intentId: "view-service-response-time-analysis", source: "verified",
};

/**
 * The Distributed Tracing EXPLORER — every request, not one trace. Not in the
 * chooser for any entity payload; found in the app's manifest
 * (registry `?add-fields=manifest`) and verified navigating: `dt.filter` is
 * required and must use the explorer's own grammar — single `=`, UNQUOTED
 * value (`dt.smartscape.service = SERVICE-…`). The DQL form (`==`, quotes) is
 * accepted by the URL and silently ignored, which opens the app UNFILTERED and
 * reads as working. For services the Smartscape id equals the classic id, so
 * the node's SERVICE- id can be interpolated as is.
 */
export const TRACES_LIST: IntentRef = { intentId: "view-traces", source: "verified" };

/**
 * One user's session, opened in the app dedicated to it — both generations.
 *
 * Found the same way as TRACES_LIST (registry manifests), and both verified
 * navigating with a real session: the Gen3 pair opened the session's event
 * timeline, the classic pair opened Session Details with the payload
 * translated into the app's own composite session id.
 *
 * The payloads are exact and minimal — precisely the properties each intent
 * declares, nothing more:
 *   Gen3    → { dt.rum.session.id, start_time }
 *   classic → { dt.rum.session.id, dt.rum.instance.id, start_time }
 * `start_time` is the ISO string DQL returns for min(start_time), and the
 * classic pair is unusable without `dt.rum.instance.id`, so a route only
 * offers it when the exemplar row carried one.
 */
/**
 * The Users & Sessions app's LIST view — "analyze user sessions" as a page,
 * not one session. From the app's manifest: intent `view-entity-list`,
 * `explorer.type` required and its schema pattern admits exactly one value,
 * "sessions". `explorer.properties.filters` is an optional filter-bar string;
 * if the environment ignores it the list opens unfiltered — a safe
 * degradation, never an empty screen. End-to-end navigation check pending:
 * the tenant shell would not render in a browser the day this was wired.
 */
export const SESSIONS_LIST = {
  appId: "dynatrace.users.sessions",
  intentId: "view-entity-list", source: "verified",
} as const;

/**
 * Error Inspector — the platform's own app for "what are these errors?".
 *
 * Found in the registry (`?add-fields=manifest`), which declares three
 * intents: `inspect-error` (needs one error.id), `inspect-errors-of-session`
 * (needs a session id) and this one, the only one that answers the question an
 * application page asks — every error of one frontend.
 *
 * `frontend` is REQUIRED and its schema pattern is
 * `^((MOBILE_|CUSTOM_)?APPLICATION|FRONTEND)-[0-9A-F]{16}$`, so the inventory's
 * entity id goes in as is and mobile applications are covered by the same
 * pair. `dt.timeframe` is the ordinary `{from, to}` object — the window the
 * page is reading travels with the hand-off, so the app opens on the same
 * numbers. `error.type` is optional and free-form; the two this tenant emits
 * are "exception" and "request", and omitting it opens all of them.
 */
/* NOT used for the drill-downs any more, and the reason is worth keeping:
 * this intent carries typed properties and no filter string, so handing off
 * to it — even with `target: "explorer"` — opens the Explorer with an empty
 * filter bar. Every Error Inspector drill-down now goes by the app's own url
 * (see errorsExplorerHref). Left here as the record of what the registry
 * declares, so the next reader does not rediscover it the hard way. */
export const ERRORS_INSPECTOR = {
  appId: "dynatrace.error.inspector",
  intentId: "inspect-errors-of-frontend", source: "verified",
} as const;

export const SESSION_GEN3 = {
  appId: "dynatrace.users.sessions",
  intentId: "session-details-from-event", source: "verified",
} as const;
export const SESSION_CLASSIC = {
  appId: "dynatrace.classic.session.segmentation",
  intentId: "view-user-session", source: "verified",
} as const;

/**
 * Nodes and pods are both "kubernetes", but not to the platform: a pod is a
 * cloud application instance and a node is a node, with different payload keys
 * and different actions. The capability default covers pods; this map is what
 * a node needs, keyed by app because the two apps name the action differently.
 * Both pairs verified navigating.
 */
export const K8S_NODE_BY_APP: Record<string, IntentRef> = {
  "dynatrace.kubernetes": { intentId: "view-entity-dt.entity.kubernetes_node", source: "verified" },
  "dynatrace.classic.kubernetes": { intentId: "view-kubernetes-node", source: "verified" },
};
