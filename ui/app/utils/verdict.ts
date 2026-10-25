// One verdict, one definition, every screen.
//
// Before this file each screen judged health in its own inline expression: the
// overview coloured by sessions hit, the delivery chain coloured only by Davis
// signals. So an application whose every session hit an error rendered a red
// 0% on the landing page and a calm green chain — both "right", and together a
// contradiction the reader has to resolve alone.
//
// The rule now lives here: an application is judged by BOTH what was detected
// (Davis problems, baselining anomalies, custom alerts) and what was measured
// (the share of sessions that hit an error). Measured harm is a signal too —
// a 404 storm that never crosses an alerting threshold still ruined every
// session, and the chain must say so.
//
// Thresholds are named constants, stated once, so no screen can drift.

import { apdexBand, fmtApdex } from "./apdex";

export type Tone = "good" | "warn" | "bad" | "info";

/** Sessions hit by an error, as a share of sessions in the window. */
export const HIT_BAD = 0.5;
export const HIT_WARN = 0.1;
/** The experience score's own bands (utils/apdex apdexBand): Fair and Poor
 *  — under 0.85 — are Warning; Unacceptable — under 0.50 — is Critical. */
export const SCORE_WARN = 0.85;
export const SCORE_BAD = 0.5;
/** A score on the verdict's lines, or null when nothing was rated. */
export const scoreTone = (s: number | null | undefined): "good" | "warn" | "bad" | null =>
  s === null || s === undefined ? null : s < SCORE_BAD ? "bad" : s < SCORE_WARN ? "warn" : "good";

/**
 * The platform's status words. Every Gen3 app labels state with these, so this
 * app does too — the internal tone keys stay good/warn/bad because the CSS is
 * written against them, but nothing user-facing says "bad".
 */
export const STATUS_LABEL: Record<Tone, string> = {
  good: "Healthy", warn: "Warning", bad: "Critical", info: "Not rated",
};

/** Davis problem categories, in the platform's own vocabulary. */
export const davisCategory = (c?: string | null): string =>
  (c ?? "").replace(/_/g, " ").toLowerCase().replace(/^./, (s) => s.toUpperCase())
  || "Problem";

export interface VerdictInput {
  /** An APPLICATION's status: judged on its Apdex alone (Marcelo,
   *  2026-10-24: "o status da aplicação e mapa devem ser baseados no Apdex").
   *  Davis problems and the rest are still printed beside it, never colour it.
   *  Components (services, hosts, origins) keep the other signals. */
  apdexOnly?: boolean;
  /** Active Davis problems on this element. */
  problems?: number;
  /** Their Davis categories — availability, error, slowdown, resource… */
  categories?: Array<string | null | undefined>;
  /** Baselining anomalies and custom alerts on this element. */
  anomalies?: number;
  /** Sessions in the window — the denominator. Omit when unmeasured. */
  sessions?: number | null;
  /** Sessions that hit at least one error. */
  hit?: number | null;
  /**
   * The same two counts restricted to REAL people — robots and synthetic
   * monitors excluded. When present these decide the verdict, because a
   * failure nobody experienced is not the same finding as one they did.
   */
  realSessions?: number | null;
  realHit?: number | null;
  /** The error RATE (errors per user action) is projected to rise with
   *  certainty: the forecast's lower bound ends above the measured level.
   *  See riseIsReal in utils/forecast. */
  forecastRising?: boolean;
  /** The experience score — response time against the errors that hurt
   *  (see utils/apdex) — or null/absent when nothing was rated. */
  score?: number | null;
}

/** Which rule decided — so a screen can say whether the verdict has a
 *  PLACE (errors, score: the map can show where) or not (problems, anomalies,
 *  forecast: a trend or a component, not a location). */
export type VerdictCause = "machines" | "problems" | "hit" | "score" | "anomalies"
  | "forecast" | "none" | "healthy";

export interface Verdict {
  tone: Tone;
  /** The platform's status word: Critical · Warning · Healthy. */
  label: string;
  /** The single fact that decided the colour, phrased for a reader. */
  reason: string;
  /** hit / sessions, or null when the impact was not measured. */
  hitRate: number | null;
  /** The rule that decided. */
  cause?: VerdictCause;
}

