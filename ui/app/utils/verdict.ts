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

export type Tone = "good" | "warn" | "bad" | "info";

/** Sessions hit by an error, as a share of sessions in the window. */
export const HIT_BAD = 0.5;
export const HIT_WARN = 0.1;

/**
 * The platform's status words. Every Gen3 app labels state with these, so this
 * app does too — the internal tone keys stay good/warn/bad because the CSS is
 * written against them, but nothing user-facing says "bad".
 */
export const STATUS_LABEL: Record<Tone, string> = {
  good: "Healthy", warn: "Warning", bad: "Critical", info: "Not measured",
};

/** Davis problem categories, in the platform's own vocabulary. */
export const davisCategory = (c?: string | null): string =>
  (c ?? "").replace(/_/g, " ").toLowerCase().replace(/^./, (s) => s.toUpperCase())
  || "Problem";

export interface VerdictInput {
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
  /** The analyzer projects errors rising over the horizon. */
  forecastRising?: boolean;
}

export interface Verdict {
  tone: Tone;
  /** The platform's status word: Critical · Warning · Healthy. */
  label: string;
  /** The single fact that decided the colour, phrased for a reader. */
  reason: string;
  /** hit / sessions, or null when the impact was not measured. */
  hitRate: number | null;
}

const pct = (r: number) => `${r >= 0.995 ? 100 : Math.floor(r * 100)}%`;

/**
 * The worst true statement wins, and the verdict carries which one it was —
 * so every screen can show not just the colour but the sentence behind it.
 */
export function verdictOf(v: VerdictInput): Verdict {
  const { problems = 0, anomalies = 0, forecastRising = false } = v;
  const sessions = v.sessions ?? 0;
  const hit = v.hit ?? 0;
  /* ── who actually felt it ──
   * Measured on this tenant: two applications report 100% of sessions hit by
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
  const say = (tone: Tone, reason: string, label?: string): Verdict =>
    ({ tone, label: label ?? STATUS_LABEL[tone], reason, hitRate });

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
      : "no real users in this window", "No users");
  }

  if (problems > 0) {
    // named the way the platform names them, so the word here and the word on
    // the Problems app are the same word
    const cats = [...new Set((v.categories ?? []).filter(Boolean)
      .map((c) => davisCategory(c)))].slice(0, 2);
    return say("bad", `${problems} active problem${problems > 1 ? "s" : ""}`
      + (cats.length ? ` · ${cats.join(", ")}` : ""));
  }

  if (hitRate !== null && hitRate >= HIT_BAD)
    return say("bad", `${pct(hitRate)} ${of} hit by errors`);

  if (anomalies > 0)
    return say("warn", `${anomalies} anomal${anomalies > 1 ? "ies" : "y"} detected`);

  if (hitRate !== null && hitRate >= HIT_WARN)
    return say("warn", `${pct(hitRate)} ${of} hit by errors`);

  if (forecastRising)
    return say("warn", "errors forecast to rise");

  if (hitRate === null)
    return say("info", "no impact measured in this window");

  return say("good", hitRate > 0
    ? `${pct(1 - hitRate)} ${of} error-free`
    : humansMeasured ? "no real user hit by an error" : "no session hit by an error");
}

/** The failure-rate cell in any table, judged by the same two thresholds. */
export const hitTone = (rate: number | null): Tone =>
  rate === null ? "info" : rate >= HIT_BAD ? "bad" : rate >= HIT_WARN ? "warn" : "good";

/** Ordering used when a container must wear its worst child's verdict. */
export const WORST: Record<Tone, number> = { good: 0, info: 1, warn: 2, bad: 3 };
export const worseOf = (a: Tone, b: Tone): Tone => (WORST[b] > WORST[a] ? b : a);

/** The legend every screen prints, so the thresholds are never hidden. */
export const VERDICT_LEGEND =
  `Critical = an active Davis problem, or ≥${HIT_BAD * 100}% of sessions hit by errors · `
  + `Warning = an anomaly, a rising forecast, or ≥${HIT_WARN * 100}% of sessions hit · `
  + `Healthy = neither`;
