// Access and health by location, for the Overview tile — one leg, memoised
// per app and window like every other read in this product.
import { useEffect, useState } from "react";
import { useMemoGen } from "../utils/memo";
import { qGeo, qGeoCountMetric, qGeoExperienceMetric, qGeoMetrics, qGeoTtfbMetric, runDql, type Timeframe } from "../utils/dql";

export interface GeoRow {
  country: string; sessions: number; ttfbMs: number;
  /** "metric": from dt.frontend.* (no affected sessions, no score);
   *  "events": the event-store scan, for an application with no frontend name. */
  source: "metric" | "events";
  /** Errors and user actions in the window (metric source). */
  errors?: number; actions?: number;
  /** Event source only: sessions an error affected. */
  hit?: number;
  /** Sessions of real people (no robots, no synthetic monitors) and how many
   *  of them met an error — the population the verdict is judged on. */
  realSessions?: number; realHit?: number;
  /** Duration-only Apdex bands over user actions (T = 3s) — the slowness
   *  side of frustration; the error side is counted by `hit`. */
  sat?: number; tol?: number; fru?: number;
}

/** The rows, plus whether they are still a PREVIEW. A normal array to every
 *  consumer; the one flag rides along so the tile can say "measuring…" while
 *  the figures firm up, and stop saying it when the final lands. */
export type GeoRows = GeoRow[] & { partial?: boolean };

const memo = new Map<string, GeoRows>();

const shape = (rows: Record<string, unknown>[]): GeoRows => rows.map((r) => ({
  source: "events" as const,
  country: String(r.country ?? "?"),
  sessions: Number(r.sessions) || 0,
  hit: Number(r.hitSessions) || 0,
  realSessions: Number(r.realSessions) || 0,
  realHit: Number(r.realHit) || 0,
  ttfbMs: Number(r.ttfbMs) || 0,
  sat: Number(r.sat) || 0,
  tol: Number(r.tol) || 0,
  fru: Number(r.fru) || 0,
}));

export function useGeo(tf: Timeframe, appId?: string | null,
  /** The frontend name, and whether the name lookup has answered. With a
   *  name the map reads the metric store (qGeoMetrics); without one, once
   *  the lookup has answered, it falls back to the event scan (qGeo). */
  frontendName?: string, nameReady = true): GeoRows | null {
  const gen = useMemoGen();
  const fe = frontendName || "";
  const key = appId && nameReady ? `${tf.from}|${tf.to}|${appId}|${fe}|${gen}` : "";
  const [out, setOut] = useState<GeoRows | null>(key ? memo.get(key) ?? null : null);

  useEffect(() => {
    if (!key || !appId) { setOut(null); return; }
    const hit = memo.get(key);
    if (hit) { setOut(hit); return; }
    setOut(null);
    let live = true;
    (async () => {
      if (fe) {
        /* THE METRIC MAP, OR — IF THE METRICS CANNOT ANSWER — THE EVENT MAP.
           An empty or failed metric read must not erase the tile: the event
           scan below still knows every country. */
        try {
          const none = () => [] as Record<string, unknown>[];
          const [rows, errs, acts, ttfb, exp] = await Promise.all([
            runDql<Record<string, unknown>>(qGeoMetrics(tf, fe), 40),
            runDql<Record<string, unknown>>(qGeoCountMetric(tf, fe, "errors"), 200).catch(none),
            runDql<Record<string, unknown>>(qGeoCountMetric(tf, fe, "actions"), 200).catch(none),
            runDql<Record<string, unknown>>(qGeoTtfbMetric(tf, fe), 40)
              .catch(() => [] as Record<string, unknown>[]),
            runDql<Record<string, unknown>>(qGeoExperienceMetric(tf, fe), 600).catch(none),
          ]);
          // the experience weights per country, by level
          const x = new Map<string, { sat: number; tol: number; fru: number }>();
          for (const r of exp) {
            const cc = String(r.country ?? ""), w = Number(r.w) || 0;
            const b = x.get(cc) ?? { sat: 0, tol: 0, fru: 0 };
            if (r.level === "satisfied") b.sat += w;
            else if (r.level === "tolerating") b.tol += w;
            else if (r.level === "frustrated") b.fru += w;
            x.set(cc, b);
          }
          if (rows.length) {
            const e = new Map(errs.map((r) => [String(r.country ?? ""), Number(r.errors) || 0]));
            const a = new Map(acts.map((r) => [String(r.country ?? ""), Number(r.actions) || 0]));
            const t = new Map(ttfb.map((r) => [String(r.country ?? ""), Number(r.ttfb) || 0]));
            const res: GeoRows = rows.map((r) => {
              const cc = String(r.country ?? "?");
              return {
                source: "metric" as const,
                country: cc,
                sessions: Number(r.sessions) || 0,
                // undefined, not 0, when the counters had nothing for it: an
                // unknown rate is not judged, a zero rate would read as clean
                errors: e.has(cc) ? e.get(cc) : undefined,
                actions: a.has(cc) ? a.get(cc) : undefined,
                // already milliseconds: measured in production, AF read 1,967
                // on the metric and 1,980 ms on the events over the same hour
                ttfbMs: t.get(cc) ?? 0,
                ...(x.get(cc) ?? {}),
              };
            });
            memo.set(key, res);
            if (live) setOut(res);
            return;
          }
        } catch { /* fall through to the event map */ }
        if (!live) return;
      }
      try {
        /* THE MAP PAINTS ON THE PREVIEW TOO. Measured on production (HAR 13,
           1h window): this query's execute came back at t+4.9s carrying all
           twelve countries, and the final landed at t+16.2s. Every other
           panel had been drawn for ten seconds while the map and the country
           list waited for the final — the one hook that never asked for the
           preview. The preview rows are marked `partial`, the tile says so,
           and the final replaces them. Integrity rule: a preview paints, it
           never decides, and it is never memoised as the answer. */
        const rows = await runDql<Record<string, unknown>>(qGeo(tf, appId), 12,
          undefined, (early) => {
            if (!live || !early.length) return;
            const prev = shape(early); prev.partial = true;
            setOut(prev);
          });
        const res = shape(rows);
        memo.set(key, res);
        if (live) setOut(res);
      } catch { if (live) setOut([]); }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return out;
}
