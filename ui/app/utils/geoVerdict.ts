// The ONE rule for judging a location — the map, the board and the poster
// must speak the same verdict or the product argues with itself.
//
// Three arms, worst wins — frustration is errors OR slowness:
//
//   ABSOLUTE errors   ≥25% of the location's sessions met an error → bad,
//                     ≥10% → warn. A country where a quarter of sessions
//                     error is frustrated whatever the app average is (the
//                     relative arm alone painted 31% hit green because the
//                     WHOLE app ran at 30%).
//   RELATIVE errors   ≥1.5× / ≥1.15× the application's own rate — who
//                     deviates. Substance-gated: ≥30 sessions, ≥5 errored,
//                     ≥2% rate, because one errored session in 696 was 2.4×
//                     a microscopic base and got a country called frustrated.
//   SPEED             duration-only Apdex over the location's user actions
//                     (T = 3s, apdex.ts): <0.85 warn, <0.50 bad, ≥30 rated
//                     actions. Apdex's error rule is deliberately NOT applied
//                     — errors already have their arms.
export type GeoTone = "good" | "warn" | "bad";

export interface GeoArm {
  sessions: number;
  /** Sessions that met at least one error. */
  hit: number;
  /** Duration-only Apdex bands over user actions (T = 3s). */
  sat: number; tol: number; fru: number;
}

/** The reader's own semantics: satisfied green, tolerating yellow,
 *  frustrated red — everywhere a location is judged. */
export const GEO_WORD = { bad: "frustrated", warn: "tolerating", good: "satisfied" } as const;
export const GEO_COL = { bad: "#ff7a8a", warn: "#e8c34a", good: "#4cc38a" } as const;

export interface GeoArms {
  rate: number; lift: number; apx: number | null;
  rel: number; abs: number; spd: number;
  /** 0 good · 1 warn · 2 bad — the worst arm. */
  level: number;
}

/** The absolute-arm floors, exported so every screen that judges a
 *  location's error share (map, drill rows, board) imports THESE numbers
 *  instead of retyping them. */
export const GEO_ABS_BAD = 0.25;
export const GEO_ABS_WARN = 0.10;
/** Substance gate for the absolute arm — below this many sessions a rate
 *  is an anecdote, not a verdict. */
export const GEO_MIN_SESSIONS = 10;

export const geoArms = (g: GeoArm, base: number): GeoArms => {
  const rate = g.sessions ? g.hit / g.sessions : 0;
  const lift = base > 0 ? rate / base : 0;
  const rated = g.sat + g.tol + g.fru;
  const apx = rated > 0 ? (g.sat + g.tol / 2) / rated : null;
  const rel = g.sessions >= 30 && g.hit >= 5 && rate >= 0.02
    ? (lift >= 1.5 ? 2 : lift >= 1.15 ? 1 : 0) : 0;
  const abs = g.sessions >= GEO_MIN_SESSIONS && rate >= GEO_ABS_BAD ? 2
    : g.sessions >= GEO_MIN_SESSIONS && rate >= GEO_ABS_WARN ? 1 : 0;
  const spd = rated >= 30 && apx !== null
    ? (apx < 0.5 ? 2 : apx < 0.85 ? 1 : 0) : 0;
  return { rate, lift, apx, rel, abs, spd, level: Math.max(rel, abs, spd) };
};

export const geoJudge = (g: GeoArm, base: number): GeoTone =>
  (["good", "warn", "bad"] as const)[geoArms(g, base).level];

/** The threshold that fired, spelled out — a verdict never asks to be taken
 *  on faith. Absolute errors first (the loudest finding), deviation second,
 *  slowness third. */
export const geoBecause = (g: GeoArm, base: number): string => {
  const a = geoArms(g, base);
  const pct = `${(a.rate * 100).toFixed(a.rate >= 0.1 ? 0 : 1)}%`;
  if (a.level === 0) {
    return g.hit === 0
      ? (a.apx !== null && a.apx < 1 ? `no errors · Apdex ${a.apx.toFixed(2)}` : "no session met an error")
      : `${pct} of its sessions met an error — under the 10% tolerating line`;
  }
  if (a.abs === a.level) return a.level === 2
    ? `${pct} of its sessions met an error — frustrated starts at 25%`
    : `${pct} of its sessions met an error — tolerating starts at 10%`;
  if (a.rel === a.level) return a.level === 2
    ? `${a.lift.toFixed(1)}× the app's error rate — frustrated starts at 1.5×`
    : `${a.lift.toFixed(1)}× the app's error rate — tolerating starts at 1.15×`;
  return a.level === 2
    ? `Apdex ${a.apx!.toFixed(2)} — too slow: frustrated starts under 0.50 (T = 3s)`
    : `Apdex ${a.apx!.toFixed(2)} — slow: tolerating starts under 0.85 (T = 3s)`;
};

/** Country name in the reader's language (display) — falls back to the code. */
export const geoName = (() => {
  try {
    const dn = new Intl.DisplayNames([navigator.language, "en"], { type: "region" });
    return (c: string) => dn.of(c) ?? c;
  } catch { return (c: string) => c; }
})();

/** Country name in ENGLISH — the vocabulary observed filter chips speak. */
export const geoEnName = (() => {
  try {
    const dn = new Intl.DisplayNames(["en"], { type: "region" });
    return (c: string) => dn.of(c) ?? c;
  } catch { return (c: string) => c; }
})();
