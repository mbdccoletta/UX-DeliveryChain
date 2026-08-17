// Business Control's numbers: this window and the one before it, per app.
//
// One scan (qBizKpis) returns both periods for every application; the page
// does the deltas. Memoised per window — the panel is opened by a click and
// re-read only when the window changes.
import { useEffect, useState } from "react";
import { qBizKpis, runDql, type OutcomeDefs, type Timeframe } from "../utils/dql";

export interface BizPeriod {
  sessions: number; realSessions: number; converted: number; convertedReal: number;
  hitReal: number; fatalSessions: number;
  engaged: number; realEngaged: number; actions: number; abandoned: number;
  satisfied: number; tolerating: number; frustrated: number;
}
export interface BizKpis {
  /** Per RUM app id: current and previous period. */
  byApp: Map<string, { cur: BizPeriod; prev: BizPeriod }>;
}

const ZERO: BizPeriod = { sessions: 0, realSessions: 0, converted: 0, convertedReal: 0,
  hitReal: 0, fatalSessions: 0, engaged: 0, realEngaged: 0, actions: 0, abandoned: 0,
  satisfied: 0, tolerating: 0, frustrated: 0 };
const memo = new Map<string, BizKpis>();

export function useBizKpis(tf: Timeframe, defs?: OutcomeDefs,
  appId?: string | null): BizKpis | null {
  const key = `${tf.from}|${tf.to}|${appId ?? ""}|${JSON.stringify(defs ?? {})}`;
  const [out, setOut] = useState<BizKpis | null>(memo.get(key) ?? null);

  useEffect(() => {
    const hit = memo.get(key);
    if (hit) { setOut(hit); return; }
    setOut(null);
    let live = true;
    (async () => {
      try {
        const rows = await runDql<Record<string, unknown>>(qBizKpis(tf, defs, appId), 200);
        const byApp = new Map<string, { cur: BizPeriod; prev: BizPeriod }>();
        for (const r of rows) {
          const id = String(r.appId ?? "");
          if (!id) continue;
          const p: BizPeriod = {
            sessions: Number(r.sessions) || 0, realSessions: Number(r.realSessions) || 0,
            converted: Number(r.converted) || 0, convertedReal: Number(r.convertedReal) || 0,
            hitReal: Number(r.hitReal) || 0, fatalSessions: Number(r.fatalSessions) || 0,
            engaged: Number(r.engaged) || 0, realEngaged: Number(r.realEngaged) || 0,
            actions: Number(r.actions) || 0,
            abandoned: Number(r.abandoned) || 0, satisfied: Number(r.satisfied) || 0,
            tolerating: Number(r.tolerating) || 0, frustrated: Number(r.frustrated) || 0 };
          const slot = byApp.get(id) ?? { cur: ZERO, prev: ZERO };
          if (r.period === "cur") slot.cur = p; else slot.prev = p;
          byApp.set(id, slot);
        }
        const res: BizKpis = { byApp };
        memo.set(key, res);
        if (live) setOut(res);
      } catch { if (live) setOut({ byApp: new Map() }); }
    })();
    return () => { live = false; };
  }, [key]);

  return out;
}
