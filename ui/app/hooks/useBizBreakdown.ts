// Business Control's breakdown: what failure costs, and where conversion
// lives.
//
// The query is now ONE per-session scan (it was six appends, 35.4 GB a load —
// the app's most expensive by far). The bucketing that used to happen in DQL
// happens here instead, over rows the scan already returned: same BreakRow
// shape out, so nothing downstream changed.
import { useEffect, useState } from "react";
import { useMemoGen } from "../utils/memo";
import { qBizBreakdown, runDql, type OutcomeDefs, type Timeframe } from "../utils/dql";

/** The dimensions the board offers, and the column each one reads. */
const DIMS: Array<[string, string]> = [
  ["country", "country"], ["os", "os"], ["browser", "browser"],
  ["device type", "deviceType"], ["user type", "userType"],
];

export interface BreakRow {
  d: string; bucket: string; appId: string;
  sessions: number; conv: number; realN: number; realConv: number;
  /** Real sessions in this bucket that met at least one error. */
  realHit: number;
}

/** The rows, plus whether the server-side row cap cut them short.
 *
 *  This hook aggregates SESSION rows in the client, and the query returns at
 *  most CAP of them. Past that the totals silently omit sessions and the
 *  segment ranking comes from an arbitrary subset — which looked exactly like
 *  a complete answer. The rows are still returned, because a partial ranking
 *  beats none, but they now carry the fact so the board can say it. */
export interface BreakRows extends Array<BreakRow> { partial?: boolean }

/** The server-side row limit these are read under. */
export const BREAKDOWN_CAP = 20000;

const memo = new Map<string, BreakRows>();

export function useBizBreakdown(tf: Timeframe, defs?: OutcomeDefs,
  appId?: string | null): BreakRows | null {
  const gen = useMemoGen();
  const key = `${tf.from}|${tf.to}|${appId ?? ""}|${JSON.stringify(defs ?? {})}|${gen}`;
  const [out, setOut] = useState<BreakRows | null>(memo.get(key) ?? null);

  useEffect(() => {
    const hit = memo.get(key);
    if (hit) { setOut(hit); return; }
    setOut(null);
    let live = true;
    (async () => {
      try {
        const rows = await runDql<Record<string, unknown>>(
          qBizBreakdown(tf, defs, appId), BREAKDOWN_CAP);
        /* the grouping the six DQL legs used to do — one pass, in memory */
        const acc = new Map<string, BreakRow>();
        const bump = (d: string, bucket: string, app: string, r: Record<string, unknown>) => {
          const k = `${d}\u0000${bucket}\u0000${app}`;
          const cur = acc.get(k) ?? { d, bucket, appId: app,
            sessions: 0, conv: 0, realN: 0, realConv: 0, realHit: 0 };
          const conv = Number(r.reached) === 1;
          const real = Number(r.real) === 1;
          cur.sessions++;
          if (conv) cur.conv++;
          if (real) {
            cur.realN++;
            if (conv) cur.realConv++;
            if (Number(r.errs) > 0) cur.realHit++;
          }
          acc.set(k, cur);
        };
        for (const r of rows) {
          const app = String(r.appId ?? "");
          if (!app) continue;
          // the error-cost leg: one bucket per session, hit or clean
          bump("__err", Number(r.errs) > 0 ? "hit" : "clean", app, r);
          for (const [name, col] of DIMS) {
            const v = r[col];
            if (v === null || v === undefined || v === "") continue;
            bump(name, String(v), app, r);
          }
        }
        // the legs kept their 40 biggest buckets per dimension; so does this
        const byDim = new Map<string, BreakRow[]>();
        for (const row of acc.values()) {
          const g = byDim.get(row.d) ?? [];
          g.push(row); byDim.set(row.d, g);
        }
        const res: BreakRows = [];
        for (const [, g] of byDim) {
          g.sort((a, b) => b.sessions - a.sessions);
          res.push(...g.slice(0, 40));
        }
        /* the cap cut the session rows, so everything aggregated from them is
           a floor rather than a total — said out loud, not inferred */
        if (rows.length >= BREAKDOWN_CAP) res.partial = true;
        memo.set(key, res);
        if (live) setOut(res);
      } catch { if (live) setOut([]); }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return out;
}
