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
    if (!active) return;
    let live = true;
    (async () => {
      try {
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
