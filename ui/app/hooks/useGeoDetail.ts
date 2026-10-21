// Inside one country: its states, and inside one state, its cities.
//
// Asked only when a reader opens a country, and memoised like every other read
// here — the map's first level costs one scan, and this costs one more only if
// somebody goes looking.
//
// WHY THE TWO LEVELS ARE SHAPED DIFFERENTLY. Strato's ChoroplethLayer paints by
// ISO 3166-2, which is what `geo.region.iso_code` carries, so a state can be
// drawn with no centroid table of our own. A city has no ISO code and, measured
// on a live estate, `geo.location.latitude` is NULL on 100% of rows — nothing
// can position it. Cities are therefore a ranked list rather than a map, and
// that is a fact about the data, not a shortcut.
import { useEffect, useState } from "react";
import { qGeoCities, qGeoRegions, runDql, type Timeframe } from "../utils/dql";

export interface PlaceRow {
  /** ISO 3166-2 for a state ("US-CA"); the plain name for a city. */
  id: string;
  name: string;
  sessions: number;
  hit: number;
}

const memo = new Map<string, PlaceRow[]>();

/** One fetch-and-remember, shared by both levels. */
function usePlaces(key: string, run: () => Promise<PlaceRow[]>): PlaceRow[] | null {
  const [out, setOut] = useState<PlaceRow[] | null>(key ? memo.get(key) ?? null : null);
  useEffect(() => {
    if (!key) { setOut(null); return; }
    const hit = memo.get(key);
    if (hit) { setOut(hit); return; }
    setOut(null);
    let live = true;
    (async () => {
      try {
        const rows = await run();
        memo.set(key, rows);
        if (live) setOut(rows);
      } catch {
        // an empty list is an answer; the panel states coverage either way
        if (live) setOut([]);
      }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return out;
}

/** The states of one country, keyed for the choropleth. */
export function useRegions(tf: Timeframe, appId?: string | null,
  iso?: string | null): PlaceRow[] | null {
  const key = appId && iso ? `r|${tf.from}|${tf.to}|${appId}|${iso}` : "";
  return usePlaces(key, async () => {
    const rows = await runDql<Record<string, unknown>>(
      qGeoRegions(tf, appId as string, iso as string), 40);
    return rows.map((r) => ({
      /* THE COUNTRY HAS TO BE PREFIXED. The platform returns the suffix alone —
       * "CA", "NSW", "32" — while ISO 3166-2 is "US-CA", "AU-NSW", "PL-32", and
       * the choropleth keys on the full code. Not tidiness: "CA" on its own is
       * both California and Canada. */
      id: `${iso}-${String(r.region ?? "")}`,
      name: String(r.name ?? r.region ?? "?"),
      sessions: Number(r.sessions) || 0,
      hit: Number(r.hit) || 0,
    }));
  });
}

/** The cities of one state. */
export function useCities(tf: Timeframe, appId?: string | null,
  iso?: string | null, region?: string | null): PlaceRow[] | null {
  const key = appId && iso && region
    ? `c|${tf.from}|${tf.to}|${appId}|${iso}|${region}` : "";
  return usePlaces(key, async () => {
    const rows = await runDql<Record<string, unknown>>(
      qGeoCities(tf, appId as string, iso as string, region as string), 20);
    return rows.map((r) => ({
      id: String(r.city ?? "?"),
      name: String(r.city ?? "?"),
      sessions: Number(r.sessions) || 0,
      hit: Number(r.hit) || 0,
    }));
  });
}
