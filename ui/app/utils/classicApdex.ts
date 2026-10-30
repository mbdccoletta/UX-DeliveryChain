// THE APDEX DYNATRACE'S APPLICATION LIST SHOWS, WHEN THE NEW RUM HAS NONE.
//
// Marcelo, 2026-10-24: "mesmo sem actions deveria classificar como o
// Dynatrace faz" — beside the Applications list rating a mobile app "Excellent".
// That rating is RUM classic's builtin:apps.* Apdex (Data Explorer,
// builtin:apps.other.apdex.osAndVersion). On this estate the new RUM carries
// the traffic (1.5M sessions an hour) and no rated actions for some mobile
// apps, while classic still rates a residue (5 users, 0.16 actions/min on one
// of them). So it is the FALLBACK, never the first choice, and it travels with
// its population — the reader sees how many actions the rating rests on.
// Classic metric queries go to the environment API, not Grail: no query
// bytes are billed.
import { metricsClient } from "@dynatrace-sdk/client-classic-environment-v2";
import type { Timeframe } from "./dql";

export interface ClassicApdex {
  value: number;
  /** User actions the rating rests on, when the platform says. */
  actions: number | null;
}

/** "now()-1h" → "now-1h"; an absolute bound passes through unquoted. */
const classicTime = (t: string) => t.trim().replace(/^"(.*)"$/, "$1").replace(/now\(\)/g, "now");

async function one(selector: string, tf: Timeframe): Promise<number | null> {
  const r = await metricsClient.query({ acceptType: "application/json; charset=utf-8",
    metricSelector: selector, resolution: "Inf",
    from: classicTime(tf.from), to: classicTime(tf.to) });
  const v = r.result?.[0]?.data?.[0]?.values?.[0];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

const memo = new Map<string, Promise<ClassicApdex | null>>();

export function classicApdex(entity: string, tf: Timeframe): Promise<ClassicApdex | null> {
  const key = `${entity}|${tf.from}|${tf.to}`;
  let p = memo.get(key);
  if (!p) {
    const id = entity.replace(/["~]/g, "");
    const mobile = /^(MOBILE|CUSTOM)_APPLICATION-/.test(id);
    const f = mobile ? `filter(eq("dt.entity.device_application","${id}"))`
      : `filter(eq("dt.entity.application","${id}"))`;
    const apdex = mobile ? `builtin:apps.other.apdex.osAndVersion:${f}:splitBy():avg`
      : `builtin:apps.web.apdex.userType:${f}:splitBy():avg`;
    const count = mobile ? `builtin:apps.other.uaCount.osAndVersion:${f}:splitBy():sum`
      : `builtin:apps.web.actionCount.summary:${f}:splitBy():sum`;
    p = Promise.all([one(apdex, tf), one(count, tf).catch(() => null)])
      .then(([value, actions]) => (value === null ? null : { value, actions }))
      .catch(() => null);
    memo.set(key, p);
  }
  return p;
}

/* ── THE SAME RATING PER PLACE (0.17.8) ──────────────────────────────────────
   builtin:apps.other.apdex.osAndGeo splits by dt.entity.geolocation, and a
   point lands at whatever depth its address resolved to — a country
   ("Brazil"), a state ("São Paulo"), a city ("Barueri"), a continent, or "*".
   The API names the place but not its parent, so a city cannot be placed in
   its state or country. A country is read from its own row plus the rows of
   the states the session store puts in it; a state from its own row. Cities,
   continents and "*" are left out and the place's tooltip says how many
   actions its rating rests on. Weighted by user actions when the platform
   publishes the count, equally otherwise. */
export interface ClassicPlace { apdex: number; actions: number | null }
export interface ClassicGeo {
  /** By ISO country code. */
  countries: Map<string, ClassicPlace>;
  /** By lower-cased place name (states). */
  places: Map<string, ClassicPlace>;
}

let isoByName: Map<string, string> | null = null;
const isoOf = (name: string): string | null => {
  if (!isoByName) {
    isoByName = new Map();
    try {
      const dn = new Intl.DisplayNames(["en"], { type: "region" });
      const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      for (const a of A) for (const b of A) {
        const code = a + b;
        const nm = dn.of(code);
        if (nm && nm !== code) isoByName.set(nm.toLowerCase(), code);
      }
    } catch { /* no Intl: countries stay unmatched */ }
  }
  return isoByName.get(name.toLowerCase()) ?? null;
};

async function byGeo(selector: string, tf: Timeframe): Promise<Map<string, number>> {
  const r = await metricsClient.query({ acceptType: "application/json; charset=utf-8",
    metricSelector: selector, resolution: "Inf",
    from: classicTime(tf.from), to: classicTime(tf.to) });
  const out = new Map<string, number>();
  for (const d of r.result?.[0]?.data ?? []) {
    const name = d.dimensionMap?.["dt.entity.geolocation.name"] ?? "";
    const v = d.values?.[0];
    if (name && typeof v === "number" && Number.isFinite(v)) out.set(name, v);
  }
  return out;
}

const geoMemo = new Map<string, Promise<ClassicGeo | null>>();

/** Mobile and custom applications only — the web classic metrics carry no
 *  per-place Apdex, and web applications are rated by the new RUM anyway. */
export function classicGeoApdex(entity: string, tf: Timeframe): Promise<ClassicGeo | null> {
  const key = `${entity}|${tf.from}|${tf.to}`;
  let p = geoMemo.get(key);
  if (!p) {
    const id = entity.replace(/["~]/g, "");
    if (!/^(MOBILE|CUSTOM)_APPLICATION-/.test(id)) return Promise.resolve(null);
    const f = `filter(eq("dt.entity.device_application","${id}"))`;
    const split = `splitBy("dt.entity.geolocation")`;
    p = Promise.all([
      byGeo(`builtin:apps.other.apdex.osAndGeo:${f}:${split}:avg:names`, tf),
      byGeo(`builtin:apps.other.uaCount.osAndGeo:${f}:${split}:sum:names`, tf).catch(() => new Map<string, number>()),
    ]).then(([apdex, count]) => {
      if (!apdex.size) return null;
      const countries = new Map<string, ClassicPlace>();
      const places = new Map<string, ClassicPlace>();
      for (const [name, v] of apdex) {
        const n = count.get(name) ?? null;
        const iso = isoOf(name);
        if (iso) countries.set(iso, { apdex: v, actions: n });
        else places.set(name.toLowerCase(), { apdex: v, actions: n });
      }
      return { countries, places };
    }).catch(() => null);
    geoMemo.set(key, p);
  }
  return p;
}

/** Weighted mean of ratings — by actions when every part has a count. */
export function mergePlaces(parts: ClassicPlace[]): ClassicPlace | null {
  if (!parts.length) return null;
  const counted = parts.every((p) => p.actions !== null && p.actions > 0);
  const w = (p: ClassicPlace) => (counted ? p.actions as number : 1);
  const tw = parts.reduce((a, p) => a + w(p), 0);
  return { apdex: parts.reduce((a, p) => a + p.apdex * w(p), 0) / tw,
    actions: counted ? parts.reduce((a, p) => a + (p.actions as number), 0) : null };
}
