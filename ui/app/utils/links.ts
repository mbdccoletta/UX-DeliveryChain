// Hand-off to other Dynatrace apps.
//
// A step names the app the user will land in, resolved against the apps this
// environment actually has: the new platform apps when present, the classic
// ones only as a fallback.
//
// What a step must never do is arrive empty. Every hand-off goes through an
// intent carrying its payload, and an app+action pair is named only where that
// pair was captured from this environment's own chooser — see intents.ts for
// how. A pair the shell cannot resolve falls back to the dialog, so a wrong
// guess costs a click; a wrong PAYLOAD costs the answer, which is the failure
// worth guarding against. Two were found that way: a Davis problem is invisible
// to every app until `event.kind` says it is one, and a pod is addressed by its
// classic entity id, not by the Smartscape routing key.
import { getIntentLink, sendIntent } from "@dynatrace-sdk/navigation";
import { getEnvironmentUrl } from "@dynatrace-sdk/app-environment";
import { type Timeframe } from "./dql";
import {
  intentFor, K8S_NODE_BY_APP, SERVICE_RESPONSE_TIME,
  SESSION_CLASSIC, SESSION_GEN3, SESSIONS_LIST, TRACES_LIST, type IntentRef,
} from "./intents";
import type { AppMap, Capability } from "../hooks/useApps";

export interface DeepLink {
  /** What it does, in as few words as carry it. */
  label: string;
  /** What it carries: the id, the source, the count — never a sales pitch. */
  meta: string;
  payload: IntentPayload;
  /**
   * Payload properties the destination app MUST declare it handles. Used only
   * when no app is recommended: it narrows the "Open with" list instead of
   * choosing for the user.
   */
  keyProperties: string[];
  /**
   * The app that should open, and the action it should perform. Naming both
   * skips the "Open with" chooser; naming a pair the shell does not know just
   * brings the chooser back, so this is safe but only useful when true.
   */
  appId?: string;
  intentId?: string;
  /** Name of the app this step opens, shown on the node. */
  app: string;
  /** The evidence this step contributes to the conclusion. */
  proves: string;
  href: string;
  /**
   * True when this destination is expressible ONLY as the app's own url.
   *
   * The intent bus cannot carry a filter string: `inspect-errors-of-frontend`
   * declares typed properties and no filter, so handing it off — even with
   * `target: "explorer"` — opens the Explorer with an empty filter bar. The
   * click has to follow the href instead of being intercepted.
   */
  viaHref?: boolean;
}

/**
 * Dynatrace Assist. Its payload is not a query or an entity — it is a prompt
 * plus hidden context, so it is built separately from the query hand-offs.
 * Contract from the platform's conversation-starters guide: the prompt is
 * always visible to the user, `supplementary` never is, and `execute: false`
 * lets the user read and edit the question before it runs.
 */
export const ASSIST = {
  appId: "dynatrace.davis.copilot", intentId: "ask-question", app: "Assist",
} as const;

/** Prompt and supplementary limits the platform enforces. */
const PROMPT_MAX = 10_000;
const SUPP_MAX = 100_000;

/**
 * An Assist hand-off.
 *
 * The prompt is phrased as a question on purpose: the platform guardrail
 * rejects imperative prompts ("produce…", "give me…"), so every starter here
 * asks rather than commands. The measured numbers travel in `supplementary`,
 * where they inform the answer without cluttering what the user reads.
 */
const aLink = (
  label: string, meta: string, proves: string, prompt: string, supplementary: string,
  instruction = "Answer in short bullet points, lead with the business consequence, " +
    "and say plainly when the data does not support a conclusion.",
): DeepLink => link(label, meta, {
  prompt: prompt.slice(0, PROMPT_MAX),
  // the user reads and can edit the question before it runs
  execute: false,
  contexts: [
    { type: "supplementary", value: supplementary.slice(0, SUPP_MAX) },
    { type: "instruction", value: instruction },
    { type: "document-retrieval", value: "dynatrace" },
    { type: "origin-app", value: "my.deliverychain.ux" },
  ],
}, { keyProperties: ["prompt"], proves, ...ASSIST });



type IntentPayload = Record<string, unknown>;

/**
 * The bare name a service is known by outside Smartscape.
 *
 * Nodes are labelled "frontend (frontend)" or "cartservice (oteldemo.CartService)"
 * — the short name first, the detected one in brackets. Log records key on the
 * short one, so the qualifier is dropped. Quotes are stripped because the
 * result is interpolated into DQL.
 */
