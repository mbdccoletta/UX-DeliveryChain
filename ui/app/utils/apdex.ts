// Apdex, computed here because Gen3 does not ship it.
//
// Checked before writing any of this: `apdex` is not a field on user.events
// (none of its 80 fields carries it), there is no Grail metric for it, and the
// classic metrics API answers 403 to this app's token. The settings API — where
// the tenant's own thresholds live — answers 403 too (`settings:objects:read`
// is not in the app's scopes). So the number cannot be read; it has to be
// computed, and the threshold it was computed with has to be stated on screen
// next to it. An Apdex whose T is invisible is a number nobody can check.
//
// THE DEFINITION (Apdex Alliance, the one Dynatrace implements):
//
//     Apdex = (satisfied + tolerating / 2) / rated
//
//   satisfied   duration ≤ T
//   tolerating  T < duration ≤ 4T
//   frustrated  duration > 4T
//
// measured over USER ACTIONS, which is the unit Dynatrace rates — not views and
// not sessions. T is Dynatrace's own default for user actions, 3 s, so this
// app's number matches what the platform would report for a tenant that never
// changed the setting. Where a tenant HAS changed it, ours will differ, which
// is exactly why the label says which T produced it.
//
// One Dynatrace variant is deliberately not implemented: the optional
// "count user actions with errors as frustrated" rule. Measured on this tenant,
// not one of the 195,206 actions in a 24h window reports a non-zero
// `user_action.error_count` — so the rule has nothing to act on, and adding it
// would be a branch that silently never fires.

/** Dynatrace's default tolerated threshold for user actions. */
export const APDEX_T_MS = 3_000;
/** The Apdex spec's frustration boundary: four times T. */
export const APDEX_4T_MS = APDEX_T_MS * 4;
/** Durations arrive in nanoseconds. */
export const APDEX_T_NS = APDEX_T_MS * 1e6;
export const APDEX_4T_NS = APDEX_4T_MS * 1e6;

/** How the threshold reads on screen, wherever the score is shown. */
export const APDEX_LABEL = `T = ${APDEX_T_MS / 1000}s · frustrated over ${APDEX_4T_MS / 1000}s`;

export interface ApdexCounts {
  satisfied: number;
  tolerating: number;
  frustrated: number;
}

/** The rated population: actions that carried a duration, nothing else. */
export const apdexRated = (c: ApdexCounts) =>
  c.satisfied + c.tolerating + c.frustrated;

/** The score, or null when nothing in the window was rateable. */
export function apdexOf(c: ApdexCounts): number | null {
  const rated = apdexRated(c);
  return rated > 0 ? (c.satisfied + c.tolerating / 2) / rated : null;
}

/** The standard rating bands — the same five Dynatrace labels its score with. */
export type ApdexBand = "Excellent" | "Good" | "Fair" | "Poor" | "Unacceptable";
export const apdexBand = (v: number): ApdexBand =>
  v >= 0.94 ? "Excellent" : v >= 0.85 ? "Good" : v >= 0.7 ? "Fair"
  : v >= 0.5 ? "Poor" : "Unacceptable";

/**
 * Apdex judges SPEED, never correctness — an application can be fast and
 * broken at the same time, and on this tenant one is: Astroshop-Snow scores
 * 0.969 while every session it served hit an error. So this tone colours the
 * performance cell only; it is deliberately not an input to verdictOf().
 */
export const apdexTone = (v: number | null): "good" | "warn" | "bad" | "info" =>
  v === null ? "info" : v >= 0.85 ? "good" : v >= 0.7 ? "warn" : "bad";

/**
 * Two decimals, the convention the score is always quoted in — except that
 * 1.00 has to MEAN it. easytrade scores 0.998 with 478 tolerating actions, and
 * plain rounding printed that as a perfect 1.00, which is the same lie the
 * error-free percentage used to tell at 99.8%. Anything short of perfect is
 * held at 0.99.
 */
export const fmtApdex = (v: number | null) =>
  (v === null ? "—" : v < 1 ? Math.min(v, 0.99).toFixed(2) : "1.00");
