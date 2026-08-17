// The Web Vitals, once: what each acronym measures, in words, and where the
// standard draws its lines.
//
// An acronym on screen that the reader has to look up is a number they cannot
// act on. Every place this app prints LCP, FCP, TTFB, INP or CLS reads its
// explanation from here, so the wording cannot drift between the chain, the
// poster and anywhere they land next — and the thresholds behind "good /
// needs work / poor" are the standard's own, not ours.

export interface Vital {
  /** The acronym spelled out. */
  name: string;
  /** What it measures, for someone who has never seen it. */
  what: string;
  /** [good ≤, needs-work ≤] — above the second it is poor. ms, except CLS. */
  t: [number, number];
  /** How the threshold reads in words. */
  scale: string;
}

export const VITALS: Record<string, Vital> = {
  LCP: {
    name: "Largest Contentful Paint",
    what: "when the biggest thing on the screen — usually the hero image or headline "
      + "— finished painting. It answers \"when did the page LOOK loaded?\"",
    t: [2500, 4000], scale: "good ≤ 2.5s · poor > 4s",
  },
  FCP: {
    name: "First Contentful Paint",
    what: "when the first piece of content appeared at all. It answers \"when did "
      + "something show up?\" — the end of the blank screen.",
    t: [1800, 3000], scale: "good ≤ 1.8s · poor > 3s",
  },
  TTFB: {
    name: "Time To First Byte",
    what: "how long until the first byte of the server's answer arrived. Everything "
      + "the browser draws waits behind it.",
    t: [800, 1800], scale: "good ≤ 800ms · poor > 1.8s",
  },
  INP: {
    name: "Interaction to Next Paint",
    what: "the worst delay between a tap or click and the screen actually changing. "
      + "It answers \"does this feel responsive?\"",
    t: [200, 500], scale: "good ≤ 200ms · poor > 500ms",
  },
  CLS: {
    name: "Cumulative Layout Shift",
    what: "how much the content jumped around while loading — 0 means nothing moved "
      + "under the reader's finger.",
    t: [0.1, 0.25], scale: "good ≤ 0.10 · poor > 0.25",
  },
};

/** The full hover text for one vital: name, meaning, scale, and how it was read. */
export const vitalTitle = (key: string, suffix = "p75") => {
  const v = VITALS[key];
  if (!v) return key;
  return `${key} — ${v.name}\n\n${v.what}\n\n${v.scale} · measured at ${suffix}, `
    + "the percentile the Web Vitals standard itself uses";
};

/** good / needs work / poor, by the standard's own thresholds. */
export const vitalBand = (key: string, v: number): "good" | "warn" | "bad" => {
  const t = VITALS[key]?.t;
  if (!t) return "good";
  return v <= t[0] ? "good" : v <= t[1] ? "warn" : "bad";
};
