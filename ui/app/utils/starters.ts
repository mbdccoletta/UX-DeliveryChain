// The questions each page is equipped to answer — and what each page IS.
//
// Marcelo, 2026-10-25: "análise criteriosa para todos os prompts da camada
// Intelligence. Precisamos deixar claro o que estamos mostrando, RCAs, como
// melhorar e como prevenir — tudo com base no app."
//
// So every page asks the same four things, in that order, and only from what
// it measured:
//   1. WHAT THIS SHOWS  — the screen explained: sources, rules, samples.
//   2. ROOT CAUSE       — why the figures are what they are, with evidence.
//   3. IMPROVE          — ranked actions, each with an owner and the number
//                         on this page that proves it worked.
//   4. PREVENT          — the Dynatrace guardrail that would have caught it,
//                         tied to the exact metric or field the page reads.
// A page keeps one or two questions of its own after those four. Each page
// also sends PAGE_ABOUT, so the answer can explain the screen instead of
// guessing at it. Asking a page something it cannot prove invites the model
// to fill the gap — the one failure this product refuses.
import type { Starter } from "../components/Intelligence";

/* ── WHAT EACH PAGE IS ──────────────────────────────────────────────────────
   Sent with every question as the first block of context. Static on
   purpose: the rules and sources of a page do not change between windows,
   and the facts beside them carry the numbers. */
export const PAGE_ABOUT = {
  overview:
    "WHAT THIS PAGE IS — the Overview of one RUM application (UX Delivery Chain app).\n"
    + "- Status: the application's Apdex alone, in Dynatrace's bands — Critical under 0.50, "
    + "Warning under 0.85, Healthy otherwise, Not rated when Dynatrace rated no user action.\n"
    + "- Apdex: Dynatrace's own experience rating of real people's user actions "
    + "(dt.frontend.experience.weight by experience.level): (satisfied + tolerating ÷ 2) ÷ all rated. "
    + "When the new RUM rates nothing, the RUM classic rating (builtin:apps.*) is used and says so.\n"
    + "- Sessions, errors (by type, first- vs third-party), requests and 4xx/5xx, user actions: the "
    + "dt.frontend.* metrics — the numbers Dynatrace's Frontends app shows. Sessions are estimates.\n"
    + "- Sessions with errors: the closed sessions Users & Sessions lists (user.sessions).\n"
    + "- Map: each country and each state coloured by its own Apdex, same bands. An opened state "
    + "lists the user actions that cost its Apdex most (runs, Apdex, p50/p90, share of the loss).\n"
    + "- Breakdowns (screens, error names, endpoints) and state reads come from raw user.events "
    + "and may be a sample (marked 1:N): shares, Apdex and percentiles are the sample's, counts are scaled.\n"
    + "- Projections: Dynatrace's forecast analyzer over the same series the charts draw.\n"
    + "- Davis problems are shown as context; they do not set the colour.\n"
    + "- Lines marked SIGNAL are computed by the app: possible measurement artefacts or known "
    + "performance thresholds.",
  chain:
    "WHAT THIS PAGE IS — the Delivery Chain of one RUM application (UX Delivery Chain app).\n"
    + "- The layers a user request crosses, outermost first: users and their origins, network and "
    + "third-party domains, the edge, the services the application calls, their runtime, the "
    + "infrastructure — from Smartscape topology, with services found from the traces the RUM carries.\n"
    + "- Each layer shows a figure and a status from Davis (problems, anomalies, alerts) and from its "
    + "own measurements (service calls, failures, response times from dt.service.* metrics or spans).\n"
    + "- The application's own status is its Apdex (same rule as the Overview).\n"
    + "- NOT MEASURED marks a gap in the evidence, not a finding about the system.",
  journeys:
    "WHAT THIS PAGE IS — the Journeys flow of one RUM application (UX Delivery Chain app).\n"
    + "- Sessions mined into paths of screens (view and navigation names, normalised), drawn as a "
    + "flow from entry to completion or exit.\n"
    + "- Complete = reaching the depth a tenth of the application's own traffic reaches (an app rule).\n"
    + "- On a large application the paths are mined from a settled slice of the window (marked "
    + "\"sample · last N min\"); paths, rankings and shares are the slice's, counts are scaled.\n"
    + "- A picked route narrows every figure to the sessions that walked it.",
  board:
    "WHAT THIS PAGE IS — the Business Control board of one RUM application (UX Delivery Chain app).\n"
    + "- Customers = real people's sessions. Figures for this window against the window of the same "
    + "length before it.\n"
    + "- Protect the brand: customers hit by a failure, made to wait, bounced, lost to a crash.\n"
    + "- Journeys and conversion: the mined journeys, a funnel rung by rung, completion = the "
    + "application's completion depth.\n"
    + "- Cohort figures on a large application are read from a settled slice of each window and "
    + "scaled; shares are the slice's.\n"
    + "- Money appears only if the reader supplied a value per conversion.",
} as const;

