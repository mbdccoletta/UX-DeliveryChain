import { scoreTone } from "./verdict";
// The user-experience score — GEN3 ONLY, the platform's own rating.
//
// Every user action in user.events carries `experience.level` (satisfied ·
// tolerating · frustrated), set by an OpenPipeline processor from the
// action's duration against the environment's thresholds, and
// `experience.weight` (default 1). The session's `experience.score` is
// documented (semantic dictionary, user sessions) as
//
//     score = sum(level × weight) / sum(weight)
//     satisfied = 1 · tolerating = 0.5 · frustrated = 0
//
// banded excellent ≥ 0.94 · good ≥ 0.85 · fair ≥ 0.70 · poor ≥ 0.50 ·
// unacceptable below (experience.score.band). This module applies that one
// formula to the weight sums the queries return, at whatever grain they are
// summed — a view, a state, a country, the application. One rule is added on
// top, Marcelo's of 2026-10-23 and Dynatrace's own for actions with reported
// errors: an action that carried an error of its own (error.count /
// has_crash on the action event) counts as frustrated whatever its speed.
// Errors outside any action never enter the score (utils/dql USER_HIT).
//
// It replaced a hand-computed Apdex (RUM Classic: T = 3 s, 4T, an error
// rule), kept out on purpose: a score the reader cannot reconcile with the
// platform's own screens is a number nobody can check. The function names
// below kept their historical `apdex` prefix so call sites did not churn;
// the concept they implement is the experience score.

/** Kept for the one caller that still names a duration; no query uses it. */
export const APDEX_T_MS = 3_000;
export const APDEX_4T_MS = APDEX_T_MS * 4;
export const APDEX_T_NS = APDEX_T_MS * 1e6;
export const APDEX_4T_NS = APDEX_4T_MS * 1e6;

/** How the score reads on screen, wherever it is shown. */
export const APDEX_LABEL = "rated by the platform · experience.level";

export interface ApdexCounts {
  satisfied: number;
  tolerating: number;
  frustrated: number;
}

/** The rated population: the weight the platform rated, nothing else. */
export const apdexRated = (c: ApdexCounts) =>
  c.satisfied + c.tolerating + c.frustrated;

/** The score, or null when nothing in the window was rateable. */
/** THE DYNATRACE STANDARD, NO SAMPLE MINIMUM (Marcelo, 2026-10-23: "seguir
 *  padrão Dynatrace"). The platform computes experience.score whenever at
 *  least one element is rated — no minimum, no small-group mark — and so
 *  does this. Kept as a named constant so the rule is visible in one place. */
export const SCORE_MIN_RATED = 1;
export function apdexOf(c: ApdexCounts): number | null {
  const rated = apdexRated(c);
  return rated >= SCORE_MIN_RATED ? (c.satisfied + c.tolerating / 2) / rated : null;
}

/** The score's arithmetic with this window's own counts, so anyone can redo
 *  it by hand: what was rated, by whom, and how the number falls out. Every
 *  screen that prints the score uses THIS sentence — the hero's word, the
 *  card's stat, the Intelligence facts — so the explanation cannot drift
 *  from the figure. */
