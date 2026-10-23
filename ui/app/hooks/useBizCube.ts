// Business Control's one scan — see qBizCube in utils/dql.
//
// Reads this window once (per session, grouped by the board's dimensions)
// and the window before it once (totals). KPIs, breakdown, error cost and
// difficulty are all derived from these rows in memory, so the four sections
// cannot disagree: they are sums over the same table.
//
// Previews paint, finals decide, only finals are memoised — the Overview's
// rule, unchanged. Both legs run from the start; the cube's preview is what
// lets the board draw within seconds on an estate where a full hour of RUM
// takes twenty seconds to read.
import { useEffect, useState } from "react";
import { useMemoGen } from "../utils/memo";
import * as cache from "../utils/cache";
import { BIZ_CUBE_CAP, qBizCube, qBizPrev, runDql, type OutcomeDefs, type Timeframe } from "../utils/dql";
import type { ErrBucket } from "./useDifficulty";

export interface CubeRow {
  appId: string;
  country: string; os: string; browser: string; deviceType: string; userType: string;
  sessions: number; realSessions: number; converted: number; convertedReal: number;
  hit: number; hitReal: number; hitConv: number; realHitConv: number;
  fatalSessions: number; waitedReal: number; engaged: number; realEngaged: number;
  actions: number; abandoned: number; satisfied: number; tolerating: number; frustrated: number;
  /** Sessions that met at least one error of each origin. */
  err: Record<ErrBucket, number>;
  slowViews: number; slowMeas: number; net: number; srv: number; rend: number;
}
export interface BizCube {
  cur: CubeRow[];
  /** Per app id: the previous window's totals. Null until that leg lands. */
  prev: Map<string, CubeRow> | null;
  /** The current rows are a PREVIEW — real, measured, not yet whole. */
  partial: boolean;
  /** The group cap cut the current rows: the segments are floors. */
  capped: boolean;
  /** Set when these came back from the per-user cache rather than Grail —
   *  the board says how old they are instead of passing them off as live. */
  cachedAt?: number;
}

const n = (v: unknown) => Number(v) || 0;
const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
export const shapeRow = (r: Record<string, unknown>): CubeRow => ({
  appId: str(r.appId),
  country: str(r.country), os: str(r.os), browser: str(r.browser),
  deviceType: str(r.deviceType), userType: str(r.userType),
  sessions: n(r.sessions), realSessions: n(r.realSessions),
  converted: n(r.converted), convertedReal: n(r.convertedReal),
  hit: n(r.hit), hitReal: n(r.hitReal), hitConv: n(r.hitConv), realHitConv: n(r.realHitConv),
  fatalSessions: n(r.fatalSessions), waitedReal: n(r.waitedReal),
  engaged: n(r.engaged), realEngaged: n(r.realEngaged),
  actions: n(r.actions), abandoned: n(r.abandoned),
  satisfied: n(r.satisfied), tolerating: n(r.tolerating), frustrated: n(r.frustrated),
  err: { device: n(r.errDevice), third_party: n(r.errThird), policy: n(r.errPolicy),
    frontend: n(r.errFrontend), backend: n(r.errBackend), connection: n(r.errConnection),
    request_4xx: n(r.err4xx), other: n(r.errOther) },
  slowViews: n(r.slowViews), slowMeas: n(r.slowMeas), net: n(r.net), srv: n(r.srv), rend: n(r.rend),
});

/** Sum of the additive columns over a set of rows — the KPI arithmetic. */
export const sumRows = (rows: CubeRow[], appId = ""): CubeRow => {
  const z = shapeRow({}); z.appId = appId;
  for (const r of rows) {
    for (const k of Object.keys(z) as Array<keyof CubeRow>) {
      if (k === "err") { for (const b of Object.keys(z.err) as ErrBucket[]) z.err[b] += r.err[b]; }
      else if (typeof z[k] === "number") (z as unknown as Record<string, number>)[k] += r[k] as number;
    }
  }
  return z;
};

const memo = new Map<string, BizCube>();

