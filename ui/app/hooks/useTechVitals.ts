// The technical reading of the same anatomy Business Control says in business
// words — one scan per application, shared by the Delivery Chain and Journeys.
import { useEffect, useState } from "react";
import { qTechVitals, runDql, type Timeframe } from "../utils/dql";

export interface TechRow {
  kind: "app" | "view" | "dur" | "err";
  bucket: string;
  n: number; meas: number; sessions: number;
  cacheMs: number; dnsMs: number; connMs: number; reqMs: number; waitMs: number;
  ttfbMs: number; lcpMs: number; fcpMs: number; cls: number; inpMs: number;
  longMs: number; durMs: number;
}

const memo = new Map<string, TechRow[]>();

export function useTechVitals(tf: Timeframe, appId?: string | null): TechRow[] | null {
  const key = appId ? `${tf.from}|${tf.to}|${appId}` : "";
  const [out, setOut] = useState<TechRow[] | null>(key ? memo.get(key) ?? null : null);

  useEffect(() => {
    if (!key || !appId) { setOut(null); return; }
    const hit = memo.get(key);
    if (hit) { setOut(hit); return; }
    setOut(null);
    let live = true;
    (async () => {
      try {
        const rows = await runDql<Record<string, unknown>>(qTechVitals(tf, appId), 40);
        const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v) || 0);
        const res = rows.map((r) => ({
          kind: String(r.kind) as TechRow["kind"], bucket: String(r.bucket ?? ""),
          n: num(r.n), meas: num(r.meas), sessions: num(r.sessions),
          cacheMs: num(r.cacheMs), dnsMs: num(r.dnsMs), connMs: num(r.connMs),
          reqMs: num(r.reqMs), waitMs: num(r.waitMs), ttfbMs: num(r.ttfbMs),
          lcpMs: num(r.lcpMs), fcpMs: num(r.fcpMs), cls: num(r.cls),
          inpMs: num(r.inpMs), longMs: num(r.longMs), durMs: num(r.durMs),
        }));
        memo.set(key, res);
        if (live) setOut(res);
      } catch { if (live) setOut([]); }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return out;
}
