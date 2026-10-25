// Distinguishes a sleeping application from a dead one.
//
// Asked only when the selected window carries zero sessions: was there
// anything in the last 24 hours, and when was the last of it? The Consume
// column's empty card then says "quiet, not uninstrumented" — or, when even
// the day is empty, says THAT — instead of a bare "No coverage" that reads
// as broken monitoring. Memoised per application entity.
import { useEffect, useState } from "react";
import { useMemoGen } from "../utils/memo";
import { runDql } from "../utils/dql";
import { frontendNodes } from "../utils/frontendMetrics";

export interface QuietProbe { sessions: number; last: string | null }

const memo = new Map<string, QuietProbe>();

export function useQuietProbe(entityId?: string, active = true): QuietProbe | null {
  const gen = useMemoGen();
  const key = active && entityId ? `${entityId}|${gen}` : "";
  const [out, setOut] = useState<QuietProbe | null>(key ? memo.get(key) ?? null : null);

  useEffect(() => {
    if (!key) { setOut(null); return; }
    if (memo.has(key)) { setOut(memo.get(key) ?? null); return; }
    /* A NEW KEY MEANS THE OLD ANSWER IS NOT THIS ANSWER. Holding the
       previous result while the new one loads let a screen render the
       previous application's — or the previous window's — figures under the
       new selection, and the caller's readiness check (result !== null)
       could not tell the difference. Cleared before the fetch, so the screen
       keeps its loading state until data that matches arrives. */
    setOut(null);
    let live = true;
    (async () => {
      try {
        /* FROM THE METRIC STORE (0.17.42). This read 24 hours of the
           estate's user.sessions — ≈125 GB on a bank's production — to
           answer "anything today, and when last?". The frontend's own
           session metric, hourly over the day, answers the same for ≈0 GiB.
           The ENTITY, not the cache key, picks the frontend. */
        const node = (await frontendNodes()).find((n) => n.entity === entityId);
        if (!node) return;
        const fe = `filter: { dt.smartscape.frontend == toSmartscapeId("${node.id.replace(/["\\]/g, "")}") }`;
        const [rows, tot] = await Promise.all([
          runDql<{ s?: unknown[]; timeframe?: { start?: string } }>(
            `timeseries s = countDistinct(dt.frontend.session.active.estimated_count),
  from: now()-24h, to: now(), interval: 1h, ${fe}`, 1),
          // the day's total is one distinct count, not a sum of hours
          runDql<{ v?: unknown }>(
            `timeseries v = countDistinct(dt.frontend.session.active.estimated_count, scalar: true),
  from: now()-24h, to: now(), ${fe}`, 1),
        ]);
        const bins = (rows[0]?.s ?? []).map((v) => Number(v) || 0);
        const start = Date.parse(String(rows[0]?.timeframe?.start ?? ""));
        let lastIdx = -1;
        bins.forEach((v, i) => { if (v > 0) lastIdx = i; });
        const res = { sessions: Math.round(Number(tot[0]?.v) || 0),
          last: lastIdx >= 0 && Number.isFinite(start)
            ? new Date(start + (lastIdx + 1) * 3600e3).toISOString() : null };
        memo.set(key, res);
        if (live) setOut(res);
      } catch { /* no probe: the card keeps the plain empty wording */ }
    })();
    return () => { live = false; };
  }, [key]);

  return out;
}
