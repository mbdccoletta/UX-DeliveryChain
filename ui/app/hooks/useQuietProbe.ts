// Distinguishes a sleeping application from a dead one.
//
// Asked only when the selected window carries zero sessions: was there
// anything in the last 24 hours, and when was the last of it? The Consume
// column's empty card then says "quiet, not uninstrumented" — or, when even
// the day is empty, says THAT — instead of a bare "No coverage" that reads
// as broken monitoring. Memoised per application entity.
import { useEffect, useState } from "react";
import { qQuietProbe, runDql } from "../utils/dql";

export interface QuietProbe { sessions: number; last: string | null }

const memo = new Map<string, QuietProbe>();

export function useQuietProbe(entityId?: string, active = true): QuietProbe | null {
  const key = active && entityId ? entityId : "";
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
        const rows = await runDql<{ sessions?: string; last?: string }>(
          qQuietProbe(key), 1);
        const res = { sessions: Number(rows[0]?.sessions) || 0,
          last: rows[0]?.last ? String(rows[0].last) : null };
        memo.set(key, res);
        if (live) setOut(res);
      } catch { /* no probe: the card keeps the plain empty wording */ }
    })();
    return () => { live = false; };
  }, [key]);

  return out;
}
