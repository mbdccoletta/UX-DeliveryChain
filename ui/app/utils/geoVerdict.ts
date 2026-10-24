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
import { HIT_BAD, HIT_WARN, SCORE_BAD, SCORE_WARN, scoreTone } from "./verdict";

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
  // no sample minimums (Marcelo, 2026-10-23: not Dynatrace rules) — the
  // place is judged on whatever it measured, by the application's own lines
  // the share of sessions with errors is measured, never judged (0.17.2)
  const abs = 0;
  const st = scoreTone(apx);
  const spd = st === "bad" ? 2 : st === "warn" ? 1 : 0;
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
    + (a.apx !== null ? ` · Apdex ${fmtApdex(a.apx)}` : "");
  const pop = geoPop(g);
  const whose = pop.real ? "real-user sessions" : "sessions";
  const hurt = pop.h === 0 ? `no ${whose.replace(/s$/, "")} affected by an error`
    : `${pct} of its ${whose} affected by an error`;
  if (a.apx === null) return `not rated — no Apdex here · ${hurt}`
    + (base > 0 && pop.h > 0 ? ` · ${a.lift.toFixed(2)}× the application's rate` : "");
  return `Apdex ${fmtApdex(a.apx)} — Critical under ${SCORE_BAD.toFixed(2)}, Warning under ${SCORE_WARN.toFixed(2)}, `
    + `the application's own lines · ${hurt}`
    + (base > 0 && pop.h > 0 ? ` · ${a.lift.toFixed(2)}× the application's rate` : "");
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


/* WHAT THE ROW PRINTS IS WHAT COLOURED IT. A place is judged on two arms —
   the share of sessions an error affected, and the experience score — and
   the row printed the error share whichever arm decided. the busiest state on staging
   was amber on its score with "3.7% hit" in amber beside it, and its screens
   all read Healthy: the row named a cause it did not have. When the score
   decides, the row shows the score. */
export const geoTag = (g: GeoArm, base: number): string => {
  const a = geoArms(g, base);
  if (a.level > 0 && a.spd >= a.abs && a.apx !== null) return `score ${fmtApdex(a.apx)}`;
  const pop = geoPop(g);
  return pop.h === 0 ? "clean" : `${(a.rate * 100).toFixed(1)}% hit`;
};
export const geoTagSub = (r: SubArm, base: number): string =>
  geoTag({ ...r, sat: r.sat ?? 0, tol: r.tol ?? 0, fru: r.fru ?? 0 }, base);


/* ── THE METRIC MAP'S RULE (0.16.13) ─────────────────────────────────────────
   Countries are coloured from the platform's metrics, which know errors and
   user actions per country but not which sessions an error affected. So the
   map judges a different, stated thing: each country's errors per user action
   against THIS application's own rate, worst with first-byte time. Relative,
   because errors per action has no absolute scale (a production application
   measured ~80 — background errors included). A country needs enough actions
   to be judged at all. This is NOT the verdict's rule; the tile says so. */
export const GEO_RATE_WARN = 1.5;
export const GEO_RATE_BAD = 3;
export const GEO_MIN_ACTIONS = 100;
export interface MetricPlace { country: string; sessions: number; errors?: number; actions?: number;
  /** The platform's experience weights here (0.17.0) — the verdict's measure. */
  sat?: number; tol?: number; fru?: number }
/** THE VERDICT'S OWN MEASURE PER PLACE (0.17.0). The application was Critical
 *  on its experience score while every country sat green — the map judged
 *  errors per action against the application's own average, and when the
 *  trouble is everywhere nothing is worse than the average. The metric store
 *  carries the experience weights per country, so a country is now read on
 *  the same score and the same bands as the application (apdexTone), and the
 *  relative error rate can only add to that, never clear it. */
export const placeScore = (g: MetricPlace): number | null => {
  const rated = (g.sat ?? 0) + (g.tol ?? 0) + (g.fru ?? 0);
  return rated > 0 ? ((g.sat ?? 0) + (g.tol ?? 0) / 2) / rated : null;
};
const worse = (a: GeoTone, b: GeoTone): GeoTone =>
  a === "bad" || b === "bad" ? "bad" : a === "warn" || b === "warn" ? "warn" : "good";
export const placeRate = (g: MetricPlace) =>
  g.actions && g.actions > 0 ? (g.errors ?? 0) / g.actions : null;
