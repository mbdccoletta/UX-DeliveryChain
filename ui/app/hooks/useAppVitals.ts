// The card's headline numbers, early — from the metric store.
//
// The Overview's figures are mined from raw events, and on a large
// application that takes tens of seconds. The platform keeps the same counts
// pre-aggregated as metrics, where a read answers in milliseconds and scans
// no Grail bytes. This asks for those, so the card has real numbers almost
// at once while the measurements that decide the final figures are still
// running.
//
// It is ADDITIVE and fail-safe by construction: if the metrics are not
// published on this environment, or the query is refused, the hook returns
// null and every screen behaves exactly as it did before. There is no path
// where this makes the app worse — only one where it makes it faster.
import { useEffect, useState } from "react";
import { useMemoGen } from "../utils/memo";
import { qAppVitals, runDql, type Timeframe } from "../utils/dql";

export interface AppVitals {
  sessions: number | null;
  users: number | null;
  errors: number | null;
  crashes: number | null;
  anrs: number | null;
  requests: number | null;
  actions: number | null;
}

const memo = new Map<string, AppVitals | null>();
const n = (v: unknown): number | null => {
  const x = Number(Array.isArray(v) ? v[0] : v);
  return Number.isFinite(x) ? x : null;
};

export function useAppVitals(
  tf: Timeframe, frontendName?: string | null,
): AppVitals | null {
  const gen = useMemoGen();
  const key = frontendName ? `${tf.from}|${tf.to}|${frontendName}|${gen}` : "";
  const [v, setV] = useState<AppVitals | null>(key ? memo.get(key) ?? null : null);

  useEffect(() => {
    if (!key || !frontendName) { setV(null); return; }
    if (memo.has(key)) { setV(memo.get(key) ?? null); return; }
    let live = true;
    (async () => {
      let out: AppVitals | null = null;
      try {
        const rows = await runDql<Record<string, unknown>>(
          qAppVitals(tf, frontendName), 1);
        const r = rows[0];
        if (r) {
          out = {
            sessions: n(r.sessions), users: n(r.users), errors: n(r.errors),
            crashes: n(r.crashes), anrs: n(r.anrs),
            requests: n(r.requests), actions: n(r.actions),
          };
          // a row of nothing but nulls is not an answer
          if (Object.values(out).every((x) => x == null)) out = null;
        }
      } catch {
        // metrics not published here, or no permission — the screen is
        // unchanged, it just fills in a little later
      }
      memo.set(key, out);
      if (live) setV(out);
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return v;
}
