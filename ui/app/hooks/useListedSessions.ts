// How many sessions the Users & Sessions hand-off will actually list.
//
// The Overview counts sessions from `user.events`; the explorer reads
// `user.sessions`. Two stores, two populations — and a reader who compares the
// card with the list it opens finds a gap and reads it as a defect. Explaining
// the gap is a worse answer than not having one, so the card asks the other
// store for its own figure and shows both.
//
// Memoised per frontend and window, and keyed on the refresh generation like
// every other leg here.
import { useEffect, useState } from "react";
import { useMemoGen } from "../utils/memo";
import { qListedSessions, runDql, type Timeframe } from "../utils/dql";

const memo = new Map<string, number | null>();

/** Sessions in the window as the sessions store counts them, or null. */
export function useListedSessions(
  tf: Timeframe, frontendName?: string | null,
): number | null {
  const gen = useMemoGen();
  const key = frontendName ? `${tf.from}|${tf.to}|${frontendName}|${gen}` : "";
  const [n, setN] = useState<number | null>(key ? memo.get(key) ?? null : null);

  useEffect(() => {
    if (!key || !frontendName) { setN(null); return; }
    if (memo.has(key)) { setN(memo.get(key) ?? null); return; }
    setN(null);
    let live = true;
    (async () => {
      try {
        const rows = await runDql<{ sessions?: unknown }>(
          qListedSessions(tf, frontendName), 1);
        const v = Number(rows[0]?.sessions);
        const res = Number.isFinite(v) ? v : null;
        memo.set(key, res);
        if (live) setN(res);
      } catch {
        // no scope, or the store is not readable: the card simply does not
        // make the second claim
        memo.set(key, null);
        if (live) setN(null);
      }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return n;
}
