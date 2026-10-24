// The questions each page is equipped to answer.
//
// A generic "explain this" gets a generic answer. These are written per page,
// against what that page actually measures — the Journeys board knows where
// people stop but nothing about runtime; the chain knows which layer is slow
// but not what it costs the business. Asking a page something it cannot prove
// invites the model to fill the gap, which is the one failure this product
// refuses.
//
// Phrased as a reader speaks: short on the chip, precise in the question.
import type { Starter } from "../components/Intelligence";

/** Overview — one application's health, as its users met it. Action first:
 *  the three that end in a ranked list of things to do lead the row. "What
 *  would move the needle" was retired — the two ranking questions answer it
 *  with the points and the people behind each action. */
export const OVERVIEW_STARTERS: Starter[] = [
  /* REWRITTEN FOR THE APDEX PAGE (0.17.20, Marcelo: "reavaliar todos os
     prompts para coletar contexto do app e gerar valor"). The status is the
     Apdex alone, places carry their own Apdex, an opened state carries the
     actions that cost it, and the facts flag measurement artefacts. Each
     question now ends in something a team can do and a number that proves
     it was done. */
  { label: "Why is it this colour",
    ask: "Explain this application's status from the figures supplied. Give the "
      + "Apdex and its band, then decompose the loss: which actions, screens or "
      + "places cost it most (use the points-lost and share-of-loss figures when "
      + "present). Separate three causes explicitly — real slowness people felt, "
      + "errors, and measurement artefacts (any SIGNAL line: a timeout ceiling, "
      + "unnamed actions, a classic-RUM rating resting on few actions). Finish "
      + "with the single number that would change the colour and by how much." },
  { label: "Real or instrumentation",
    ask: "Is this application's Apdex measuring what people experienced, or is "
      + "part of it an artefact of how it is instrumented? Use the SIGNAL lines "
      + "and the per-action durations: actions that all end at one identical "
      + "long duration, unnamed actions, no rated user actions, or a rating from "
      + "RUM classic resting on few actions. For each artefact: what it inflates "
      + "or hides, which Dynatrace setting or agent capability to check (user "
      + "action naming, completion detection for the named screens, app-start "
      + "definition), and what the Apdex would read without it, shown as "
      + "arithmetic from the figures. If there is no artefact, say so plainly." },
  { label: "What to fix first",
    ask: "Build a ranked action list for this application from the figures "
      + "supplied and nothing else. Rank by how much of the Apdex loss each item "
      + "explains, then by real people touched. For each item: what to do; where "
      + "— the named action, screen, error, endpoint, state or country; who owns "
      + "it (mobile/web engineering, backend, a third party, the RUM "
      + "configuration); today, this sprint or structural; and the exact number "
      + "on this page that must move to prove it worked. Put instrumentation "
      + "fixes first when a SIGNAL line shows the score is partly an artefact." },
  { label: "Where are users suffering",
    ask: "Using the places listed, where is the experience worst, and is it a "
      + "regional problem or the same everywhere? Compare each place's Apdex "
      + "with the application's. If a state is opened, explain its colour from "
      + "its costliest actions and say whether those actions are specific to it "
      + "or would explain every state. Say which place, if any, deserves its own "
      + "investigation and which do not." },
  { label: "How do I protect the brand",
    ask: "Errors and slow actions are reaching this application's users. Give "
      + "an exact plan to protect the brand from the figures supplied: who is "
      + "affected and how many real people; first-party failures versus "
      + "third-party requests (do not escalate the latter as ours); crashes and "
      + "freezes on mobile; what to verify in Dynatrace — which error name in "
      + "the Error Inspector, which Davis problem, which state's sessions; and "
      + "whether a customer-facing message is warranted, and what it should "
      + "say. Where a figure was not measured, name what to open instead." },
  { label: "What happens next",
    ask: "From the projections supplied (sessions, errors, requests, each from "
      + "Dynatrace's forecast analyzer), what should the team expect over the "
      + "next period? Say which projection is rising, how much, whether that "
      + "rise is more people (sessions) or more failure per person, and what "
      + "to watch so the status does not degrade. Say plainly when a "
      + "projection was not sound." },
];