/* the four pillars, worded once and reused per page */
const SHOWS = (what: string): Starter => ({
  label: "What am I looking at",
  ask: `Explain this ${what} to someone seeing it for the first time, from the page description `
    + "and the figures supplied only: what each headline number means and where it comes from, "
    + "the rule behind the colours, which figures are samples or estimates, and what the current "
    + "state of this application is in one sentence. Then name the two figures that matter most "
    + "right now and why.",
});

const PREVENT = (what: string, guards: string): Starter => ({
  label: "How to prevent it",
  ask: `From the ${what}'s figures only, how do we stop what it shows from happening again or from `
    + "going unnoticed? For each risk visible here, recommend the Dynatrace guardrail that would "
    + `catch it early, tied to the exact metric or field the page reads — ${guards}. `
    + "Give the threshold to start with, derived from this window's figures (say how), who should "
    + "be notified, and which recurring check proves it is working. Do not recommend a guardrail "
    + "for something this page did not measure.",
});

/** Overview — one application's health, as its users met it. */
export const OVERVIEW_STARTERS: Starter[] = [
  SHOWS("Overview"),
  { label: "Root cause",
    ask: "Do a root-cause analysis of this application's status from the figures supplied. "
      + "Decompose the Apdex loss: which user actions, screens or places cost it most (use the "
      + "points-lost and share-of-loss figures when present). Classify each cause as real slowness, "
      + "errors, or a measurement artefact (any SIGNAL line) and give the evidence for each. Say "
      + "whether the cause is regional or the same everywhere, and whether the chain (Davis "
      + "problems) points elsewhere. If the breakdown needed to name the cause is not open, say "
      + "which card or state to open — do not estimate." },
  { label: "How to improve",
    ask: "Build a ranked improvement plan for this application from the figures supplied and "
      + "nothing else — whether it is red or already green. Rank by Apdex points each item would "
      + "return (frustrated plus half the tolerating, over the application's rated actions; use the "
      + "Headroom line). For each item: what to change; where (the named action, screen, error, "
      + "endpoint, state or country); who owns it (mobile/web engineering, backend, a third party, "
      + "the RUM configuration); today, this sprint or structural; and the number on this page that "
      + "must move to prove it worked. Put instrumentation fixes first when a SIGNAL line shows part "
      + "of the score is an artefact, and show the Apdex the application would reach after the "
      + "top three, with the arithmetic." },
  PREVENT("Overview",
    "an SLO on this frontend's Apdex (dt.frontend.experience.weight), a Davis anomaly detector on "
    + "its error or request-failure counters (dt.frontend.error.count, dt.frontend.request.count by "
    + "status class), alerting on crashes and freezes for a mobile application, a Site Reliability "
    + "Guardian check on release for the actions that cost the most, a synthetic monitor for the "
    + "costliest action or screen, and RUM agent configuration (action naming, completion "
    + "detection) where a SIGNAL line points at instrumentation"),
  { label: "Real or instrumentation",
    ask: "Is this application's Apdex measuring what people experienced, or is part of it an "
      + "artefact of how it is instrumented? Use the SIGNAL lines and the per-action durations: "
      + "actions that all end at one identical long duration, unnamed actions, no rated user "
      + "actions, a rating from RUM classic resting on few actions. For each artefact: what it "
      + "inflates or hides, which agent capability or setting to check, and what the Apdex would "
      + "read without it, shown as arithmetic from the figures. If there is none, say so plainly." },
  { label: "Where are users suffering",
    ask: "Using the places listed, where is the experience worst, and is it regional or the same "
      + "everywhere? Compare each place's Apdex with the application's. If a state is opened, "
      + "explain its colour from its costliest actions and say whether those actions are specific "
      + "to it. Name the one place, if any, that deserves its own investigation." },
  { label: "How do I protect the brand",
    ask: "Errors and slow actions are reaching this application's users. From the figures "
      + "supplied: who is affected and how many real people; first-party failures versus "
      + "third-party requests (do not escalate the latter as ours); crashes and freezes on mobile; "
      + "what to verify in Dynatrace — the error name, the Davis problem, the state's sessions; "
      + "and whether a customer-facing message is warranted and what it should say, judged on "
      + "the projections as well as the current window." },
];

