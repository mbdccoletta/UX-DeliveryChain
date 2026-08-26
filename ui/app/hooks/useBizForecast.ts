// Davis's forecast of the next window, for Business Control.
//
// Two analyzer runs — sessions and conversions — over a history six times the
// window; the projection is the sum of the point predictions across one
// window's worth of future bins, with the lower/upper bands kept so the board
// can say "1,2k–1,6k", not a false single truth. Forecasting is estimation by
// nature: the board labels it Davis forecast, never mixing it with measured
// figures. Memoised per (window, scope).
import { useEffect, useState } from "react";
import { qBizSeries, type OutcomeDefs, type Timeframe } from "../utils/dql";

export interface Projection { point: number; lower: number; upper: number; quality: string }
export interface BizForecast { sessions: Projection | null; conversions: Projection | null }

const ANALYZER = "dt.statistics.GenericForecastAnalyzer";
const memo = new Map<string, BizForecast>();

/**
 * Raw platform calls, same origin in dev (proxy) and production (AppEngine):
 * verified directly against the tenant — the analyzer answers synchronously
 * for this series size, and returns OK/VALID with 8 forecast points.
 */
async function forecastOne(
  tf: Timeframe, metric: "sessions" | "conversions", appId: string | null,
  defs?: OutcomeDefs,
): Promise<Projection | null> {
  try {
    const horizon = 8; // one window ahead: the series bins the window into 8
    const base = `/platform/davis/analyzers/v1/analyzers/${ANALYZER}`;
    let res = await (await fetch(`${base}:execute`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        timeSeriesData: qBizSeries(tf, metric, appId, defs), forecastHorizon: horizon }),
    })).json() as Record<string, unknown>;
    let hops = 0;
    while (res.requestToken && !res.result && hops++ < 30) {
      await new Promise((r) => setTimeout(r, 700));
      res = await (await fetch(
        `${base}:poll?request-token=${encodeURIComponent(String(res.requestToken))}`,
      )).json() as Record<string, unknown>;
    }
    const out = ((res.result as Record<string, unknown> | undefined)
      ?.output as Array<Record<string, unknown>> | undefined)?.[0];
    if (!out || out.analysisStatus !== "OK") return null;
    const rec = (out.timeSeriesDataWithPredictions as
      { records?: Array<Record<string, unknown>> })?.records?.[0];
    if (!rec) return null;
    const sum = (k: string) => ((rec[k] as Array<number | null>) ?? [])
      .filter((v): v is number => v !== null && Number.isFinite(v))
      .reduce((a, v) => a + v, 0);
    return {
      point: sum("dt.davis.forecast:point"),
      lower: sum("dt.davis.forecast:lower"),
      upper: sum("dt.davis.forecast:upper"),
      quality: String(out.forecastQualityAssessment ?? ""),
    };
  } catch { return null; }
}

export function useBizForecast(tf: Timeframe, appId: string | null,
  defs?: OutcomeDefs): BizForecast | null {
  const key = `${tf.from}|${tf.to}|${appId ?? ""}|${JSON.stringify(defs?.[appId ?? ""] ?? null)}`;
  const [out, setOut] = useState<BizForecast | null>(memo.get(key) ?? null);

  useEffect(() => {
    const hit = memo.get(key);
    if (hit) { setOut(hit); return; }
    setOut(null);
    let live = true;
    (async () => {
      /* ONE analyzer run, not two. The conversion leg projected a predicate
       * the product no longer uses, and each leg is a full Grail scan inside
       * the analyzer — measured as the heaviest in the app. Volume is what is
       * directly projectable, so volume is what is projected. */
      const sessions = await forecastOne(tf, "sessions", appId, defs);
      const res = { sessions, conversions: null };
      memo.set(key, res);
      if (live) setOut(res);
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return out;
}
