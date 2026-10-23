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
import { useMemoGen } from "../utils/memo";
import { qGeoCities, qGeoRegions, runDql, type Timeframe } from "../utils/dql";

export interface PlaceRow {
  /** ISO 3166-2 for a state ("US-CA"); the plain name for a city. */
  id: string;
  name: string;
  sessions: number;
  hit: number;
  /** The platform's experience rating of the place's user actions, real
   *  people only — states carry it (qGeoRegions); cities do not. */
  sat?: number; tol?: number; fru?: number;
  /** Real people only, as the verdict counts them (states). */
  realSessions?: number; realHit?: number;
}

/** The rows, plus whether they are still a PREVIEW — real, measured, not yet
 *  whole. Same contract as GeoRows: the panel says "measuring…" while the
 *  flag is up; the final replaces it; only the final is memoised. */
export type PlaceRows = PlaceRow[] & { partial?: boolean };

const memo = new Map<string, PlaceRows>();

/** One fetch-and-remember, shared by both levels.
 *
 *  PREVIEWS PAINT HERE TOO. Opening a country on a bank's production estate
 *  is a full scan of the hour's RUM — 15–25 s before the first state showed,
 *  and the click looked dead. Grail hands back partial rows within a couple
 *  of seconds; they are the same measurement, incomplete, and the rest of
 *  the app already paints them marked. Nothing is settled on a timer: the
 *  final still decides, and only the final is remembered. */
function usePlaces(key: string,
  run: (onPartial: (rows: PlaceRows) => void) => Promise<PlaceRows>): PlaceRows | null {
  const [out, setOut] = useState<PlaceRows | null>(key ? memo.get(key) ?? null : null);
  useEffect(() => {
    if (!key) { setOut(null); return; }
    const hit = memo.get(key);
    if (hit) { setOut(hit); return; }
    setOut(null);
    let live = true;
    (async () => {
      try {
        const rows = await run((early) => {
          if (!live || !early.length) return;
          const p: PlaceRows = [...early]; p.partial = true;
          setOut(p);
        });
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
  iso?: string | null): PlaceRows | null {
  const gen = useMemoGen();
  const key = appId && iso ? `r|${tf.from}|${tf.to}|${appId}|${iso}|${gen}` : "";
  return usePlaces(key, async (onPartial) => {
    const shape = (rows: Record<string, unknown>[]): PlaceRows => rows.map((r) => ({
      /* THE COUNTRY HAS TO BE PREFIXED. The platform returns the suffix alone —
       * "CA", "NSW", "32" — while ISO 3166-2 is "US-CA", "AU-NSW", "PL-32", and
       * the choropleth keys on the full code. Not tidiness: "CA" on its own is
       * both California and Canada. */
      id: `${iso}-${String(r.region ?? "")}`,
      name: String(r.name ?? r.region ?? "?"),
      sessions: Number(r.sessions) || 0,
      hit: Number(r.hit) || 0,
      sat: Number(r.sat) || 0, tol: Number(r.tol) || 0, fru: Number(r.fru) || 0,
      realSessions: Number(r.realSessions) || 0, realHit: Number(r.realHit) || 0,
    }));
    const rows = await runDql<Record<string, unknown>>(
      qGeoRegions(tf, appId as string, iso as string), 40, undefined,
      (early) => onPartial(shape(early)));
    return shape(rows);
  });
}

/** The cities of one state. */
export function useCities(tf: Timeframe, appId?: string | null,
  iso?: string | null, region?: string | null): PlaceRows | null {
  const gen = useMemoGen();
  const key = appId && iso && region
    ? `c|${tf.from}|${tf.to}|${appId}|${iso}|${region}|${gen}` : "";
  return usePlaces(key, async (onPartial) => {
    const shape = (rows: Record<string, unknown>[]): PlaceRows => rows.map((r) => ({
      id: String(r.city ?? "?"),
      name: String(r.city ?? "?"),
      sessions: Number(r.sessions) || 0,
      hit: Number(r.hit) || 0,
    }));
    const rows = await runDql<Record<string, unknown>>(
      qGeoCities(tf, appId as string, iso as string, region as string), 20, undefined,
      (early) => onPartial(shape(early)));
    return shape(rows);
  });
}