export function useBizCube(tf: Timeframe, defs?: OutcomeDefs,
  appId?: string | null): BizCube | null {
  const gen = useMemoGen();
  const key = `${tf.from}|${tf.to}|${appId ?? ""}|${JSON.stringify(defs ?? {})}|${gen}`;
  const [out, setOut] = useState<BizCube | null>(memo.get(key) ?? null);

  useEffect(() => {
    const hit = memo.get(key);
    if (hit) { setOut(hit); return; }
    setOut(null);
    let live = true;
    let cur: CubeRow[] | null = null, prev: Map<string, CubeRow> | null = null;
    let curFinal = false;
    /* THE SAME CACHE THE CHAIN USES, for the same reason. Measured on a
       bank's production estate: the two legs behind this board take 36–40 s
       to finish, and a reader validating the page reloads it several times
       a minute — every reload a fresh ~300 GB. The chain loader already
       keeps its payload in the per-user state store for a window-sized TTL
       and prints "cached Ns ago"; the cube does the same. Refresh bypasses
       it (the generation is part of every key, and a bumped generation is
       the reader saying "go to Grail"), and only the two FINALS together are
       ever written — a preview is never served back as a measurement. */
    const cacheKey = `biz|${tf.from}|${tf.to}|${appId ?? ""}|${JSON.stringify(defs ?? {})}`;
    const fromCache = gen === 0;
    const paint = () => {
      if (!live || !cur) return;
      setOut({ cur, prev, partial: true, capped: cur.length >= BIZ_CUBE_CAP });
    };
    const prevMap = (rows: Record<string, unknown>[]) => {
      const m = new Map<string, CubeRow>();
      for (const r of rows) { const row = shapeRow(r); if (row.appId) m.set(row.appId, row); }
      return m;
    };
    (async () => {
      if (fromCache) {
        const hit = await cache.read<{ cur: CubeRow[]; prev: CubeRow[] }>(cacheKey);
        if (!live) return;
        if (hit && Array.isArray(hit.value?.cur)) {
          const prevM = new Map<string, CubeRow>();
          for (const r of hit.value.prev ?? []) prevM.set(r.appId, r);
          const res: BizCube = { cur: hit.value.cur, prev: prevM, partial: false,
            capped: hit.value.cur.length >= BIZ_CUBE_CAP, cachedAt: hit.at };
          memo.set(key, res);
          setOut(res);
          return;
        }
      }
      const curP = runDql<Record<string, unknown>>(qBizCube(tf, defs, appId), BIZ_CUBE_CAP,
        undefined, (early) => {
          if (!live || !early.length || curFinal) return;
          cur = early.map(shapeRow).filter((r) => r.appId); paint();
        });
      /* THE PAST PREVIEWS TOO. Measured on a bank's production estate: the
         cube's first rows land at ~6 s and its final at ~40 s; the previous
         window's first rows at ~3 s and its final at ~36 s. Holding the
         cards for the past's FINAL meant a blank board for half a minute
         while both legs had real rows in hand. Both are the same
         measurement, incomplete, and the board marks them "measuring…"
         until both are whole — the delta is read as a preview of a delta,
         which is what it is. Only the two finals together are memoised. */
      let prevFinal = false;
      const prevP = runDql<Record<string, unknown>>(qBizPrev(tf, defs, appId), 50,
        undefined, (early) => {
          if (!live || !early.length || prevFinal) return;
          prev = prevMap(early); paint();
        });
      const paintState = () => {
        if (!live || !cur) return;
        setOut({ cur, prev, partial: !(curFinal && prevFinal),
          capped: cur.length >= BIZ_CUBE_CAP });
      };
      try {
        const rows = await curP;
        cur = rows.map(shapeRow).filter((r) => r.appId); curFinal = true; paintState();
      } catch { cur = []; curFinal = true; paintState(); }
      try { prev = prevMap(await prevP); } catch { prev = new Map(); }
      prevFinal = true; paintState();
      if (live && cur) {
        const res: BizCube = { cur, prev, partial: false, capped: cur.length >= BIZ_CUBE_CAP };
        memo.set(key, res);
        void cache.write(cacheKey, { cur, prev: [...(prev?.values() ?? [])] }, tf.minutes);
      }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return out;
}
