// The clicked component's vitals: p50/p90/p95, throughput, failures — and a
// forecast where one can be had cheaply.
//
// Fetched on selection and memoised for the session: the drawer opens with
// "…" and fills in, instead of every screen load paying for metrics nobody
// asked about. The service forecast rides the metric store (timeseries), which
// is orders cheaper than re-scanning spans for 24 hours.
import { useEffect, useState } from "react";
import { qAppMetrics, qDomMetrics, qSvcMetrics, runDql } from "../utils/dql";
import { forecast, type Forecast } from "../utils/forecast";

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
}

const EMPTY: NodeMetrics = { ready: false, p50: 0, p90: 0, p95: 0, thr: 0, fails: 0 };
const memo = new Map<string, NodeMetrics>();
const keyOf = (t: MetricTarget) =>
  t.kind === "domain" ? `d:${t.appId}:${t.domain}` : `${t.kind}:${t.id}`;

export function useNodeMetrics(target: MetricTarget | null): NodeMetrics | null {
  const [m, setM] = useState<NodeMetrics | null>(
    target ? memo.get(keyOf(target)) ?? EMPTY : null,
  );

  useEffect(() => {
    if (!target) { setM(null); return; }
    const k = keyOf(target);
    const hit = memo.get(k);
    if (hit?.ready) { setM(hit); return; }

    let live = true;
    setM(EMPTY);
    (async () => {
      const q = target.kind === "service" ? qSvcMetrics(target.id)
        : target.kind === "app" ? qAppMetrics(target.id)
        : qDomMetrics(target.appId, target.domain);
      let out: NodeMetrics = { ...EMPTY };
      try {
        const r = (await runDql<Record<string, unknown>>(q, 1))[0] ?? {};
        out = { ready: true,
          p50: Number(r.p50) || 0, p90: Number(r.p90) || 0, p95: Number(r.p95) || 0,
          thr: Number(r.thr) || 0, fails: Number(r.fails) || 0 };
      } catch { /* no scope or empty window — tiles simply stay absent */ }
      memo.set(k, out);
      if (live) setM({ ...out });
      // the forecast arrives second, so the tiles never wait on the analyzer
      if (out.ready && target.kind === "service") {
        const fc = await forecast(
          `timeseries thr = sum(dt.service.request.count),
             filter: { dt.entity.service == "${target.id.replace(/"/g, "")}" },
             from: now()-24h, interval: 1h`, 12);
        const cur = memo.get(k);
        if (cur) { cur.fc = fc; memo.set(k, cur); }
        if (live) setM((prev) => (prev ? { ...prev, fc } : prev));
      }
    })();

    return () => { live = false; };
  }, [target ? keyOf(target) : null]);

  return m;
}
