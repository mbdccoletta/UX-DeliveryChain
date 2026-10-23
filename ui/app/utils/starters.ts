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
  { label: "What protects users first",
    ask: "Build a prioritised action list to protect the people using this "
      + "application, from the figures supplied and nothing else. Rank by "
      + "real people affected: sessions that met an error, sessions lost to a "
      + "crash or freeze, actions rated frustrated. For each action give: the "
      + "rank, what to do, where (named screen, error, country or state), how "
      + "many real people it protects, who owns it, how quickly it can be done "
      + "(today / this sprint / structural), and the exact number on this page "
      + "that should move when it is done — so it can be checked on the next "
      + "window. Put first whatever protects the most people soonest. Name "
      + "anything that looks alarming but should NOT be escalated (robot "
      + "traffic, third-party noise, a small place) and why." },
  { label: "Raise the experience score",
    ask: "Using only the figures supplied, rank the screens that pull this "
      + "application's experience score down, by the points each one costs "
      + "(the facts give the arithmetic). For the top three: the screen, its "
      + "own score and p90, how many points fixing it would return, and what "
      + "to look at first — the slow requests behind it, its errors, or its "
      + "rendering. Then say what score the application would reach if those "
      + "three were fixed, with the sum shown. If the per-screen figures are "
      + "not loaded, say so and tell me which card to open; do not estimate." },
  { label: "How do I protect the brand",
    ask: "Errors are reaching this application's users. Give an exact, "
      + "prioritised plan to protect the brand, from the figures supplied and "
      + "nothing else. For each action: what to do; where — the named error, "
      + "screen, state or country; who owns it (engineering, product, "
      + "communications or support); how many sessions or real people it "
      + "touches; and how to verify it in Dynatrace — which error name to open "
      + "in the Error Inspector, which Davis problem, which screen's sessions. "
      + "Separate first-party failures from third-party and robot noise and say "
      + "which should NOT be escalated. If real people were hit or made to "
      + "wait, say what the business should tell customers and when; if not, "
      + "say so plainly. Where an action needs a figure this page did not "
      + "measure, name what to open to get it instead of estimating." },
  { label: "What is hurting users most",
    ask: "Across everything measured on this page, what is costing users the "
      + "most right now — and how do you know it is that rather than something "
      + "else on screen?" },
  { label: "Why is this place that colour",
    ask: "Explain the map's verdict for the selected country and its states, "
      + "using the judging rule and the figures supplied. For the country and "
      + "for each state listed: its error rate, how many times this "
      + "application's own rate that is, and which arm fired — deviation, "
      + "speed, or neither. If the country reads as in line while its states "
      + "do not, or the reverse, say precisely what in the rule or the figures "
      + "produces that and whether it is a finding or an artefact. Finish with "
      + "what the absolute rate means for the people using the application, "
      + "independent of the colour, and which single row to open first." },
  { label: "Is this app healthy",
    ask: "Judge this application's health for the people using it. Say which "
      + "single number you are leaning on, what it means in plain terms, and "
      + "whether anything on this page contradicts that verdict." },
  { label: "Where are the worst users",
    ask: "Which country, device or connection is having the worst experience "
      + "here, how much worse is it than the rest, and is the gap big enough "
      + "to act on or small enough to be noise?" },
];

/** Journeys — where people go, and where they stop going. */
export const JOURNEY_STARTERS: Starter[] = [
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
    ask: "Across the layers on this chain, which one is most likely responsible "
      + "for what users are feeling, and what on this page points at it rather "
      + "than at its neighbours?" },
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
