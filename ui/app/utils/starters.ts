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

/** Overview — one application's health, as its users met it. */
export const OVERVIEW_STARTERS: Starter[] = [
  { label: "What is hurting users most",
    ask: "Across everything measured on this page, what is costing users the "
      + "most right now — and how do you know it is that rather than something "
      + "else on screen?" },
  { label: "Is this app healthy",
    ask: "Judge this application's health for the people using it. Say which "
      + "single number you are leaning on, what it means in plain terms, and "
      + "whether anything on this page contradicts that verdict." },
  { label: "Where are the worst users",
    ask: "Which country, device or connection is having the worst experience "
      + "here, how much worse is it than the rest, and is the gap big enough "
      + "to act on or small enough to be noise?" },
  { label: "What would move the needle",
    ask: "If I could fix one thing on this application this week, what does "
      + "this page say it should be, and roughly how many sessions would it "
      + "touch?" },
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