/** Delivery Chain — every layer a request crosses, and which one is at fault. */
export const CHAIN_STARTERS: Starter[] = [
  SHOWS("Delivery Chain"),
  { label: "Root cause",
    ask: "Do a root-cause analysis along this chain from the figures supplied. Start from the "
      + "application's status (its Apdex) and walk the layers outward-in: which layer most likely "
      + "explains what users feel, and what on this page points at it rather than at its "
      + "neighbours — its failures, its response times, a Davis problem or anomaly on it. Name the "
      + "component and its own figures. If no layer is abnormal, say the cause is most likely in "
      + "the client or its instrumentation and point to the Overview's breakdowns." },
  { label: "How to improve",
    ask: "From this chain's figures only, rank the changes that would most improve what users "
      + "feel: the slowest or most failing service, third-party domain, data store or runtime "
      + "element, each with its figures, its owner (team, vendor or platform), and the number on "
      + "this page that must move to prove it worked." },
  PREVENT("Delivery Chain",
    "Davis anomaly detection or SLOs on the named services' response time and failure rate "
    + "(dt.service.request.response_time, dt.service.request.failure_count), alerting on the "
    + "third-party domains users depend on, Site Reliability Guardian checks on release for the "
    + "services in this chain, and capacity alerts on the runtime and hosts shown"),
  { label: "What is not measured here",
    ask: "What does this chain NOT know — layers with no data, links that could not be resolved, "
      + "services found only from topology — how much should that change my trust in the "
      + "root cause, and what instrumentation would close each gap?" },
];

/** Journeys — where people go, and where they stop going. */
export const JOURNEY_STARTERS: Starter[] = [
  SHOWS("Journeys flow"),
  { label: "Root cause",
    ask: "From the flow's figures only, where are people lost and why? Name the screen where the "
      + "biggest loss happens, how many sessions end there, and what the shape of the flow "
      + "suggests — they gave up, they looped, or they were pushed out. Compare the routes that "
      + "finish with the ones that do not: what do the lost share (a screen, a loop, a length)?" },
  { label: "How to improve",
    ask: "Rank the routes on this flow by how much a fix would be worth — sessions lost against "
      + "how fixable the stopping point looks — and for the top three say what to change on which "
      + "screen, who owns it, and which number on this flow must move to prove it worked." },
  PREVENT("Journeys flow",
    "a synthetic monitor that walks the busiest completing route, an alert or SLO on completion "
    + "of the critical path, a Site Reliability Guardian check on release for the screens where "
    + "people stop, and RUM view naming so new screens are not mined as unnamed"),
  { label: "Is any route going in circles",
    ask: "Are any journeys revisiting the same screens instead of progressing? Name the screens, "
      + "how many sessions loop, and what that loop usually means for a user here." },
];

/** Business Control — what the experience is worth, and what failure costs. */
export const BOARD_STARTERS: Starter[] = [
  SHOWS("Business Control board"),
  { label: "Root cause",
    ask: "From this board's figures only, why are customers being lost or hurt? Tie each loss to "
      + "its evidence — a failure, a wait, a crash, a funnel rung — and say which change against "
      + "the previous window is real and which is within noise before drawing a conclusion." },
  { label: "How to improve",
    ask: "From this board's figures only, rank the three actions that would protect or convert "
      + "the most customers this week. For each: the segment or step it targets (named), how many "
      + "real customers it touches, who owns it, and which number on this board must move on the "
      + "next window to prove it worked." },
  PREVENT("Business Control board",
    "an SLO on the conversion or completion of the critical journey, alerts on customers hit by "
    + "failures and on crashes, a synthetic monitor on the funnel's critical path, and a Site "
    + "Reliability Guardian check on release for the rungs that lose the most"),
  { label: "What should I tell my exec",
    ask: "Write the three sentences I would say to an executive about this board — what is "
      + "happening, what it costs, and what I am asking for — using only its figures." },
];
