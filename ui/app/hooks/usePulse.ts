// The landing page's own data: a trend and every breakdown, two scans total.
//
// The trend is sessions and errors per bin — the shape of the last hours, not
// just their sum. The breakdown query returns the full dimension tuple and is
// rolled up per dimension HERE: a session carries one OS, one device, one app
// version and one country, so the tuple stays small and one scan answers what
// the classic overview asks four panels about.
//
// Memoised per application and timeframe, like every other landing query: the
// first page must not bill twice for being looked at twice.
import { useEffect, useState } from "react";
import { useMemoGen } from "../utils/memo";
import { qAppMetricSeries, qPulseBreakdown, qPulseSeries, qSessionSeries, runDql,
  withinSessionLag, type Timeframe } from "../utils/dql";

export interface PulsePoint {
  t: string; sessions: number; errors: number; actions: number; requests: number;
}


export interface PulseData {
  series: PulsePoint[];
  /** Requests in the window, and the calls among them that failed — the
   *  web-requests card's two numbers, counted exactly (qPulseBreakdown). */
  requests: number;
  reqFail: number;
}

const memo = new Map<string, PulseData | null>();


/**
 * `frontendName` moves the SESSIONS line of the trend onto `user.sessions`,
 * the store the Overview's headline and the sessions hand-off both use. The
 * errors, actions and requests lines stay on `user.events`, because those are
 * event counts and that store is where events live. Without a name the trend
 * is entirely the event scan, as before.
 */
export function usePulse(
  rumAppId?: string, tf?: Timeframe, frontendName?: string,
): PulseData | null {
  const gen = useMemoGen();
  const fe = frontendName || "";
  const key = rumAppId && tf ? `${rumAppId}|${tf.from}|${tf.to}|${fe}|${gen}` : "";
  const [data, setData] = useState<PulseData | null>(key ? memo.get(key) ?? null : null);

  useEffect(() => {
    if (!key) { setData(null); return; }
    if (memo.has(key)) { setData(memo.get(key) ?? null); return; }

    let live = true;
    setData(null);
    (async () => {
      let out: PulseData | null = null;
      try {
        /* The breakdown scan is the slow one on a large application; its
           preview lets the card's bars and KPIs appear while it finishes. */
        /* THE COUNTERS' BARS COME FROM THE SAME SERIES THE FORECAST TRAINS ON.
           One rule, one source: the forecast band is drawn over these bars,
           and a band trained on the metric store over bars mined from events
           would be two populations meeting in the open — the exact
           incoherence this app spent a morning removing. Sessions keep their
           base; errors, requests and actions take the metric series when the
           frontend is known, and the event series otherwise. */
        const metricP = fe
          ? runDql<Record<string, unknown>>(qAppMetricSeries(tf!, fe), 1)
              .catch(() => [] as Record<string, unknown>[])
          : Promise.resolve([] as Record<string, unknown>[]);
        const [series, tuples, sess, metricRows] = await Promise.all([
          runDql<Record<string, unknown>>(qPulseSeries(tf!, rumAppId!), 200),
          runDql<Record<string, unknown>>(qPulseBreakdown(tf!, rumAppId!), 1),
          // not inside the store's lag: there the series would be empty by
          // construction, and the event series is the honest one
          fe && !withinSessionLag(tf!)
            ? runDql<Record<string, unknown>>(qSessionSeries(tf!, fe), 200)
                 .catch(() => [] as Record<string, unknown>[])
             : Promise.resolve([] as Record<string, unknown>[]),
          metricP,
        ]);
        /* Both legs bin the same window with the same width, so the bin
           label is the join key. A bin the session store has nothing for is
           zero rather than missing — the gap is the fact. */
        const byBin = new Map<string, number>();
        for (const r of sess) byBin.set(String(r.t ?? ""), Number(r.sessions) || 0);
        /* A `timeseries` answer is ONE record: arrays per field, a start and
           an interval. The i-th value belongs to start + i·interval, so the
           join with the event series is by timestamp, rounded to the bin —
           a string compare would break on a stray millisecond. */
        const m = metricRows[0] as { errors?: number[]; requests?: number[]; actions?: number[];
          timeframe?: { start?: string }; interval?: number } | undefined;
        const ivMs = Number(m?.interval ?? 0) / 1e6;
        const m0 = m?.timeframe?.start ? Date.parse(String(m.timeframe.start)) : NaN;
        const atBin = (ms: number) => (ivMs > 0 ? Math.round(ms / ivMs) : ms);
        const byBinM = new Map<number, { errors: number; requests: number; actions: number }>();
        if (m && Number.isFinite(m0) && ivMs > 0) {
          const n = Math.max(m.errors?.length ?? 0, m.requests?.length ?? 0, m.actions?.length ?? 0);
          for (let i = 0; i < n; i++) byBinM.set(atBin(m0 + i * ivMs), {
            errors: Number(m.errors?.[i]) || 0, requests: Number(m.requests?.[i]) || 0,
            actions: Number(m.actions?.[i]) || 0 });
        }
        out = {
          series: series.map((r) => {
            const t = String(r.t ?? ""); const mm = byBinM.get(atBin(Date.parse(t)));
            return {
              t,
              sessions: byBin.size
                ? (byBin.get(t) ?? 0)
                : Number(r.sessions) || 0,
              errors: mm ? mm.errors : Number(r.errors) || 0,
              actions: mm ? mm.actions : Number(r.actions) || 0,
              /* REQUESTS STAY ON EVENTS. Measured bin by bin on a production
                 capture, dt.frontend.request.count runs 22% above the request
                 events in every interval — a different population, not a lag.
                 The card's total is counted from events; its bars must be the
                 same population ("what does not match is not substituted"). */
              requests: Number(r.requests) || 0,
            };
          }),
          requests: Number(tuples[0]?.requests) || 0,
          reqFail: Number(tuples[0]?.reqfail) || 0,
        };
      } catch {
        /* the page still renders from the shared data — panels just close */
      }
      memo.set(key, out);
      if (live) setData(out);
    })();

    return () => { live = false; };
  }, [key, rumAppId, tf]);

  return data;
}
