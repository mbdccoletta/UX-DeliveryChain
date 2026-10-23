// The ONE rule for judging a location — the map, the board and the poster
// must speak the same verdict or the product argues with itself.
//
// A PLACE IS JUDGED BY THE APPLICATION'S OWN RULE (utils/verdict): the share
// of its sessions that met an error, ≥ HIT_BAD Critical, ≥ HIT_WARN Warning.
// The same two lines the page header and the hero use — so a country cannot
// read Healthy beside an application that reads Critical for the very same
// reason, which is what the relative rule did on a bank's production
// application (every country "in line" with an 84% base, the map all green
// under a hero saying Critical). Chosen by Marcelo, 2026-10-23, over a
// relative map with neutral greys.
//
// And by the application's experience score lines (under 0.85 Warning,
// under 0.70 Critical, ≥30 rated elements) — "not only error-free", the
// same two halves utils/verdict judges the application on.
// The DEVIATION — the place's rate against the application's, "0.59×" — is
// computed and printed, never coloured.
// Substance gate: below GEO_MIN_SESSIONS a rate is an anecdote; the place
// stays uncoloured-green and its sentence says it was too small to judge.
import { fmtApdex } from "./apdex";
import { HIT_BAD, HIT_WARN } from "./verdict";

export type GeoTone = "good" | "warn" | "bad";

export interface GeoArm {
  sessions: number;
  /** Sessions that met at least one error. */
  hit: number;
  /** Real people only — when present (and non-zero) the verdict is judged on
   *  these, exactly as the application's verdict is (utils/verdict). */
  realSessions?: number; realHit?: number;
  /** Duration-only Apdex bands over user actions (T = 3s). */
  sat: number; tol: number; fru: number;
}

/** The words the page header uses for the same verdict — a place judged by
 *  the application's rule is named with the application's words. They were
 *  satisfied / tolerating / frustrated, the vocabulary of a speed score,
 *  which is not what colours a place any more. */
export const GEO_WORD = { bad: "Critical", warn: "Warning", good: "Healthy" } as const;

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
export const GEO_ABS_BAD = HIT_BAD;
export const GEO_ABS_WARN = HIT_WARN;
/** Substance gate for the absolute arm — below this many sessions a rate
 *  is an anecdote, not a verdict. */
export const GEO_MIN_SESSIONS = 10;

/** The population a place is judged on: its real people when it has any,
 *  every session otherwise — the application's verdict makes the same call. */
export const geoPop = (g: GeoArm) => (g.realSessions && g.realSessions > 0
  ? { n: g.realSessions, h: g.realHit ?? 0, real: true }
  : { n: g.sessions, h: g.hit, real: false });

export const geoArms = (g: GeoArm, base: number): GeoArms => {
  const pop = geoPop(g);
  const rate = pop.n ? pop.h / pop.n : 0;
  const lift = base > 0 ? rate / base : 0;
  const rated = g.sat + g.tol + g.fru;
  const apx = rated > 0 ? (g.sat + g.tol / 2) / rated : null;
  const rel = pop.n >= 30 && pop.h >= 5 && rate >= 0.02
    ? (lift >= 1.5 ? 2 : lift >= 1.15 ? 1 : 0) : 0;
  const abs = pop.n >= GEO_MIN_SESSIONS && rate >= GEO_ABS_BAD ? 2
    : pop.n >= GEO_MIN_SESSIONS && rate >= GEO_ABS_WARN ? 1 : 0;
  const spd = rated >= 30 && apx !== null
    ? (apx < 0.7 ? 2 : apx < 0.85 ? 1 : 0) : 0;
  /* THE APPLICATION'S RULE COLOURS THE PLACE (see the header): the share of
   * its people an error affected, and its experience score, each on the
   * application's own lines — worst wins, exactly as utils/verdict decides.
   * The deviation (rel) is still returned for the sentence, never the colour. */
  return { rate, lift, apx, rel, abs, spd, level: Math.max(abs, spd) };
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
type SubArm = { sessions: number; hit: number; sat?: number; tol?: number; fru?: number;
  realSessions?: number; realHit?: number };
export const geoJudgeSub = (r: SubArm, base: number): GeoTone =>
  geoJudge({ ...r, sat: r.sat ?? 0, tol: r.tol ?? 0, fru: r.fru ?? 0 }, base);
export const geoBecauseSub = (r: SubArm, base: number): string =>
  geoBecause({ ...r, sat: r.sat ?? 0, tol: r.tol ?? 0, fru: r.fru ?? 0 }, base);

/** The line that fired, spelled out — a verdict never asks to be taken on
 *  faith — followed by the two figures that are printed but do not colour. */
/** "1 session" / "4 sessions" — the gate's own count, in words that agree. */
const fmtCount = (n: number) => `${n} session${n === 1 ? "" : "s"}`;

export const geoBecause = (g: GeoArm, base: number): string => {
  const a = geoArms(g, base);
  const pct = `${(a.rate * 100).toFixed(a.rate >= 0.1 ? 0 : 1)}%`;
  /* the deviation and the speed, printed after the verdict's own reason */
  const tail = (base > 0 && geoPop(g).h > 0 ? ` · ${a.lift.toFixed(2)}× the application's rate` : "")
    + (a.apx !== null ? ` · experience score ${fmtApdex(a.apx)}` : "");
  const pop = geoPop(g);
  const whose = pop.real ? "real-user sessions" : "sessions";
  if (pop.h === 0) return `no ${whose.replace(/s$/, "")} was affected by an error` + tail;
  /* A GATE IS NOT A THRESHOLD: too few sessions to judge is said as such. */
  if (pop.n < GEO_MIN_SESSIONS) {
    return `${pct} of its ${whose} were affected by an error, but ${fmtCount(pop.n)}`
      + ` is too few to judge — a verdict needs ${GEO_MIN_SESSIONS}` + tail;
  }
  /* when the experience score set the colour, the sentence says so first */
  if (a.spd === a.level && a.abs < a.level && a.apx !== null) {
    return `experience score ${fmtApdex(a.apx)} — ${a.level === 2 ? "Critical under 0.70" : "Warning under 0.85"}, `
      + `the application's own line · ${pct} of its ${whose} were affected by an error`
      + (base > 0 && pop.h > 0 ? ` · ${a.lift.toFixed(2)}× the application's rate` : "");
  }
  if (a.level === 2) return `${pct} of its ${whose} were affected by an error — Critical starts at ${HIT_BAD * 100}%, the application's own line` + tail;
  if (a.level === 1) return `${pct} of its ${whose} were affected by an error — Warning starts at ${HIT_WARN * 100}%, the application's own line` + tail;
  return `${pct} of its ${whose} were affected by an error — under the ${HIT_WARN * 100}% warning line` + tail;
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
