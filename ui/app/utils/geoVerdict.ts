// The ONE rule for judging a location — the map, the board and the poster
// must speak the same verdict or the product argues with itself.
//
// Two arms colour a location, worst wins — deviation OR slowness. A third is
// computed and PRINTED but does not colour:
//
//   ABSOLUTE errors   ≥25% / ≥10% of the location's sessions met an error.
//                     This WAS a colouring arm, added because the relative
//                     arm alone painted 31% hit green on an app that ran at
//                     30% overall. It was demoted on a bank's production
//                     application whose own baseline is 52%: every country
//                     cleared 25%, every pin was red, and the map said the
//                     same thing about everywhere — nothing. The rate is
//                     still stated on every row; it is no longer the colour.
//                     The trade-off is real and stated: a place that is
//                     absolutely bad but no worse than its application reads
//                     as "in line" here, and as bad on the application card.
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

/* THE MAP WAS THE ONE PLACE STILL PAINTING ITS OWN STATUS COLOURS.
 * Everything else in this app reads --good / --warn / --bad, which bind to
 * Strato's text-success, text-warning and text-critical tokens — so the whole
 * screen flips with the shell and uses the platform's three families. The map
 * paints on a canvas, which cannot read a CSS variable, and so had three
 * literals of its own: #4cc38a, #e8c34a, #ff7a8a. The middle one is a plain
 * yellow and belongs to no Dynatrace family at all; next to a warning pill
 * drawn from the token it is simply a different colour for the same verdict.
 *
 * So the canvas resolves the tokens instead of guessing them. The fallback
 * hexes below are Strato's own dark-theme values, kept for standalone dev
 * where no shell injects anything. */
export const GEO_COL = { bad: "#c82d40", warn: "#eea746", good: "#5eb1a9" } as const;

/** The three verdict tones as the live theme resolves them, for the canvas.
 *  Reading them off a probe rather than the custom property keeps the result
 *  an rgb() string whatever the token happens to contain. */
export function geoCol(): { bad: string; warn: string; good: string } {
  if (typeof document === "undefined" || !document.body) return { ...GEO_COL };
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none";
  document.body.appendChild(probe);
  const read = (name: string, fb: string) => {
    probe.style.color = "";
    probe.style.color = `var(${name})`;
    const c = getComputedStyle(probe).color;
    /* an unresolved var leaves the colour at its initial value, and a fully
       transparent mark would silently erase the location from the map */
    return c && c !== "rgba(0, 0, 0, 0)" ? c : fb;
  };
  const out = {
    bad: read("--bad-fill", GEO_COL.bad),
    warn: read("--warn-fill", GEO_COL.warn),
    good: read("--good-fill", GEO_COL.good),
  };
  probe.remove();
  return out;
}

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
  /* THE ABSOLUTE ERROR LINE NO LONGER COLOURS THE MAP.
   *
   * On an application whose own baseline is 52% of sessions meeting an
   * error, every country clears a 25% line and every pin is red — the map
   * says nothing, because it says the same thing about everywhere. "Senão
   * fica tudo vermelho." A pin answers WHERE the worst users are, and
   * "worse than this application usually is" (the deviation arm) and
   * "slow" (the Apdex arm) are the two things that vary by place. The
   * absolute rate is still printed on every row; it just stopped being the
   * colour. One rule, shared by the pins and the rows. */
  return { rate, lift, apx, rel, abs, spd, level: Math.max(rel, spd) };
};

export const geoJudge = (g: GeoArm, base: number): GeoTone =>
  (["good", "warn", "bad"] as const)[geoArms(g, base).level];

/** A STATE OR A CITY IS JUDGED BY THE SAME RULE AS ITS COUNTRY.
 *
 *  Measured on a bank's production application: Brazil green — 84.7% of
 *  its sessions met an error, which is exactly that application's own rate,
 *  so "in line" — and every one of its 27 states red, because the states
 *  were still coloured by the absolute 25% line the countries had dropped.
 *  Same fact, two rules, one screen: the map argued with itself. The
 *  sub-national rows carry sessions and hits but no Apdex bands, so only
 *  the deviation arm can fire here; the speed arm simply has nothing to
 *  rate, which is the truth, not a different threshold. */
export const geoJudgeSub = (r: { sessions: number; hit: number }, base: number): GeoTone =>
  geoJudge({ sessions: r.sessions, hit: r.hit, sat: 0, tol: 0, fru: 0 }, base);
export const geoBecauseSub = (r: { sessions: number; hit: number }, base: number): string =>
  geoBecause({ sessions: r.sessions, hit: r.hit, sat: 0, tol: 0, fru: 0 }, base);

/** The threshold that fired, spelled out — a verdict never asks to be taken
 *  on faith. Deviation from the application's own rate first, slowness
 *  second; the absolute rate is stated but is not a threshold here. */
/** "1 session" / "4 sessions" — the gate's own count, in words that agree. */
const fmtCount = (n: number) => `${n} session${n === 1 ? "" : "s"}`;

export const geoBecause = (g: GeoArm, base: number): string => {
  const a = geoArms(g, base);
  const pct = `${(a.rate * 100).toFixed(a.rate >= 0.1 ? 0 : 1)}%`;
  if (a.level === 0) {
    if (g.hit === 0) {
      return a.apx !== null && a.apx < 1
        ? `no errors · Apdex ${a.apx.toFixed(2)}` : "no session met an error";
    }
    /* A GATE IS NOT A THRESHOLD. Level 0 has two very different causes: the
       rate really is below the line, or there were too few sessions to judge
       it at all. Saying "under the 10% tolerating line" for the second was
       a false claim about a measurement — one errored session out of four
       reads 25%, and the sentence insisted that was under ten. Now the gate
       says it is a gate. */
    if (g.sessions < GEO_MIN_SESSIONS && a.rate >= GEO_ABS_WARN) {
      return `${pct} of its sessions met an error, but ${fmtCount(g.sessions)}`
        + ` is too few to judge — a verdict needs ${GEO_MIN_SESSIONS}`;
    }
    return `${pct} of its sessions met an error — in line with this application`
      + (a.apx !== null ? ` · Apdex ${a.apx.toFixed(2)}` : "");
  }
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
