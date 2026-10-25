// The clicked component's vitals: p50/p90/p95, throughput, failures — and a
// forecast where one can be had cheaply.
//
// Fetched on selection and memoised for the session: the drawer opens with
// "…" and fills in, instead of every screen load paying for metrics nobody
// asked about. The service forecast rides the metric store (timeseries), which
// is orders cheaper than re-scanning spans for 24 hours.
import { useEffect, useState } from "react";
import { useMemoGen } from "../utils/memo";
import { svcIs, qAppMetrics, qDomMetrics, qServiceVitals, qSvcMetrics, qSvcMetricsFallback, runDql,
  type Timeframe } from "../utils/dql";
import { forecast, type Forecast } from "../utils/forecast";
import { frontendNodeOf, qFmScalar } from "../utils/frontendMetrics";

/** An application's requests from dt.frontend.request.* — durations in ms
 *  there, ns here (the unit every duration in this app is kept in). Null
 *  when the application has no FRONTEND node or the store has no requests. */
async function appRequestMetrics(rumAppId: string, tf: Timeframe): Promise<NodeMetrics | null> {
  const node = await frontendNodeOf(rumAppId);
  if (!node) return null;
  const pct = (p: number) => runDql<Record<string, unknown>>(
    qFmScalar(tf, `percentile(dt.frontend.request.duration, ${p}, scalar: true)`, node.id), 1);
  const [p50, p90, p95, cnt] = await Promise.all([pct(50), pct(90), pct(95),
    runDql<Record<string, unknown>>(qFmScalar(tf, "sum(dt.frontend.request.count, scalar: true)",
      node.id, "http.response.status_code_class"), 20)]);
  let thr = 0, fails = 0;
  for (const r of cnt) {
    const v = Number(r.v) || 0;
    thr += v;
    if (r["http.response.status_code_class"] === "4xx" || r["http.response.status_code_class"] === "5xx") fails += v;
  }
  if (!thr) return null;
  const ns = (rows: Record<string, unknown>[]) => (Number(rows[0]?.v) || 0) * 1e6;
  return { ready: true, p50: ns(p50), p90: ns(p90), p95: ns(p95), thr, fails };
}

export type MetricTarget =
  | { kind: "service"; id: string }
  | { kind: "app"; id: string }
  | { kind: "domain"; appId: string; domain: string };

export interface NodeMetrics {
  ready: boolean;
  p50: number; p90: number; p95: number;
  thr: number; fails: number;
  /** Throughput projection for services; null while loading or refused. */
  fc?: Forecast | null;
  /**
   * True when these numbers came from the metric store because the service
   * has no spans. The store keeps an AVERAGE, not percentiles, so the drawer
   * has to say "avg" rather than print one number under three headings.
   */
  avgOnly?: boolean;
}

const EMPTY: NodeMetrics = { ready: false, p50: 0, p90: 0, p95: 0, thr: 0, fails: 0 };
/** Nothing traced this service — ask the metric store before saying zero. */
const noSpans = (m: NodeMetrics) => m.ready && m.thr === 0;
const memo = new Map<string, NodeMetrics>();
const keyOf = (t: MetricTarget) =>
  t.kind === "domain" ? `d:${t.appId}:${t.domain}` : `${t.kind}:${t.id}`;

/**
 * THE SAME WINDOW AS THE REST OF THE SCREEN.
 *
 * These were a fixed "last 30 minutes", labelled as such, on the reasoning
 * that a live reading is cheap and a different question. In practice the
 * drawer then carried three windows at once — 30 minutes of vitals, two
 * hours of ledger, forty minutes of forecast — and a reader asked the
 * obvious: why is the chain on 2h and the drill-down on 30m? Annotating the
 * contradiction had already been tried; it is still a contradiction. The
 * probe follows the selection now, so every number in the drawer describes
 * the window the reader chose.
 */