export const geoJudgeMetric = (g: MetricPlace, base: number): GeoTone => {
  const r = placeRate(g);
  // no sample minimum (Marcelo, 2026-10-23: not a Dynatrace rule) — a place
  // is judged whenever it has the data
  // the platform's score in the verdict's bands; the error rate is printed, never judged
  void r; void base;
  return scoreTone(placeScore(g)) ?? "good";
};
export const geoBecauseMetric = (g: MetricPlace, base: number): string => {
  const r = placeRate(g);
  const sc = placeScore(g);
  const score = sc === null ? "" : `Apdex ${(Math.floor(Math.min(sc, 0.99) * 100) / 100).toFixed(2)} — `;
  if (r === null) return `${score}no user actions recorded here`;
  const lift = base > 0 ? r / base : 0;
  return `${score || "not rated — no Apdex here · "}${r.toFixed(r >= 10 ? 0 : 2)} errors per user action, `
    + `${lift.toFixed(2)}× this application's rate (${g.actions} user actions)`;
};


/** A map row from either source (hooks/useGeo GeoRow, structurally). */
export interface PlaceRow extends MetricPlace {
  source: "metric" | "events";
  hit?: number; realSessions?: number; realHit?: number;
  sat?: number; tol?: number; fru?: number;
}
const armOf = (g: PlaceRow): GeoArm => ({ sessions: g.sessions, hit: g.hit ?? 0,
  realSessions: g.realSessions, realHit: g.realHit,
  sat: g.sat ?? 0, tol: g.tol ?? 0, fru: g.fru ?? 0 });
/** ONE JUDGE FOR A SET OF PLACES, whichever source they came from — the
 *  Overview map and the board both call this, so they cannot disagree. */
export function placeJudge(rows: PlaceRow[]): (g: PlaceRow) => { tone: GeoTone; because: string } {
  if (rows.length && rows[0].source === "metric") {
    const base = rows.reduce((a, g) => a + (g.errors ?? 0), 0)
      / (rows.reduce((a, g) => a + (g.actions ?? 0), 0) || 1);
    return (g) => ({ tone: geoJudgeMetric(g, base), because: geoBecauseMetric(g, base) });
  }
  const n = rows.reduce((a, g) => a + geoPop(armOf(g)).n, 0) || 1;
  const base = rows.reduce((a, g) => a + geoPop(armOf(g)).h, 0) / n;
  return (g) => ({ tone: geoJudge(armOf(g), base), because: geoBecause(armOf(g), base) });
}


/* ── STATES FROM THE SESSION STORE (0.16.15) ────────────────────────────────
   The store knows, per session, its state and whether it had any error — not
   whether the error landed on the person's own action. So a state is judged
   on the share of its real-user sessions WITH ERRORS (as Users & Sessions
   counts them) against its own country's share: relative, like the countries
   on the metric map, and stated as such. Thirty sessions before judging. */
export interface StoreRegion { sessions: number; hit: number; realSessions?: number; realHit?: number }
const storeShare = (r: StoreRegion) => {
  const n = r.realSessions && r.realSessions > 0 ? r.realSessions : r.sessions;
  const h = r.realSessions && r.realSessions > 0 ? (r.realHit ?? 0) : r.hit;
  return { n, h, share: n > 0 ? h / n : 0 };
};
export const STORE_MIN_SESSIONS = 30;
/* NO PLACE IS JUDGED BY A SOFTER RULE THAN ITS APPLICATION (0.17.0). Read
   only against its country's share, a state — and, on the metric map, a
   country — that carried the very share which put the application in
   Warning came out green: when the trouble is everywhere, nothing is worse
   than the average. So the application's own lines (HIT_WARN, HIT_BAD on
   the share of sessions with errors) apply to every place, and the relative
   lift can only add to them. */
export const geoJudgeStore = (r: StoreRegion, base: number): GeoTone => {
  const { n, share } = storeShare(r);
  if (n === 0) return "good";
  const abs: GeoTone = share >= GEO_ABS_BAD ? "bad" : share >= GEO_ABS_WARN ? "warn" : "good";
  if (!(base > 0)) return abs;
  const lift = share / base;
  return worse(abs, lift >= GEO_RATE_BAD ? "bad" : lift >= GEO_RATE_WARN ? "warn" : "good");
};
export const geoTagStore = (r: StoreRegion) => {
  const { n, h, share } = storeShare(r);
  return n === 0 ? "—" : h === 0 ? "no errors" : `${(share * 100).toFixed(1)}% with errors`;
};
export const geoBecauseStore = (r: StoreRegion, base: number) => {
  const { n, share } = storeShare(r);
  return `${(share * 100).toFixed(1)}% of its ${n} closed real-user session${n === 1 ? "" : "s"} had errors, `
    + `${base > 0 ? (share / base).toFixed(2) : "—"}× its country's share`
    + ` — Warning from ${Math.round(GEO_ABS_WARN * 100)}% or ${GEO_RATE_WARN}×, Critical from ${Math.round(GEO_ABS_BAD * 100)}% or ${GEO_RATE_BAD}×,`
    + ` the application's own lines (session store, as Users & Sessions lists them)`;
};