/** The forecast's reason, worded once. */
export const FORECAST_REASON = "error rate forecast to rise";

const pct = (r: number) => `${r >= 0.995 ? 100 : Math.floor(r * 100)}%`;

/**
 * The worst true statement wins, and the verdict carries which one it was —
 * so every screen can show not just the colour but the sentence behind it.
 */
export function verdictOf(v: VerdictInput): Verdict {
  const { problems = 0, anomalies = 0, forecastRising = false } = v;
  /* NOT ONLY ERROR-FREE (Marcelo, 2026-10-23). The share of sessions an
     error affected says who was hurt; the experience score says how the
     actions went — response time against the errors that hurt. Both judge,
     in the score's own bands: under 0.85 is Fair or worse (Warning), under
     0.70 Poor or worse (Critical). Before, the score was kept out of the
     verdict on purpose, and an application whose actions were all frustrated
     could read Healthy because few sessions had errors. */
  const score = v.score ?? null;
  const scoreTxt = score === null ? "" : `Apdex ${fmtApdex(score)} (${apdexBand(score).toLowerCase()})`;
  const sessions = v.sessions ?? 0;
  const hit = v.hit ?? 0;
  /* ── who actually felt it ──
   * Measured on a live estate: two applications report 100% of sessions hit by
   * errors and have not one human user between them — every session is a robot
   * or a synthetic monitor. Judging those "Critical" put them at the top of the
   * estate table and pushed the one application with 24,491 real users and
   * 9,962 of them hitting errors to the bottom. The verdict now reads the
   * population that can actually be harmed; test traffic is reported, never
   * ranked as user impact.
   */
  const realSessions = v.realSessions ?? null;
  const realHit = v.realHit ?? 0;
  const humansMeasured = realSessions !== null && realSessions > 0;
  const hitRate = humansMeasured ? realHit / realSessions
    : sessions > 0 ? hit / sessions : null;
  const of = humansMeasured ? "of real-user sessions" : "of sessions";
  const say = (tone: Tone, reason: string, label?: string, cause?: VerdictCause): Verdict =>
    ({ tone, label: label ?? STATUS_LABEL[tone], reason, hitRate, cause });

  if (v.apdexOnly) {
    if (score === null) return say("info", "no Apdex in this window", "Not rated", "none");
    const tone = scoreTone(score) as Tone;
    return say(tone, scoreTxt, undefined, tone === "good" ? "healthy" : "score");
  }

  // No people in this window at all: the errors are real but nobody met them.
  // Worth saying out loud, never worth outranking an application that is
  // hurting its actual users.
  const onlyMachines = realSessions !== null && realSessions === 0 && sessions > 0;
  if (onlyMachines && problems === 0 && anomalies === 0) {
    // Neutral, not amber. Amber here competed with applications that are
    // actually hurting people — every application in the estate went warning
    // at once and the colour stopped ranking anything. The breakage is still
    // reported, in the sentence, where it cannot be mistaken for user harm.
    // "Not measured" would be a lie — the impact WAS measured, and it is zero
    // people. The label says exactly that.
    const machineRate = hit / sessions;
    return say("info", machineRate > 0
      ? `no real users here · ${pct(machineRate)} of test traffic hit`
      : "no real users in this window", "No users", "machines");
  }

  if (problems > 0) {
    // named the way the platform names them, so the word here and the word on
    // the Problems app are the same word
    const cats = [...new Set((v.categories ?? []).filter(Boolean)
      .map((c) => davisCategory(c)))].slice(0, 2);
    return say("bad", `${problems} active problem${problems > 1 ? "s" : ""}`
      + (cats.length ? ` · ${cats.join(", ")}` : ""), undefined, "problems");
  }

  /* ONLY THE PLATFORM'S SIGNALS DECIDE (Marcelo, 2026-10-24). The share of
     sessions with errors judged too — on lines (10%, 50%) that were this
     app's, not Dynatrace's, over the sessions the store had CLOSED: six of
     fifteen turned an application of 166 sessions amber. Now: an open Davis
     problem, a Davis anomaly or alert, and Dynatrace's own experience score
     in its own bands. The share is still measured and printed; it no longer
     colours anything. */
  if (score !== null && score < SCORE_BAD)
    return say("bad", scoreTxt, undefined, "score");

  if (anomalies > 0)
    return say("warn", `${anomalies} anomal${anomalies > 1 ? "ies" : "y"} detected`, undefined, "anomalies");

  if (score !== null && score < SCORE_WARN)
    return say("warn", scoreTxt, undefined, "score");

  void forecastRising; // a projection is shown beside the facts, never judges

  if (hitRate === null && score === null && sessions === 0)
    return say("info", "no impact measured in this window", undefined, "none");

  /* Healthy says BOTH halves: who was unaffected, and how the actions went */
  const unaffected = hitRate === null ? ""
    : hitRate > 0 ? `${pct(1 - hitRate)} ${of} unaffected`
    : humansMeasured ? "no real user affected by an error" : "no session affected by an error";
  return say("good", ["no Davis problems", scoreTxt, unaffected].filter(Boolean).join(" · "),
    undefined, "healthy");
}

