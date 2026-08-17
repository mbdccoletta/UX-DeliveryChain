// Business Control's breakdown: what failure costs, and where conversion
// lives — one query (qBizBreakdown), cut client-side by the board's scope.
import { useEffect, useState } from "react";
import { qBizBreakdown, runDql, type OutcomeDefs, type Timeframe } from "../utils/dql";

export interface BreakRow {
  d: string; bucket: string; appId: string;
  sessions: number; conv: number; realN: number; realConv: number;
  /** Real sessions in this bucket that met at least one error. */
  realHit: number;
}

const memo = new Map<string, BreakRow[]>();

export function useBizBreakdown(tf: Timeframe, defs?: OutcomeDefs): BreakRow[] | null {
  const key = `${tf.from}|${tf.to}|${JSON.stringify(defs ?? {})}`;
  const [out, setOut] = useState<BreakRow[] | null>(memo.get(key) ?? null);

  useEffect(() => {
    const hit = memo.get(key);
    if (hit) { setOut(hit); return; }
    setOut(null);
    let live = true;
    (async () => {
      try {
        const rows = await runDql<Record<string, unknown>>(qBizBreakdown(tf, defs), 500);
        const res = rows.map((r) => ({
          d: String(r.d ?? ""), bucket: String(r.bucket ?? ""), appId: String(r.appId ?? ""),
          sessions: Number(r.sessions) || 0, conv: Number(r.conv) || 0,
          realN: Number(r.realN) || 0, realConv: Number(r.realConv) || 0,
          realHit: Number(r.realHit) || 0,
        })).filter((r) => r.d);
        memo.set(key, res);
        if (live) setOut(res);
      } catch { if (live) setOut([]); }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return out;
}
