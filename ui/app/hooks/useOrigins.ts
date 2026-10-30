// Where the sessions came from — web, mobile, robots, synthetic monitors —
// for the one page that draws it: the Delivery Chain's users column.
//
// This was a leg of the shared chain loader, so every page paid for it: a
// per-session scan of the whole window (81 GB, 22 s on a production estate)
// on every Overview, where nothing on screen read it. It now runs only when
// the Delivery Chain is open, once per window and application.
import { useEffect, useState } from "react";
import { useMemoGen } from "../utils/memo";
import { qOrigins, runDql, type Timeframe } from "../utils/dql";
import { frontendNodeOf, qFmScalar } from "../utils/frontendMetrics";
import type { OriginRow } from "./useChainData";

const memo = new Map<string, OriginRow[]>();
const num = (v: unknown) => Number(v) || 0;

export function useOrigins(tf: Timeframe, session: string | null | undefined,
  appId: string | null | undefined, active: boolean): OriginRow[] | null {
  const gen = useMemoGen();
  const key = appId ? `${tf.from}|${tf.to}|${session ?? ""}|${appId}|${gen}` : "";
  const [out, setOut] = useState<OriginRow[] | null>(key ? memo.get(key) ?? null : null);

  useEffect(() => {
    if (!key) { setOut(null); return; }
    const hit = memo.get(key);
    if (hit) { setOut(hit); return; }
    // a new window or application: the previous answer is not this one
    setOut(null);
    if (!active) return;
    let live = true;
    (async () => {
      try {
        /* 0.17.6: FROM THE METRIC STORE FIRST. The origin is the platform's
           dt.rum.user_type and the frontend's own kind (web / mobile), and the
           session count per origin is its counter — ≈0 GiB, where the
           per-session scan read 138 GiB and 29 s on a bank's production. What
           the metric does not carry stays unknown rather than guessed: views
           and screen profiles read 0, the half-window split is null (no trend
           arrow), and who met an error comes from the session store, as on
           the Overview (hitPerOrigin falls back to it). A one-session url, or
           a frontend the store has nothing for, keeps the scan. */
        const node = !session && appId ? await frontendNodeOf(appId).catch(() => null) : null;
        if (node) {
          const m = await runDql<Record<string, unknown>>(
            qFmScalar(tf, "countDistinct(dt.frontend.session.active.estimated_count, scalar: true)",
              node.id, "dt.rum.user_type"), 20).catch(() => [] as Record<string, unknown>[]);
          if (m.length) {
            const agent = node.kind === "mobile" ? "mobile" : "javascript";
            const res: OriginRow[] = m.map((r) => ({
              appId: appId!, agent, utype: r["dt.rum.user_type"] as string | null,
              sessions: num(r.v), views: 0, profiles: 0, late: null, hit: null,
            })).filter((r) => r.sessions > 0);
            memo.set(key, res);
            if (live) setOut(res);
            return;
          }
        }
        const rows = await runDql<Record<string, unknown>>(qOrigins(tf, session, appId), 200);
        const res: OriginRow[] = rows.map((r) => ({
          appId: String(r.appId ?? ""),
          agent: r.agent as string | null, utype: r.utype as string | null,
          sessions: num(r.sessions), views: num(r.views),
          profiles: num(r.profiles),
          late: r.late == null ? null : num(r.late),
          hit: r.hitSessions == null ? null : num(r.hitSessions),
        }));
        memo.set(key, res);
        if (live) setOut(res);
      } catch { if (live) setOut([]); }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, active]);

  return out;
}