/** Journeys — where people go, and where they stop going. */
export const JOURNEY_STARTERS: Starter[] = [
  /* when the tab reads a slice of the window (marked "sample · last N
     min"), paths and shares are that slice's and counts are scaled */
  { label: "Where do people drop",
    ask: "Where in this flow are people lost, which screen are they on when it "
      + "happens, and does the shape of the diagram suggest they gave up or "
      + "were pushed out?" },
  { label: "What do the lost have in common",
    ask: "Look at the routes that do not finish. What do they share — a screen, "
      + "a loop, a length — that the finishing routes do not?" },
  { label: "Is any route going in circles",
    ask: "Are any journeys here revisiting the same screens instead of "
      + "progressing? If so, name the screens and say what that loop usually "
      + "means for a user." },
  { label: "Which path should I fix first",
    ask: "Rank the routes on this diagram by how much a fix would be worth — "
      + "volume lost against how fixable the stopping point looks — and say "
      + "which you would take first." },
];

/** Business Control — what the experience is worth, and what failure costs. */
export const BOARD_STARTERS: Starter[] = [
  { label: "What is failure costing",
    ask: "In business terms, what is this board saying failure costs — who is "
      + "affected, how many, and over what window?" },
  { label: "Where does the funnel leak",
    ask: "Which rung of this funnel loses the most people, what screen are they "
      + "on, and is that loss large enough to be a finding rather than normal "
      + "attrition?" },
  { label: "Is conversion really moving",
    ask: "Has conversion genuinely changed against the previous window, or is "
      + "the difference within what this sample can distinguish? Be explicit "
      + "about which it is." },
  { label: "What should I tell my exec",
    ask: "Write the three sentences I would say to an executive about this "
      + "board: what is happening, what it costs, and what I am asking for." },
  { label: "Where to act first",
    ask: "From this board's figures only, rank the three actions that would "
      + "protect the most customers this week. For each: the segment or step "
      + "it targets (named), how many real customers it touches, whether they "
      + "were hit by a failure, made to wait or lost to a crash, who owns it, "
      + "and which number on this board must move on the next window to prove "
      + "it worked. Say which change in the comparison with the previous "
      + "window is real and which is within noise before ranking on it." },
  { label: "How do I protect the brand",
    ask: "From this board's figures only, give the exact actions that protect "
      + "the brand this week: who is affected and how many; which failure to "
      + "fix first and why that one; who owns each action; what the "
      + "customer-facing message should say — and whether one is warranted at "
      + "all — if customers were hit by a failure, made to wait, or lost to a "
      + "crash; and which number on this board proves each action worked when "
      + "the board is read again next window. Say plainly when a figure was "
      + "not measurable rather than filling it." },
];

/** Delivery Chain — every layer a request crosses, and which one is at fault. */
export const CHAIN_STARTERS: Starter[] = [
  { label: "Which layer is at fault",
    ask: "This application's status is its Apdex. Across the layers on this "
      + "chain, which one most likely explains what users are feeling — the "
      + "network and third-party domains, the edge, the services, the runtime, "
      + "or the client itself — and what on this page points at it rather than "
      + "at its neighbours? Name the component, its own figures, and the Davis "
      + "problem or anomaly on it if there is one. If nothing on the chain is "
      + "abnormal, say the cause is likely in the client or its instrumentation." },
  { label: "Where do I start an RCA",
    ask: "I am starting a root-cause investigation from this chain. Give me the "
      + "first three things to check, in order, and say what each would rule in "
      + "or out." },
  { label: "What is the weakest link",
    ask: "Which single component here carries the most risk for users — by "
      + "slowness, errors, or by having no redundancy visible — and why that "
      + "one?" },
  { label: "What is not measured here",
    ask: "What does this chain NOT know about — layers with no data, links that "
      + "could not be resolved — and how should that change how much I trust "
      + "the picture?" },
];