const shortName = (name: string) =>
  name.replace(/\s*\(.*$/, "").replace(/["\\]/g, "").trim();

/** Every hand-off carries the window on screen, so it opens already scoped. */
const withTf = (tf: Timeframe, p: IntentPayload): IntentPayload =>
  // the window's own expressions, verbatim — interpolating the timeframe
  // OBJECT into a template produced `now()-[object Object]`, which every
  // hand-off then carried into the app it opened. TypeScript allows an object
  // in a template, so nothing complained; the payload was simply wrong.
  ({ ...p, "dt.timeframe": { from: tf.from, to: tf.to } });

const link = (
  label: string, meta: string, payload: IntentPayload,
  opts: {
    keyProperties?: string[]; appId?: string; intentId?: string;
    app?: string; proves?: string;
    /** A url the app publishes itself, when the intent cannot say this. */
    href?: string;
  } = {},
): DeepLink => ({
  label, meta, payload,
  keyProperties: opts.keyProperties ?? ["dt.query"],
  // A url-only step still names its app so the node is labelled, but it must
  // NOT name an intent: naming one is what sends the click to the bus.
  appId: opts.href ? undefined : opts.appId,
  intentId: opts.href ? undefined : opts.intentId,
  app: opts.app ?? "Open with…",
  proves: opts.proves ?? "",
  href: opts.href ?? safeLink(payload, opts.appId, opts.intentId),
  ...(opts.href ? { viaHref: true } : {}),
});

/**
 * The Users & Sessions filter-bar grammar, read off the app's OWN url after
 * filtering by hand — the only source that is the wire format rather than a
 * rendering of it:
 *
 *   …/sessions/finished-sessions?tf=…&perspective=general#filtering=Frontends+%3D+easytrade
 *   decoded:                                              filtering=Frontends = easytrade
 *
 * So: label `Frontends` — PLURAL — a single `=`, and the application's DISPLAY
 * NAME, unquoted. Three things this corrects, each of which silently opened
 * the explorer unfiltered:
 *   · `dt.rum.application.id = 35d7…` — raw field and raw entity id (the bug)
 *   · `Frontend` singular
 *   · quoting the label, which the Error Inspector's chip only APPEARS to do:
 *     that screenshot shows the rendered pill, not the string on the wire.
 *
 * A wrong filter never errors here — the app opens showing the whole
 * environment, which reads as a working button. That is why this is pinned to
 * an observed url and not to a plausible guess.
 */
const filterChip = (label: string, value: string) =>
  // Bare is the observed form. A name with spaces cannot survive bare, and
  // quoting is the only shape that could, so it is used strictly as the
  // fallback rather than as the default.
  (/^[\w.:@/-]+$/.test(value)
    ? `${label} = ${value}`
    : `${label} = "${value.replace(/["\\]/g, "")}"`);

/**
 * "Analyze user sessions" — this application's sessions, in the Users &
 * Sessions explorer.
 *
 * `explorer.type` is required and its pattern admits only "sessions".
 * `explorer.properties.filters` is the filter-bar string above, and
 * `perspective` is the other property the app's own url carries — naming it
 * lands on the same view the app opens itself rather than on whichever one the
 * intent happens to default to.
 */
export const sessionsLink = (tf: Timeframe, appName: string, sessions: number): DeepLink =>
  link("Analyze user sessions",
    `Users & Sessions · ${sessions.toLocaleString()} sessions · ${tf.label}`,
    withTf(tf, {
      "explorer.type": "sessions",
      "explorer.properties": {
        filters: filterChip("Frontends", appName),
        perspective: "general",
      },
    }),
    { appId: SESSIONS_LIST.appId, intentId: SESSIONS_LIST.intentId,
      app: "Users & Sessions", keyProperties: ["explorer.type"],
      proves: "the sessions behind the number, one row each" });

/**
 * Our window in the grammar the explorer pages put in their own url: a single
 * `tf=<from>;<to>` where relative expressions are written `now-2h`, not
 * `now()-2h` and not a bare `-2h`.
 *
 * Anything this cannot express with certainty returns null, and the caller
 * omits `tf` so the app falls back to its own default window. A visibly
 * different window is recoverable; a window that silently means something else
 * is not.
 */
const tfParam = (tf: Timeframe): string | null => {
  const one = (e: string): string | null => {
    // A Timeframe holds the DQL form, not the selector's: `now` is stored as
    // `now()` and an absolute instant as a QUOTED string literal, because both
    // are interpolated straight into queries. Reading it as if it were the
    // selector's grammar produced no `tf` at all and the app opened on its own
    // window — the same silent-wrong-window class as the rest of this file.
    const v = e.trim().replace(/^"(.*)"$/, "$1");
    if (/^now\(\)$/.test(v)) return "now";                          // now()     → now
    const rel = /^now\(\)\s*([+-])\s*(\d+)([smhdwMy])$/.exec(v);
    if (rel) return `now${rel[1]}${rel[2]}${rel[3]}`;               // now()-2h  → now-2h
    if (/^[+-]\d+[smhdwMy]$/.test(v)) return `now${v}`;             // -2h       → now-2h
    if (/^\d{4}-\d{2}-\d{2}T/.test(v)) return v;                    // ISO instant
    return null;
  };
  const from = one(tf.from), to = one(tf.to);
  return from && to ? `${from};${to}` : null;
};

/**
 * The Error Inspector's EXPLORER, already filtered — built as the app's own
 * url rather than as an intent.
 *
 * Why not the intent: `inspect-errors-of-frontend` declares only typed
 * properties (frontend, error.type, page.name…) and no filter string, so
 * `target: "explorer"` lands on the Explorer with an empty filter bar. The
 * app's url is the only expression of a filtered Explorer, and it was read off
 * the app after filtering by hand:
 *
 *   /error-explorer?tf=now-2h;now&perspective=impact&sort=affected_users:descending
 *   #filtering=Frontend = "My Web Application"
 *
 * Note `Frontend`, SINGULAR — the sessions explorer calls the same field
 * `Frontends`. Two apps, two labels, neither derivable from the other.
 *
 * `perspective=impact` and the sort come from that same url: errors ranked by
 * how many people they reached, which is the ordering this app argues for
 * everywhere else.
 *
 * SEVERAL conditions fit in one filter string, separated by spaces — observed:
 *
 *   #filtering="View Name" = "/" Frontend = Astroshop-Snow
 *
 * with the quoting mixed: the label "View Name" is quoted because it contains
 * a space, `Frontend` is not, and a value is quoted only when it needs to be.
 * That matters here because a view name is NOT unique — measured, `/` exists
 * in four of this tenant's applications — so the frontend has to travel with
 * it or the drill-down widens without saying so.
 */
export const errorsExplorerHref = (
  tf: Timeframe, appName: string, viewName?: string,
): string => {
  const q = new URLSearchParams({
    perspective: "impact", sort: "affected_users:descending",
  });
  const t = tfParam(tf);
  if (t) q.set("tf", t);
  /* Quote BOTH sides, always.
   *
   * The app's own quoting is inconsistent — it emits `Frontend = easytrade`
   * here and `"Frontend" = "www.vmware.easytravel.com"` there — and guessing
   * which form a given name needs is how this link kept arriving unfiltered.
   * Quoting is accepted everywhere it was observed, so the safe form is the
   * one that never has to decide. */
  const val = (v: string) => `"${v.replace(/["\\]/g, "")}"`;
  const filter = [
    ...(viewName ? [`"View Name" = ${val(viewName)}`] : []),
    `"Frontend" = ${val(appName)}`,
  ].join(" ");
  /* Spaces as `+`, not `%20`: that is what the Error Inspector writes into its
   * own address bar, so it is the encoding known to survive its fragment
   * parser. URLSearchParams produces exactly that. */
  const path = `/ui/apps/dynatrace.error.inspector/error-explorer?${q}`
    + `#${new URLSearchParams({ filtering: filter })}`;
  // Absolute, because this app runs in an iframe: a relative href would
  // resolve against the app's own origin and go nowhere. Outside the shell
  // getEnvironmentUrl has nothing to report, and the caller degrades.
  try {
    const base = getEnvironmentUrl();
    return base ? new URL(path, base).toString() : path;
  } catch {
    return path;
  }
};

/**
 * "Inspect errors" — this application's errors, opened in the platform's own
 * Error Inspector.
 *
 * `frontend` is the intent's single required property and takes the entity id
 * unchanged; its declared pattern also covers MOBILE_ and CUSTOM_ applications,
 * so one pair serves every kind of frontend. Measured before wiring: all 32,867
 * errors of the busiest application carry the very entity id sent here, so the
 * app opens on the same errors this page counted — not on its own default.
 */
/**
 * The route's Error Inspector step.
 *
 * Takes the application's NAME, not its entity id, because the destination is
 * the Explorer's filter bar and the filter bar matches on the display name.
 * It used to hand off by intent with `target: "overview"`, which opened the
 * grouped page — a different tab, and unfiltered, since the intent carries no
 * filter string at all.
 */
export const errorsLink = (tf: Timeframe, appName: string, errors: number): DeepLink =>
  link("Inspect errors", `Error Inspector · ${errors.toLocaleString()} errors · ${tf.label}`,
    {}, { app: "Error Inspector", href: errorsExplorerHref(tf, appName),
      proves: "every error of this application, ranked by users affected" });

/**
 * The platform's own intent url: `/ui/apps/<app>/intent/<action>?<payload>`,
 * with object values JSON-encoded. Verified by hand against this tenant for
 * the Error Inspector and the sessions explorer.
 */
function intentUrl(appId: string, intentId: string, payload: IntentPayload): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(payload)) {
    if (v === undefined || v === null) continue;
    q.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  const path = `/ui/apps/${appId}/intent/${intentId}?${q}`;
  try {
    const base = getEnvironmentUrl();
    return base ? new URL(path, base).toString() : path;
  } catch { return path; }
}

/**
 * The href a hand-off degrades to.
 *
 * getIntentLink answers with a bare `https://dynatrace.com/` when there is no
 * shell around the app, which is how a drill-down could look wired and do
 * nothing at all: sendIntent found no bus, swallowed it, and the anchor had
 * nowhere to go. When the pair is known the url is built directly instead, so
 * the click works with or without the intent bus.
 */
function safeLink(payload: IntentPayload, appId?: string, intentId?: string): string {
  let viaSdk = "";
  try {
    viaSdk = appId && intentId
      ? getIntentLink(payload as never, appId, intentId)
      : getIntentLink(payload as never);
  } catch { viaSdk = ""; }
  const useless = !viaSdk || /^https:\/\/(www\.)?dynatrace\.com\/?$/.test(viaSdk);
  if (!useless) return viaSdk;
  return appId && intentId ? intentUrl(appId, intentId, payload) : "#";
}

let runtime: boolean | null = null;
/**
 * True when the app is running inside the Dynatrace shell. Standalone on
 * localhost there is no intent bus: the SDK warns and hands back a plain
 * dynatrace.com link, so the panel says so instead of offering dead cards.
 */
export function intentsAvailable(): boolean {
  if (runtime === null) {
    try {
      const probe = getIntentLink({ "dt.query": "fetch logs" } as never);
      runtime = !/^https:\/\/(www\.)?dynatrace\.com\/?$/.test(probe);
    } catch {
      runtime = false;
    }
  }
  return runtime;
}

/**
 * Hands the payload to the platform. Naming the app and the intent opens it
 * straight away; without them the platform asks the user to pick, so we only
 * fall back to `keyProperties` when no app is known for the step.
 */
export function open(
  step: Pick<DeepLink, "payload" | "keyProperties" | "appId" | "intentId">,
) {
  try {
    if (step.appId && step.intentId) {
      sendIntent(step.payload as never,
        { recommendedAppId: step.appId, recommendedIntentId: step.intentId });
    // Recommending an app without naming its action is not expressible: the
    // SDK's options are a closed union, so it is both or neither.
    } else if (step.keyProperties?.length) {
      sendIntent(step.payload as never, { keyProperties: step.keyProperties as never });
    } else {
      sendIntent(step.payload as never);
    }
  } catch {
    /* outside the Dynatrace shell there is no intent bus — the anchor href is the fallback */
  }
}


/** Measured facts about the element, carried into the Assist prompt context. */
export interface ElementFacts {
  /** "1.4 errors per view", "182 of 960 abandoned" — already formatted. */
  lines: string[];
}

export interface LinkContext {
  /** Entity ids this element represents. */
  ids: string[];
  /** The element's display name — pods and services key logs/spans by name. */
  name: string;
  /** The window on screen, reused by every query. */
  tf: Timeframe;
  /** Active Davis problems attributed to these ids. */
  problems?: number;
  /** "CATEGORY name" of every active problem on this element — the evidence
   *  the route reads before offering a lens. */
  problemHints?: string[];
  /** Short RUM id, set only for the application layer — user.events keys on it. */
  rumAppId?: string;
  /** Errors measured on this element, so the route can offer the app that
   *  exists to explain them rather than only apps that summarise them. */
  errors?: number;
  /** An active Davis problem on this element, opened directly in the Problems app. */
  problem?: {
    eventId: string; display_id: string; name: string;
    /** Davis's own classification — SLOWDOWN, ERROR, AVAILABILITY… It decides
     *  which analysis a service step opens, so the route follows the evidence. */
    category?: string;
  };
  /**
   * A contacted domain, for the layers that have no Smartscape entity: a
   * third party or the ingress is a name in url.domain, not an entity, so the
   * route is keyed on that instead of on an id.
   */
  domain?: string;
  /** What is measured about this element right now, for the Assist context. */
  facts?: ElementFacts;
  /**
   * Which app owns each capability in this environment. Resolved from the
   * registry so a node names the app the user will really land in — Gen3 when
   * present, classic only when it is the only one installed.
   */
  apps?: AppMap;
  /** False when Assist is disabled or the user lacks permission — no starters then. */
  assist?: boolean;
  /** Anomalies, custom alerts and extension events on this element — problems
   *  travel separately; this is everything else Davis has to say. */
  signals?: number;
  /** True when the element's forecast points up — trouble predicted counts as
   *  trouble for choosing the frame, before it counts as anything else. */
  forecastRising?: boolean;
  /**
   * Who the errors reached, measured at the application level, present only
   * when the element carries signals. The exemplar session is what the two
   * unit-session steps open — without it there is no session to show, so the
   * steps are simply not offered.
   */
  impacted?: {
    sessions: number; hit: number; hitReal: number; hitRobot: number; hitSynth: number;
    ex?: { sid: string; start: string; inst?: string; errs: number };
  };
}

/* ─────────────── investigation routes ─────────────── */

export type Persona = "technical" | "tactical" | "executive";

export interface Route {
  persona: Persona;
  /** The question this route answers. */
  title: string;
  /** The conclusion reached at the end of the steps. */
  goal: string;
  /** Ordered hand-offs: each one narrows the question the previous one left. */
  steps: DeepLink[];
}

/**
 * Three ordered routes through the platform apps, one per audience.
 *
 * They are deliberately different journeys, not the same links relabelled: the
 * technical route walks down the stack towards a failing component, the
 * tactical route walks sideways across blast radius and ownership, and the
 * executive route walks up to sessions and revenue. A route is only offered
 * when every step it needs can be keyed on something this element actually has.
 */
export function investigationPaths(
  { ids, name, tf, rumAppId, errors, problem, problems = 0, problemHints = [], domain, facts,
    assist = false, apps = {}, impacted, signals = 0, forecastRising = false }: LinkContext,
): Route[] {
  const svc = ids.find((i) => i.startsWith("SERVICE-"));
  const host = ids.find((i) => i.startsWith("HOST-"));
  // Web, mobile and custom applications all take the application steps; the
  // payload key stays dt.entity.application because Experience Vitals accepts
  // all three id forms under that one key (schema captured from its manifest).
  const app = ids.find((i) => /^(?:MOBILE_|CUSTOM_)?APPLICATION-/.test(i));
  const isMobileApp = !!app?.startsWith("MOBILE_APPLICATION-");
  const pgi = ids.find((i) => i.startsWith("PROCESS_GROUP_INSTANCE-"));
  const out: Route[] = [];

  /*
   * An entity hand-off. The payload is the canonical id and nothing else, so
   * the platform opens whichever app owns that entity type — an app that
   * already holds the data, with its own traces, logs and charts in place.
   * That is the point: a query app would make the user run the analysis, an
   * entity app has already run it.
   */
  const eLink = (
    label: string, proves: string, field: string, id: string, cap: Capability,
    /** Overrides the capability's default action, for a different lens on the
     *  same app — Services answers "what fails" and "where the time goes" with
     *  two separate actions. */
    instead?: IntentRef,
  ) => {
    const t = apps[cap];
    // Naming the app alone still opens the chooser, because several actions
    // accept the same entity type. The action is looked up per app, so the
    // step lands on the view it promises instead of on a list of views.
    const act = instead ?? (t ? intentFor(cap, t.appId) : undefined);
    return link(label, id, withTf(tf, { [field]: id }), {
      keyProperties: [field], proves,
      // the node states the app this environment will actually open
      app: t?.name ?? "Entity app",
      ...(t && act ? { appId: t.appId, intentId: act.intentId } : {}),
    });
  };

  /**
   * A query hand-off, for the apps that hold records rather than entities.
   *
   * Logs and traces are not reachable by an entity id: the chooser proves it —
   * a `dt.smartscape.service` payload offers only "View topology", because no
   * logs or tracing action declares that property. Those apps are DQL-driven,
   * so the step carries the query itself. No `from:`/`to:` in it on purpose:
   * the payload's `dt.timeframe` supplies the window, so the app opens on the
   * same period the screen was measured over.
   */
  const qLink = (
    label: string, proves: string, meta: string, query: string, cap: Capability,
  ) => {
    const t = apps[cap];
    const act = t ? intentFor(cap, t.appId) : undefined;
    const payload = withTf(tf, { "dt.query": query });
    // Handed over as an intent, never as a hand-built URL. Replaying the Logs
    // app's own URL state — copied from a link that app had just produced —
    // opened it on its defaults with the query gone, so that state is not a
    // way in, only a way out. The intent carries the query; it is the one
    // route measured to arrive with the data.
    return link(label, meta, payload, {
      keyProperties: ["dt.query"], proves,
      app: t?.name ?? "Query app",
      ...(t && act ? { appId: t.appId, intentId: act.intentId } : {}),
    });
  };

  /**
   * Every request the service handled, in the tracing explorer.
   *
   * Not one hand-picked trace: the explorer opens filtered to the service and
   * the window on screen, with all of its requests — slowest, failing and
   * healthy — sortable and each one a click from its span-by-span view. The
   * `dt.filter` grammar is the explorer's own, not DQL: single `=`, unquoted
   * value. See TRACES_LIST in intents.ts for how that was established.
   */
  const tListLink = (svcId: string) => {
    const app = apps.traces;
    return link("See its requests", `all traces · ${tf.label}`,
      withTf(tf, { "dt.filter": `dt.smartscape.service = ${svcId}` }),
      { keyProperties: ["dt.filter"],
        proves: "Every request it served in this window — sort by duration " +
          "or failure, open any of them span by span.",
        app: app?.name ?? "Distributed Tracing",
        ...(app?.appId === "dynatrace.distributedtracing"
          ? { appId: app.appId, intentId: TRACES_LIST.intentId } : {}) });
  };

  /* The Davis problem itself, opened where the AI already computed the cause. */
  const pLink = () => {
    if (!problem) return null;
    const t = apps.problems;
    // event.kind is load-bearing, not decoration: with only event.id the shell
    // answers "No compatible intents found" — an event is not recognisable as a
    // problem until its kind says so. That one missing field is why this step
    // opened an empty dialog.
    return link(problem.display_id, problem.name,
      withTf(tf, { "event.id": problem.eventId, "event.kind": "DAVIS_PROBLEM" }),
      { keyProperties: ["event.id", "event.kind"],
        proves: "The root cause Davis already computed, with its evidence.",
        app: t?.name ?? "Problems",
        ...(() => {
          const act = t ? intentFor("problems", t.appId) : undefined;
          return t && act ? { appId: t.appId, intentId: act.intentId } : {};
        })() });
  };

  /*
   * With nothing wrong and nothing forecast to go wrong, an investigation is
   * the wrong conversation: "root cause" of what? The routes keep the same
   * verified apps — they are still where the answers live — but the QUESTION
   * changes from finding the fault to finding the opportunity: performance
   * headroom, capacity for growth, experience worth improving. Predicted
   * trouble (a rising forecast) keeps the incident frame: it is an
   * investigation of tomorrow's problem.
   */
  const healthy = !problem && problems === 0 && signals === 0
    && !forecastRising && !(impacted && impacted.hit > 0);

  const facts_ = (facts?.lines ?? []).join(" ");
  const kind = svc ? "service" : host ? "host"
    : app ? (isMobileApp ? "mobile application" : "web application")
    : pgi ? "process" : domain ? "contacted domain" : "element";
  const scope = `The element is "${name}" (${kind}), measured over the ${tf.label}.` +
    (healthy ? " It is currently healthy: no active problems, no anomalies," +
      " and no rising forecast." : "") +
    (facts_ ? ` Measured right now: ${facts_}` : "") +
    (problem ? ` It has an active Davis problem: ${problem.display_id} — ${problem.name}.` : "") +
    (problems > 1 ? ` ${problems} Davis problems are attributed to it.` : "") +
    (impacted && impacted.hit > 0
      ? ` Errors reached ${impacted.hit} of ${impacted.sessions} sessions of the application` +
        ` in this window (${impacted.hitReal} real users, ${impacted.hitRobot} robots,` +
        ` ${impacted.hitSynth} synthetic).`
      : "");

  /*
   * The sequence of apps to open, in order. A node carries the Smartscape id
   * classic entity id (dt.entity.*), which is the only form any app declares.
   * Smartscape's own `dt.smartscape.*` keys are for traversing topology inside
   * a query — no app accepts one as an intent payload, so sending them was the
   * reason several steps opened a chooser with nothing in it.
   */
  /**
   * What the evidence supports, before any lens is offered. Response-time
   * analysis always has content — every service has latency — so it is the
   * safe default. Failure analysis only has content when something fails, so
   * it is offered exactly when Davis says something does: a service whose one
   * problem is a SLOWDOWN got sent to a failure view twice, and twice the view
   * answered "all requests successful".
   */
  const hints = [...problemHints, problem ? `${problem.category ?? ""} ${problem.name}` : ""]
    .join(" ");
  const slow = /SLOWDOWN|RESOURCE|response time|slow|latenc|degrad/i.test(hints);
  const failing = /\bERROR\b|AVAILABILITY|fail(ed|ure|ing)?\b|unavailab|outage/i.test(hints);

  const tech: DeepLink[] = [];
  const pod = ids.find((i) => i.startsWith("K8S_POD-"));
  const node = ids.find((i) => i.startsWith("K8S_NODE-"));
  // The classic Kubernetes app is the only one with an action for a pod, and it
  // knows pods by their classic id: handed a Smartscape K8S_POD- id it resolves
  // the intent, navigates, and lands on 404 — which reads as working. The
  // Smartscape node carries `id_classic`, so both forms travel together and the
  // route sends whichever the destination speaks.
  const podClassic = ids.find((i) => i.startsWith("CLOUD_APPLICATION_INSTANCE-"));
  const nodeClassic = ids.find((i) => i.startsWith("KUBERNETES_NODE-"));

  if (svc) {
    tech.push(
      failing
        ? eLink("What is failing", "Its failure rate, broken down by what fails.",
            "dt.entity.service", svc, "services")
        : eLink("Where the time goes", "Response time split across the calls it makes to others.",
            "dt.entity.service", svc, "services", SERVICE_RESPONSE_TIME),
      // the tracing step needs no lookup: the filter is built from the id the
      // node already carries, so it is always offered and always complete
      tListLink(svc),
      // Two keys, not one. Only 116k of 2.1M log lines here carry
      // dt.entity.service — the rest are attributed to the container that
      // wrote them, and the container name matches the service's short name
      // (frontend, cartservice, checkoutservice…). Filtering on the entity id
      // alone opens an empty screen for most services; this finds both.
      qLink("Read what it logged", "The lines the code wrote while it was failing.",
        "newest first",
        `fetch logs | filter dt.entity.service == "${svc}"`
        + ` or k8s.container.name == "${shortName(name)}"`
        + " | sort timestamp desc", "logs"),
    );
  } else if (pod || node) {
    const k = pod ?? node!;
    tech.push(
      eLink(pod ? "Open the pod" : "Open the node",
        "Its workload, placement and resource pressure.",
        // pods are addressed by their classic entity id, not the Smartscape
        // routing key — that key matched no app at all
        pod ? "dt.entity.cloud_application_instance" : "dt.entity.kubernetes_node",
        (pod ? podClassic : nodeClassic) ?? k, "kubernetes",
        !pod ? K8S_NODE_BY_APP[apps.kubernetes?.appId ?? ""] : undefined),
      // pods and nodes are named, not keyed, in log records
      qLink("Read what it logged", "The container output around the failure.",
        "newest first",
        `fetch logs | filter ${pod ? "k8s.pod.name" : "k8s.node.name"} == "${shortName(name)}"`
        + " | sort timestamp desc", "logs"),
    );
  } else if (host) {
    tech.push(
      eLink("Open the host", "The machine's processes, saturation and events.",
        "dt.entity.host", host, "hosts"),
      qLink("Read what it logged", "The host's own log stream.",
        "newest first", `fetch logs | filter dt.entity.host == "${host}"`
        + " | sort timestamp desc", "logs"),
    );
  } else if (app) {
    tech.push(
      // No trace step here: spans in this environment carry neither
      // dt.entity.application nor dt.rum.application.id (measured: 0 of 1.6M),
      // so a browser-to-trace hand-off would open on an empty result.
      eLink("Open the application", "Its sessions, views and errors as RUM presents them.",
        "dt.entity.application", app, isMobileApp ? "mobile" : "rum"),
    );
    /* The Gen3 DEM app for the question this route actually asks.
     * "What is failing here" was being answered with Experience Vitals and an
     * Assist prompt, while the platform ships an app whose entire subject is
     * this: Error Inspector, grouping the errors by type and message and
     * ranking them by users affected. It leads the route when the element is
     * failing — the errors ARE the root cause evidence — and stays available
     * behind the overview when it is not. */
    if (errors && errors > 0) {
      const insp = errorsLink(tf, name, errors);
      if (failing) tech.unshift(insp); else tech.push(insp);
    }
  } else if (pgi) {
    tech.push(eLink("Open the process", "The running process, its host and technology.",
      "dt.entity.process_group_instance", pgi, "processes"));
  }
  const prob = pLink();
  if (prob) tech.push(prob);
  if (assist) {
    tech.push(healthy
      ? aLink("Ask Assist", "where is the easy win",
          "Reads the measured numbers as tuning opportunities, in words.",
          `"${name}" is healthy right now. Looking at its measurements, where is the ` +
          "easiest performance win, and what would confirm it is worth taking?",
          scope,
          "Answer in short bullet points. Name the single most promising optimisation " +
          "first, with the number that motivates it. Say plainly when the data shows " +
          "nothing worth tuning.")
      : aLink("Ask Assist", "why it is failing",
          "Reads the evidence back as a cause, in words.",
          `Looking at "${name}", what is the most likely technical cause of its current ` +
          "behaviour, and what would confirm or rule it out?",
          scope,
          "Answer in short bullet points. Name the most likely cause first, then the " +
          "single check that would confirm it. Say plainly when the data is not enough."));
  }
  if (tech.length) {
    out.push(healthy
      ? { persona: "technical", title: "Performance headroom",
          goal: "Find the easiest win before anyone feels a slow one.", steps: tech }
      : { persona: "technical", title: "Root cause",
          goal: "Name the component that is failing and what proves it.", steps: tech });
  }

  /* ── tactical: what it takes down with it, and whether it is worth it now ── */
  const tac: DeepLink[] = [];
  if (prob) tac.push(prob);
  if (svc) {
    // The lens the technical route did not take — but only when the evidence
    // backs it. Time analysis is always worth a step; a failure step with no
    // failures behind it is an empty page wearing a promise.
    if (failing) {
      tac.push(eLink("Where the time goes",
        "Response time split across the calls it makes to others.",
        "dt.entity.service", svc, "services", SERVICE_RESPONSE_TIME));
    }
  } else if (pod || node) {
    tac.push(eLink("What shares this node",
      "The workloads a node-level event would take down together.",
      node ? "dt.entity.kubernetes_node" : "dt.entity.cloud_application_instance",
      (node ? nodeClassic ?? node : podClassic ?? pod)!, "kubernetes",
      node ? K8S_NODE_BY_APP[apps.kubernetes?.appId ?? ""] : undefined));
  } else if (host) {
    // Topology is the question here, and only the classic Smartscape app
    // answers it for a host — the Gen3 one declares nothing for `dt.entity.host`
    // (its actions are about problems). So this names that app directly rather
    // than resolving Gen3-first and landing on a view that cannot answer.
    tac.push(link("What this host carries",
      "The processes a host-level event would take down.",
      withTf(tf, { "dt.entity.host": host }),
      { keyProperties: ["dt.entity.host"],
        proves: "The topology around this machine, as Smartscape maps it.",
        app: "Smartscape Classic",
        appId: "dynatrace.classic.smartscape", intentId: "view-host" }));
  }
  if (assist) {
    tac.push(healthy
      ? aLink("Ask Assist", "will it hold growth",
          "Weighs today's headroom against tomorrow's load.",
          `"${name}" is healthy right now. If its load doubled, what would saturate ` +
          "first, and what should be prepared before that day?",
          scope,
          "Answer in short bullet points: the first bottleneck, the number that says " +
          "so, and the one preparation worth doing now. Say plainly when the data " +
          "does not support a conclusion.")
      : aLink("Ask Assist", "is it worth fixing first",
          "Weighs blast radius against effort, with the platform's own guidance.",
          `Given the state of "${name}", how urgent is this compared with other work, ` +
          "and what is its blast radius?",
          scope,
          "Answer in short bullet points: urgency, who else is affected, and what to do " +
          "in the next hour. Say plainly when the data does not support a conclusion."));
  }
  if (tac.length) {
    out.push(healthy
      ? { persona: "tactical", title: "Capacity & readiness",
          goal: "Prove it holds tomorrow's load before tomorrow does.", steps: tac }
      : { persona: "tactical", title: "Blast radius & priority",
          goal: "Decide whether this comes first, and who it takes down with it.", steps: tac });
  }

  /* ── executive: the reading, not the data ── */
  const exec: DeepLink[] = [];
  // The hex fallback holds for web only: a web app's RUM id is the entity id's
  // suffix, a mobile app's is a UUID that maps to nothing. With neither a real
  // entity nor a web-hex id there is no step — a fabricated id opens an app on
  // emptiness while looking like it worked.
  const appEntity = app
    ?? (rumAppId && /^[0-9a-f]{16}$/.test(rumAppId)
      ? "APPLICATION-" + rumAppId.toUpperCase() : undefined);
  if (appEntity) {
    exec.push(eLink("Sessions and conversion",
      "The real-user picture the RUM app already maintains.",
      "dt.entity.application", appEntity,
      appEntity.startsWith("MOBILE_APPLICATION-") ? "mobile" : "rum"));
  }
  /*
   * The impact as ONE user lived it — the worst-hit session, opened in the
   * apps dedicated to single sessions, both generations. Two steps by request,
   * not gen3-with-classic-fallback: the Gen3 app reads the session's events
   * from Grail, the classic one holds the session timeline and the replay, and
   * they answer differently enough to both earn a card. Payloads are exactly
   * what each intent declares — see SESSION_GEN3 / SESSION_CLASSIC.
   */
  const sess = impacted?.ex;
  if (sess) {
    exec.push(link("Open an impacted session", `${sess.errs} errors · one user`,
      { "dt.rum.session.id": sess.sid, "start_time": sess.start },
      { keyProperties: ["dt.rum.session.id"],
        proves: "The impact as one user lived it — the worst-hit session, event by event.",
        app: "Users & Sessions",
        appId: SESSION_GEN3.appId, intentId: SESSION_GEN3.intentId }));
    if (sess.inst) {
      exec.push(link("The same session, classic", "timeline & replay",
        { "dt.rum.session.id": sess.sid, "dt.rum.instance.id": sess.inst,
          "start_time": sess.start },
        { keyProperties: ["dt.rum.session.id"],
          proves: "The classic session timeline, with the replay when one was captured.",
          app: "Session Segmentation (Classic)",
          appId: SESSION_CLASSIC.appId, intentId: SESSION_CLASSIC.intentId }));
    }
  }
  if (assist) {
    exec.push(
      healthy
        ? aLink("Ask Assist", "where improvement pays most",
            "Turns healthy numbers into the investment worth making.",
            `"${name}" is healthy right now. Which improvement to it would users ` +
            "notice most, and what makes it worth doing before anything else?",
            scope)
        // One Assist per route, not two. "what does this cost us" and "what
        // should we do first" were adjacent nodes asking the same person the
        // same thing twice; merged into the question an owner actually has.
        : aLink("Ask Assist", "what this costs and what to do first",
            "Turns the measured numbers into the consequence an owner acts on, "
            + "and the first move worth making.",
            `What is the business impact of the current state of "${name}", which of ` +
            "these numbers should worry me most, and what would you fix first?",
            scope + " Consider effort, blast radius and how many sessions each option " +
            "would recover."),
    );
  }
  if (exec.length) {
    out.push(healthy
      ? { persona: "executive", title: "Experience & opportunity",
          goal: "Turn healthy into better — where improvement pays most.", steps: exec }
      : { persona: "executive", title: "Business impact",
          goal: "Size what this costs, and what to do about it.", steps: exec });
  }

  return out;
}

/** The app that owns an entity type, for the node label. */
function appNameFor(field: string): string {
  const map: Record<string, string> = {
    "dt.entity.service": "Services",
    "dt.entity.host": "Infrastructure",
    "dt.entity.application": "Web application",
    "dt.entity.process_group_instance": "Processes",
  };
  return map[field] ?? "Entity app";
}

/**
 * The entity id a hand-off keys on, derived when the telemetry omits it.
 *
 * Measured on this tenant: two of four applications carry
 * `dt.rum.application.entity` on ZERO of their records — AI Chatbot on 0 of
 * 798 — so every drill-down keyed on it returned nothing and those rows simply
 * had no link. The id is recoverable because a WEB application's RUM id is its
 * entity id's suffix, and both derived ids were checked against the inventory
 * before this shipped: they resolve to "AI Chatbot" and "My Web Application".
 *
 * Only for the 16-hex-character form. A mobile application's RUM id is a UUID
 * that maps to no entity at all, and inventing one would open an app on
 * emptiness while looking like it worked.
 */
export const appEntityOf = (entity?: string | null, rumAppId?: string) =>
  entity ?? (rumAppId && /^[0-9a-f]{16}$/.test(rumAppId)
    ? `APPLICATION-${rumAppId.toUpperCase()}` : undefined);

/**
 * The drill-down behind one row of a card's breakdown.
 *
 * Each panel hands off to the app that owns its subject, with the row's own
 * value carried as a filter:
 *   views    → Error Inspector, which declares `view.name` in its manifest
 *   errors   → Error Inspector, narrowed further by the error's source
 *   services → the Services app's failure analysis, the pair already verified
 *              from this environment's chooser
 * Domains are the exception and deliberately return null: no app in this
 * environment declares a property keyed on a contacted domain, and inventing
 * one would open a filtered-looking screen showing everything.
 */
export function rowDrilldown(
  kind: "views" | "errors" | "requests" | "services",
  row: { name: string; type?: string; src?: string; id?: string;
         fails?: number; errors?: number; named?: number;
         /** Domains only: whether any span was served by this address. */
         hasSpans?: boolean },
  tf: Timeframe, appEntity?: string,
  /**
   * Which column was clicked. The Services app has two analyses and they
   * answer different questions: sending every click to the failure analysis
   * opened an empty page on the six services that have no failures at all —
   * the row itself says "no errors, none projected" and the drill-down then
   * contradicted it. Response time is the default because it always has
   * something to show; failures are offered only where failures exist.
   */
  lens: "time" | "fail" | "volume" = "time",
  /**
   * The application's display NAME. The Error Inspector's Explorer filters on
   * it — the entity id opens the app but names nothing in its filter bar — so
   * without this the error rows can only reach an unfiltered Explorer.
   */
  appName?: string,
): DeepLink | null {
  /* ── the bar: how much, and where it goes ──
   * The bar is a quantity, so it opens the view that compares quantities.
   * For a service that is the service map, where the calls actually flow
   * (`dt.entity.service` is the intent's one required property); for RUM rows
   * it is the sessions explorer, which the volume was counted from. The
   * sessions filter is by APPLICATION — its filter-bar grammar has a label
   * for frontends and none for a single view or domain — so the label says
   * application rather than pretending to a narrower scope. */
  if (lens === "volume") {
    if (kind === "services" && row.id) {
      return link("Where the calls flow", `${row.name} · service map`,
        withTf(tf, { "dt.entity.service": row.id }),
        { keyProperties: ["dt.entity.service"],
          appId: "dynatrace.services", intentId: "view-services-map",
          app: "Services", proves: "how much traffic this service carries, and from whom" });
    }
    if (kind === "errors" && appName) {
      return link("Every occurrence", row.name, {},
        { app: "Error Inspector", href: errorsExplorerHref(tf, appName),
          proves: "each time this failure happened" });
    }
    return null;
  }
  if (kind === "services" && row.id) {
    const failing = lens === "fail" && (row.fails ?? 0) > 0;
    return failing
      ? link("Where it fails", `${row.name} · failure analysis`,
          withTf(tf, { "dt.entity.service": row.id }),
          { keyProperties: ["dt.entity.service"],
            appId: "dynatrace.services", intentId: "view-service-failure-analysis",
            app: "Services", proves: "which requests fail here and what they take with them" })
      : link("Where the time goes", `${row.name} · response time analysis`,
          withTf(tf, { "dt.entity.service": row.id }),
          { keyProperties: ["dt.entity.service"],
            appId: "dynatrace.services", intentId: SERVICE_RESPONSE_TIME.intentId,
            app: "Services", proves: "how this service spends the time it takes" });
  }
  if (!appEntity) return null;
  /* Percentiles are a performance question, so they open the performance app.
   *
   * A VIEW lands scoped to itself. Experience Vitals declares a second intent,
   * `view-pages-views-waterfall`, whose `explorer.drilldown` takes either
   * `{ page }` or `{ view }` — an earlier pass here read only `view-frontend`
   * and concluded no per-view target existed, which was wrong and would have
   * shipped a click that widened silently to the whole application.
   *
   * A DOMAIN has no such property in any intent, so it opens the application's
   * vitals and the label says so rather than implying a filter that is not
   * there. */
  if (lens === "time" && kind === "views") {
    return link("Where the time goes", `${row.name} · frontend performance`,
      withTf(tf, {
        frontend: appEntity,
        "explorer.drilldown": { view: row.name },
      }),
      { keyProperties: ["frontend"],
        appId: "dynatrace.experience.vitals", intentId: "view-pages-views-waterfall",
        app: "Experience Vitals",
        proves: "where this view spends its time, request by request" });
  }
  if (lens === "time" && kind === "requests") {
    const d = row.name.replace(/["\\]/g, "");
    /* A domain WE SERVE has a native app after all.
     *
     * A scan of all 163 apps in this environment found no intent keyed on a
     * contacted domain, which is why this used to open the application's
     * vitals and say so apologetically. But the Distributed Tracing explorer
     * takes a free-form `dt.filter`, and the browser's domain reaches the
     * backend as `server.address`: measured, "10.107.164.30" matches 231,270
     * spans over 7 services. So a first-party domain opens its real traffic.
     *
     * `hasSpans` is measured per panel, not assumed: a CDN or a font host has
     * no span behind it, and the traces explorer would open empty. Those keep
     * the query hand-off below, which always has something to show.
     *
     * The filter grammar is the explorer's own — single `=`, value UNQUOTED.
     * The DQL form is accepted by the url and silently ignored, which opens
     * the app unfiltered and reads as working. */
    if (row.hasSpans) {
      return link("Follow these requests", `${d} · in traces`,
        withTf(tf, { "dt.filter": `server.address = ${d}` }),
        { keyProperties: ["dt.filter"],
          appId: "dynatrace.distributedtracing", intentId: TRACES_LIST.intentId,
          app: "Distributed Tracing",
          proves: "the server-side traces behind what the browser asked for" });
    }
    return link("Open this domain's requests", `${d} · as a query`,
      withTf(tf, {
        title: `Requests to ${d}`,
        "dt.query": `fetch user.events
| filter url.domain == "${d}"
| summarize requests = countIf(characteristics.classifier == "request"),
    failures = countIf(characteristics.classifier == "error"),
    p50 = percentile(if(characteristics.classifier == "request", toLong(duration)), 50),
    p90 = percentile(if(characteristics.classifier == "request", toLong(duration)), 90),
    p95 = percentile(if(characteristics.classifier == "request", toLong(duration)), 95),
  by: { path = url.path, code = http.response.status_code }
| sort requests desc`,
      }),
      { keyProperties: ["dt.query"],
        appId: "dynatrace.notebooks", intentId: "view-query",
        app: "Notebooks",
        proves: "every path this domain served, with its timings and failures" });
  }
  if (kind === "views") {
    // Measured on this tenant: /instruments, /login, /deposit, /home and
    // /credit-card/order all record zero errors. Offering the error page for
    // them was offering an empty screen — the row said "all satisfied" and
    // the click disagreed. No errors, no destination.
    if (!row.errors) return null;
    if (!appName) return null;
    return link("Errors on this view", `${row.errors} on ${row.name}`, {},
      { app: "Error Inspector",
        href: errorsExplorerHref(tf, appName, row.name),
        proves: "what failed for users of this view" });
  }
  if (kind === "errors") {
    /* Measured: two of this tenant's four applications record error.name on
     * ZERO of their errors — 1,996 and 39 of them — and the Error Explorer
     * lists errors BY name. The filter was right and the page was still
     * empty, because there was nothing named to list. A row this app had to
     * name itself (from a status code) leads nowhere. */
    if (row.named === 0) return null;
    if (!appName) return null;
    return link("Inspect this failure", row.name, {},
      { app: "Error Inspector", href: errorsExplorerHref(tf, appName),
        proves: "every occurrence of this failure" });
  }
  return null;
}

/**
 * The Services EXPLORER, filtered to one service.
 *
 * Read off the app's own url after filtering by hand — every part of an
 * earlier guess here was wrong, and each mistake is worth keeping visible:
 *
 *   /ui/apps/dynatrace.services/explorer-new/endpoints      ← not /explorer/services
 *     ?tf=<ISO>;<ISO>&perspective=performance&sort=healthIndicators:descending
 *     #filtering=dt.service.name = "accounting - astroshop - aeric-walls-aks"
 *
 *   · the filter keys on the FIELD ID `dt.service.name`, not on a display
 *     label the way the Error Inspector and the sessions explorer do
 *   · it matches the service NAME, not its SERVICE- id
 *   · the value is quoted; `detailsId` opens a details pane but narrows
 *     nothing, so on its own it left the Explorer listing the whole estate
 *
 * Three sibling apps, three filter grammars, no two alike. Each is pinned to
 * an observed url because deducing one from another has failed every time.
 */
export function servicesExplorerHref(tf: Timeframe, serviceName: string): string {
  const q = new URLSearchParams({
    tf: `${tfIso(tf.from)};${tfIso(tf.to)}`,
    perspective: "performance",
    sort: "healthIndicators:descending",
  });
  const filter = `dt.service.name = "${serviceName.replace(/["\\]/g, "")}"`;
  const path = `/ui/apps/dynatrace.services/explorer-new/endpoints?${q}`
    + `#filtering=${encodeURIComponent(filter)}`;
  try {
    const base = getEnvironmentUrl();
    return base ? new URL(path, base).toString() : path;
  } catch { return path; }
}

/** A Timeframe expression resolved to the instant it means. */
function tfIso(e: string): string {
  const v = e.trim().replace(/^"(.*)"$/, "$1");
  if (/^now\(\)$/.test(v) || v === "now") return new Date().toISOString();
  const rel = /^(?:now\(\))?\s*-\s*(\d+)([smhdw])$/.exec(v);
  if (rel) {
    const MIN: Record<string, number> = { s: 1 / 60, m: 1, h: 60, d: 1440, w: 10080 };
    return new Date(Date.now() - Number(rel[1]) * MIN[rel[2]] * 6e4).toISOString();
  }
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString();
}