/** The failure-rate cell in any table, judged by the same two thresholds. */
export const hitTone = (rate: number | null): Tone =>
  rate === null ? "info" : rate >= HIT_BAD ? "bad" : rate >= HIT_WARN ? "warn" : "good";

/** Ordering used when a container must wear its worst child's verdict. */
export const WORST: Record<Tone, number> = { good: 0, info: 1, warn: 2, bad: 3 };
export const worseOf = (a: Tone, b: Tone): Tone => (WORST[b] > WORST[a] ? b : a);

/** The legend every screen prints, so the thresholds are never hidden. */
export const VERDICT_LEGEND =
  `Critical = an active Davis problem, or Dynatrace's experience score under ${SCORE_BAD.toFixed(2)} (unacceptable) · `
  + `Warning = a Davis anomaly or alert, or an experience score under ${SCORE_WARN.toFixed(2)} (fair or poor) · `
  + `Healthy = neither · sessions with errors are measured and shown, never judged`;

/**
 * How a FAILURE RATE on requests is judged — one rule, one home.
 *
 * This lived as bare literals in two components: the Overview's request card
 * (`reqRate >= 0.01 ? "bad" : reqRate >= 0.001 ? "warn"`) and the chain's
 * throughput tile, whose own comment said it was keeping "one failure-rate
 * rule with the overview card" — an admission that the rule was copied rather
 * than shared. Two copies of a threshold is how two screens start disagreeing
 * about the same application.
 *
 * The thresholds themselves are unchanged and were chosen deliberately: one
 * failure in a million should not wear a warning, so the floor sits at a tenth
 * of a percent and the alarm at one percent.
 */
export const FAIL_BAD = 0.01;
export const FAIL_WARN = 0.001;

export const failTone = (rate: number | null | undefined): Tone =>
  rate === null || rate === undefined ? "info"
  : rate >= FAIL_BAD ? "bad"
  : rate >= FAIL_WARN ? "warn"
  : "good";

/** The same rule, said in words, for a tooltip or a legend. */
export const FAIL_LEGEND =
  `Failing calls: Critical at ≥${FAIL_BAD * 100}%, Warning at ≥${FAIL_WARN * 100}%`;

/**
 * Fewest measured journeys before a screen states a SHARE, a percentage or a
 * superlative ("biggest loss", "worst screen").
 *
 * Below it the arithmetic still works and means nothing: on a live estate
 * an application with four journeys was being shown a funnel with "25%", "50%"
 * and a named biggest loss of two sessions. The pictures still draw — they
 * portray what happened and are honest at any size — but the ratios wait for a
 * population.
 *
 * It lives here because two screens describing one application must not
 * disagree about when a number becomes sayable; it was briefly FUNNEL_MIN in
 * the board and FLOW_MIN in the journeys page, which is how that drift starts.
 */
export const SAMPLE_MIN = 30;

/**
 * Is this application MOBILE? The platform's own word first — Smartscape's
 * frontend.type ("web" | "mobile") — and the classic entity prefix only when
 * the platform gave no type. Crashes, ANRs and every "lost to a crash" figure
 * are mobile facts and are shown only where this is true (Marcelo, 2026-10-23).
 */
export const isMobileApp = (a?: { kind?: string; entity?: string } | null): boolean =>
  a?.kind ? a.kind === "mobile" : !!a?.entity?.startsWith("MOBILE_APPLICATION-");
