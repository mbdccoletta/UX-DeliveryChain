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
    + "- OWNERSHIP block: every piece of evidence placed INSIDE the customer's domains (application "
    + "code, its own domain, edge/ingress, services, runtime, hosts), OUTSIDE (third-party domains it "
    + "calls, third-party client errors, the users' devices and networks) or SHARED (the cloud "
    + "provider). The own domain is RUM's first_party tag, or — when that tag is missing — the domain "
    + "whose requests the application's own traces serve.\n"
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

/** Overview — one application's health, as its users met it. Decides: how
 *  bad, for whom, where, getting worse or not, and what to do first. */
export const OVERVIEW_STARTERS: Starter[] = [
  SHOWS("Overview"),
  { label: "Why is the Apdex here",
    ask: "Explain this application's Apdex from the figures supplied. Decompose the loss: which "
      + "user actions, screens or places cost it most (use points-lost and share-of-loss when "
      + "present), and classify each as slowness, errors, or a measurement artefact (any SIGNAL "
      + "line), with its numbers. Say whether it is regional or everywhere, and whether a Davis "
      + "problem on this page points elsewhere. If the breakdown that would name the cause is not "
      + "open, say which card or place to open — do not estimate." },
  { label: "Who is affected and where",
    ask: "How many real people did this window hurt, and where are they? Give the sessions with "
      + "errors (the session-store count, as Users & Sessions lists it) against all sessions, the "
      + "places whose Apdex is below the application's — each with its own Apdex and sessions — and "
      + "an opened place's costliest actions. Separate real people from robots and synthetic "
      + "monitors. End with the one place or action that deserves its own investigation, or say "
      + "that none stands out." },
  { label: "Is it getting worse",
    ask: "From the series and the projections supplied only: is this application's situation "
      + "getting worse, steady or recovering? Use the forecast lines (sessions, errors, error rate) "
      + "and say whether a rise is real or within the projection's band. Give the one number to "
      + "watch in the next window and the value that would change the answer." },
  { label: "How to improve",
    ask: "Build a ranked improvement plan for this application from the figures supplied and "
      + "nothing else — whether it is red or already green. Rank by Apdex points each item would "
      + "return (frustrated plus half the tolerating, over the application's rated actions; use the "
      + "Headroom line). For each item: what to change; where (the named action, screen, error, "
      + "endpoint, state or country); who owns it (mobile/web engineering, backend, a third party, "
      + "the RUM configuration); and the number on this page that must move to prove it worked. Put "
      + "instrumentation fixes first when a SIGNAL line shows part of the score is an artefact, and "
      + "show the Apdex the application would reach after the top three, with the arithmetic." },
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
      + "inflates or hides, which agent setting to check, and what the Apdex would read without it, "
      + "shown as arithmetic. If there is none, say so plainly." },
];

/** Delivery Chain — every layer a request crosses. Decides: is the cause
 *  ours or someone else's, which layer, and whom to call. */
export const CHAIN_STARTERS: Starter[] = [
  SHOWS("Delivery Chain"),
  { label: "Inside or outside our domains",
    ask: "Is what users feel caused INSIDE the customer's domains or OUTSIDE them? Answer from the "
      + "OWNERSHIP block and the layer figures only. Open with one line: Inside, Outside, Shared "
      + "(cloud provider) or Undetermined. Then the evidence for that verdict: first-party versus "
      + "third-party client errors; the own domain's failures and latency against each third-party "
      + "domain's; Davis problems and failing or slow elements in the inside layers (edge, services, "
      + "runtime, hosts) versus the outside ones; anything unattributed. Say which share of the "
      + "failures sits on each side, with the arithmetic. Finish with who to engage — the internal "
      + "team that owns the inside layer, or the vendor of the named third-party domain or cloud — "
      + "and what to hand them. If the evidence cannot separate the sides, say Undetermined and "
      + "name the missing measurement." },
  { label: "Which layer is at fault",
    ask: "Walk the chain from the users inward and name the ONE layer that best explains the "
      + "application's status: its own figures (failures, response times, a Davis problem or "
      + "anomaly), and why its neighbours are not the better explanation. Name the element "
      + "(service, domain, pod, host) and its numbers. If no layer is abnormal, say the cause is "
      + "most likely in the client or its instrumentation and point to the Overview." },
  { label: "Which third party hurts us",
    ask: "Rank the third-party domains this application calls by the harm they do to users: "
      + "failed requests, latency against the own domain, request volume. For each that matters: "
      + "what users lose when it fails or slows, whether it is on the critical path (inferred only "
      + "from volume and timing shown — say so), and what to ask the vendor for. If no third party "
      + "is a factor, say so with the numbers." },
  { label: "How to improve",
    ask: "From this chain's figures only, rank the changes that would most improve what users "
      + "feel: the slowest or most failing service, own or third-party domain, data store or "
      + "runtime element — each with its figures, whether it is inside or outside the customer's "
      + "domains, its owner (team, vendor or platform), and the number on this page that must move "
      + "to prove it worked." },
  PREVENT("Delivery Chain",
    "Davis anomaly detection or SLOs on the named services' response time and failure rate "
    + "(dt.service.request.response_time, dt.service.request.failure_count), synthetic HTTP "
    + "monitors or alerting on the third-party domains users depend on, Site Reliability Guardian "
    + "checks on release for the services in this chain, and capacity alerts on the runtime and "
    + "hosts shown"),
  { label: "What is not measured here",
    ask: "What does this chain NOT know — layers with no data, links that could not be resolved, "
      + "services found only from topology, failures with no domain — how much should that change "
      + "my trust in the inside/outside verdict, and what instrumentation would close each gap?" },
];