export function useNodeMetrics(
  target: MetricTarget | null, tf: Timeframe,
  /** The click budget's sampling ratio for a DOMAIN's raw-event read (utils/
   *  cost scanRatio); its counts come back scaled by it. */
  ratio = 1,
): NodeMetrics | null {
  const gen = useMemoGen();
  const win = `${tf.from}|${tf.to}`;
  const [m, setM] = useState<NodeMetrics | null>(
    target ? memo.get(`${keyOf(target)}|${win}|${gen}`) ?? EMPTY : null,
  );

  useEffect(() => {
    if (!target) { setM(null); return; }
    const k = `${keyOf(target)}|${win}|${gen}`;
    const hit = memo.get(k);
    if (hit?.ready) { setM(hit); return; }

    let live = true;
    setM(EMPTY);
    (async () => {
      let out: NodeMetrics = { ...EMPTY };
      /* AN APPLICATION FROM THE METRIC STORE FIRST (0.17.15). Its request
         percentiles, volume and 4xx/5xx are the platform's dt.frontend.request
         counters — ≈0 GiB, where the event read measured 179 GiB on a bank's
         production. A domain has no metric dimension and keeps the events,
         sampled inside the click budget. */
      const viaMetric = target.kind === "app"
        ? await appRequestMetrics(target.id, tf).catch(() => null)
        /* A SERVICE FROM ITS METRICS FIRST (0.17.28): dt.service.request.* give
           the same percentiles, volume and failures for ≈0 GiB; the span read
           — the whole window of spans filtered to one service, unbounded on a
           large estate — is now only the fallback for a service the metric
           store does not know. */
        : target.kind === "service"
        ? await runDql<Record<string, unknown>>(qServiceVitals(tf, [target.id]), 1)
            .then((rows) => {
              const r = rows[0];
              return r && Number(r.calls) > 0
                ? { ready: true, p50: Number(r.p50) || 0, p90: Number(r.p90) || 0,
                    p95: Number(r.p95) || 0, thr: Number(r.calls) || 0,
                    fails: Number(r.fails) || 0 } as NodeMetrics
                : null;
            }).catch(() => null)
        : null;
      if (viaMetric) out = viaMetric;
      else {
        const k2 = target.kind === "domain" ? ratio : 1;
        const q = target.kind === "service" ? qSvcMetrics(target.id, tf)
          : target.kind === "app" ? qAppMetrics(target.id, tf)
          : qDomMetrics(target.appId, target.domain, tf, k2);
        try {
          const r = (await runDql<Record<string, unknown>>(q, 1))[0] ?? {};
          out = { ready: true,
            p50: Number(r.p50) || 0, p90: Number(r.p90) || 0, p95: Number(r.p95) || 0,
            thr: (Number(r.thr) || 0) * k2, fails: (Number(r.fails) || 0) * k2 };
        } catch { /* no scope or empty window — tiles simply stay absent */ }
      }
      /* Spans are the right source for anything OneAgent traces into Grail,
       * and the wrong one for everything else. Measured on a live estate: `MF
       * easyTravelBusiness` has no spans at all, so the tiles announced p50
       * 0ms and throughput 0 for a service the metric store shows serving
       * hundreds of requests a minute. When the first source finds nothing,
       * ask the second before concluding — the store costs no scanned bytes,
       * so the fallback is free and only runs where it is needed. */
      if (target.kind === "service" && noSpans(out)) {
        try {
          const f = (await runDql<Record<string, unknown>>(
            qSvcMetricsFallback(target.id, tf), 1))[0] ?? {};
          const calls = Number(f.calls) || 0;
          if (calls > 0) {
            const avg = Number(f.avgNs) || 0;
            out = { ready: true, p50: avg, p90: avg, p95: avg,
              thr: calls, fails: Number(f.fails) || 0, avgOnly: true };
          }
        } catch { /* the store has nothing either — zero is then the answer */ }
      }
      memo.set(k, out);
      if (live) setM({ ...out });
      // the forecast arrives second, so the tiles never wait on the analyzer
      if (out.ready && target.kind === "service") {
        const fc = await forecast(
          `timeseries thr = sum(dt.service.request.count),
             filter: { ${svcIs(target.id)} },
             from: now()-24h, interval: 1h`, 12);
        const cur = memo.get(k);
        if (cur) { cur.fc = fc; memo.set(k, cur); }
        if (live) setM((prev) => (prev ? { ...prev, fc } : prev));
      }
    })();

    return () => { live = false; };
  }, [target ? keyOf(target) : null, win, gen, ratio]);

  return m;
}