export function scoreExplain(c: ApdexCounts & { crashes?: number; errActions?: number;
  /** True when the counts are the platform's experience weights from the
   *  metric store (0.17.0) — its own rating, summed as its Frontends app does. */
  platform?: boolean }): string | null {
  const rated = apdexRated(c);
  if (!rated) return null;
  const v = apdexOf(c) as number;
  const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
  const pc = (n: number) => `${Math.round((n / rated) * 100)}%`;
  if (c.platform) {
    return `Apdex ${fmtApdex(v)} (${apdexBand(v)})\n`
      + `= (satisfied + tolerating ÷ 2) ÷ all rated\n`
      + `= (${fmt(c.satisfied)} + ${fmt(c.tolerating)} ÷ 2) ÷ ${fmt(rated)}\n\n`
      + `The platform's own rating of real people's user actions `
      + `(dt.frontend.experience.weight by experience.level) — the figure Dynatrace's `
      + `Frontends app shows. ${pc(c.satisfied)} satisfied, ${pc(c.tolerating)} tolerating, `
      + `${pc(c.frustrated)} frustrated. Robots and synthetic monitors are left out.\n\n`
      + `Bands: excellent ≥ 0.94 · good ≥ 0.85 · fair ≥ 0.70 · poor ≥ 0.50 · `
      + `unacceptable below.`;
  }
  const crashes = c.crashes ?? 0, errActs = c.errActions ?? 0;
  const actions = rated - crashes;
  return `Experience score ${fmtApdex(v)} (${apdexBand(v)})\n`
    + `= (satisfied + tolerating ÷ 2) ÷ (rated actions + crashes)\n`
    + `= (${fmt(c.satisfied)} + ${fmt(c.tolerating)} ÷ 2) ÷ ${fmt(rated)}\n\n`
    + `RESPONSE TIME AGAINST THE ERRORS THAT HURT. ${fmt(actions)} user actions by `
    + `real people were rated for speed by the platform (experience.level, from the `
    + `action's duration against this environment's thresholds). Counted frustrated `
    + `whatever their speed: ${fmt(errActs)} action${errActs === 1 ? "" : "s"} that `
    + `carried an error of ${errActs === 1 ? "its" : "their"} own, and ${fmt(crashes)} `
    + `crash${crashes === 1 ? "" : "es"} or freeze${crashes === 1 ? "" : "s"} of the app, `
    + `one frustrated element each. In all: ${pc(c.satisfied)} satisfied, `
    + `${pc(c.tolerating)} tolerating, ${pc(c.frustrated)} frustrated. Errors in the `
    + `background, outside any action, do not enter. Robots and synthetic monitors `
    + `are left out.\n\n`
    + `Bands: excellent ≥ 0.94 · good ≥ 0.85 · fair ≥ 0.70 · poor ≥ 0.50 · `
    + `unacceptable below.`;
}

/** The three shares in one line, for the card: what the score is made of. */
export function scoreMix(c: ApdexCounts): string | null {
  const rated = apdexRated(c);
  if (!rated) return null;
  const pc = (n: number) => `${Math.round((n / rated) * 100)}%`;
  const k = rated >= 1e6 ? `${(rated / 1e6).toFixed(1)}M` : rated >= 1e3 ? `${(rated / 1e3).toFixed(1)}K` : `${rated}`;
  return `${pc(c.satisfied)} satisfied · ${pc(c.tolerating)} tolerating · ${pc(c.frustrated)} frustrated · ${k} rated`;
}

/** The platform's bands (experience.score.band), with its own labels. */
export type ApdexBand = "Excellent" | "Good" | "Fair" | "Poor" | "Unacceptable";
export const apdexBand = (v: number): ApdexBand =>
  v >= 0.94 ? "Excellent" : v >= 0.85 ? "Good" : v >= 0.7 ? "Fair"
  : v >= 0.5 ? "Poor" : "Unacceptable";

/**
 * Apdex judges SPEED, never correctness — an application can be fast and
 * broken at the same time, and on a live estate one is: Astroshop-Snow scores
 * 0.969 while every session it served hit an error. So this tone colours the
 * performance cell only; it is deliberately not an input to verdictOf().
 */
/* Delegates to the verdict module (0.17.42): this had its own Critical line at
   0.70 while the status used 0.50, so an Apdex of 0.62 read Warning in the
   header and red on its own figure. One set of thresholds, one file. */
export const apdexTone = (v: number | null): "good" | "warn" | "bad" | "info" =>
  scoreTone(v) ?? "info";

/**
 * Two decimals, the convention the score is always quoted in — except that
 * 1.00 has to MEAN it. easytrade scores 0.998 with 478 tolerating actions, and
 * plain rounding printed that as a perfect 1.00, which is the same lie the
 * error-free percentage used to tell at 99.8%. Anything short of perfect is
 * held at 0.99.
 */
export const fmtApdex = (v: number | null) =>
  /* TRUNCATED, never rounded — the figure must sit in the band its word
     names. Rounded, 0.9399 printed "0.94" beside "Good" while 0.94 is where
     Excellent starts: the number and the word disagreed on one screen. The
     same rule already held at the top (0.998 is never "1.00"). */
  (v === null ? "—" : v < 1 ? (Math.floor(Math.min(v, 0.99) * 100) / 100).toFixed(2) : "1.00");