/** Journeys — where people go, and where they stop going. Decides: which
 *  screen loses people, whether it is the screen or the content, which fix. */
export const JOURNEY_STARTERS: Starter[] = [
  SHOWS("Journeys flow"),
  { label: "Where do people drop off",
    ask: "From the flow's figures only: name the screen where the most journeys end before "
      + "completing, how many sessions end there and their share of the flow, and the step before "
      + "it. Compare the routes that complete with those that do not: what do the lost ones share "
      + "— a screen, a loop, a length? Do not explain the why beyond what the figures show." },
  { label: "Screen or content",
    ask: "For the screens where people stop, is the cause technical or is it what the page asks "
      + "of them? Use only what the flow and its route portraits supply: the stopping screens' "
      + "timing against the application's median, errors on them, abandoned or timed-out actions "
      + "on the moves into them. Give the verdict per screen with its numbers, and when the "
      + "figures cannot tell, say which portrait to open." },
  { label: "Which route to fix first",
    ask: "Rank the routes on this flow by how much a fix would be worth — sessions lost against "
      + "how fixable the stopping point looks — and for the top three say what to change on which "
      + "screen, who owns it, and which number on this flow must move to prove it worked." },
  { label: "Is any route going in circles",
    ask: "Are any journeys revisiting the same screens instead of progressing? Name the screens, "
      + "how many sessions loop, and what that loop usually means for a user here." },
  PREVENT("Journeys flow",
    "a synthetic monitor that walks the busiest completing route, an alert or SLO on completion "
    + "of the critical path, a Site Reliability Guardian check on release for the screens where "
    + "people stop, and RUM view naming so new screens are not mined as unnamed"),
];

/** Business Control — what the experience is worth, and what failure costs.
 *  Decides: what it cost, whether the change is real, which segment, what to ask for. */
export const BOARD_STARTERS: Starter[] = [
  SHOWS("Business Control board"),
  { label: "What did failures cost",
    ask: "From this board's figures only: how many real customers were hit by a failure, made to "
      + "wait, bounced or lost to a crash — each against the previous window — and where the funnel "
      + "loses them (the rung that loses the most, with its count). Put money on it only if a value "
      + "per conversion was supplied. Show the arithmetic, and say which figures are a sample and "
      + "scaled. Do not compute a conversion gap the figures do not contain." },
  { label: "Inside or outside our systems",
    ask: "Is what hurts these customers inside the customer's systems or outside them? Use the "
      + "INSIDE OR OUTSIDE THE BACKEND block only: the share of waiting spent on the server versus "
      + "the network and the device, errors by origin (backend and own frontend code inside; third "
      + "party, device, connection outside), whether failure concentrates in one segment (points "
      + "outside: a carrier, a device, a region) or hits everyone alike (points inside), and the "
      + "Davis problems on the chain. Open with one line — Inside, Outside or Undetermined — then "
      + "the evidence with its numbers, and who to engage." },
  { label: "Real change or noise",
    ask: "Compare this window with the previous one figure by figure. For each change, say "
      + "whether it is large enough to be real given the sizes involved (state the sizes), or "
      + "within noise, before drawing any conclusion. Then name the one change that deserves "
      + "action, or say that nothing moved." },
  { label: "Which segment is hurting",
    ask: "Which country, operating system, browser, device type or user type has the worst "
      + "experience on this board relative to the rest — its own failure share or completion "
      + "against the application's, with its customer count? Name at most three, and say whether "
      + "the difference is large enough to act on." },
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
