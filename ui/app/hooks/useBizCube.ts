// Business Control's one scan — see qBizCube in utils/dql.
//
// Reads this window once (per session, grouped by the board's dimensions)
// and the window before it once (totals). KPIs, breakdown, error cost and
// difficulty are all derived from these rows in memory, so the four sections
// cannot disagree: they are sums over the same table.
//
// Read inside the scan budget since 0.17.35 (runSized): whole when the
// window fits, otherwise its last settled minutes against the same number of
// minutes before them, scaled. Only finals are memoised and cached.
import { useEffect, useState } from "react";
import { useMemoGen } from "../utils/memo";
import * as cache from "../utils/cache";
import { BIZ_CUBE_CAP, qBizCube, qBizPrev, runSized, type OutcomeDefs, type Timeframe } from "../utils/dql";
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
  /** Set when the window was read from its last N settled minutes to stay
   *  inside the scan budget; every count is scaled to the whole window. */
  sliceMin?: number;
  /** What one minute of this application's events costs to read, measured. */
  gibPerMin?: number;
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

/** Rows read from a share of the window, scaled to the whole of it. Every
 *  column is additive over sessions, so the ratios the board shows are the
 *  slice's own and the totals are the slice's times the window it stands for. */
const scaleRow = (r: CubeRow, f: number): CubeRow => {
  if (f === 1) return r;
  const o = { ...r, err: { ...r.err } };
  for (const k of Object.keys(o) as Array<keyof CubeRow>) {
    if (typeof o[k] === "number") (o as unknown as Record<string, number>)[k] = Math.round((o[k] as number) * f);
  }
  for (const b of Object.keys(o.err) as ErrBucket[]) o.err[b] = Math.round(o.err[b] * f);
  return o;
};

/* THE CACHE HOLDS COLUMNS, NOT OBJECTS (0.17.40). One row per country ×
   OS × browser × device × user type, each spelled out with ~40 key names,
   passed the store's 512 KB allowance on a large application and was never
   written — every reload read Grail again. The same rows as value arrays
   under one header are a fraction of the size. */
const ERR_KEYS = Object.keys(shapeRow({}).err) as ErrBucket[];
const COLS = (Object.keys(shapeRow({})) as Array<keyof CubeRow>).filter((k) => k !== "err");
type Packed = { c: string[]; r: unknown[][] };
const pack = (rows: CubeRow[]): Packed => ({
  c: [...COLS, ...ERR_KEYS.map((b) => `err.${b}`)],
  // whole numbers: counts already are, and the ns sums lose nothing a reader sees
  r: rows.map((x) => [...COLS.map((k) => (typeof x[k] === "number" ? Math.round(x[k] as number) : x[k])),
    ...ERR_KEYS.map((b) => x.err[b])]),
});
const unpack = (p: Packed | undefined): CubeRow[] | null => {
  if (!p || !Array.isArray(p.c) || !Array.isArray(p.r)) return null;
  return p.r.map((vals) => {
    const o = shapeRow({});
    p.c.forEach((k, i) => {
      if (k.startsWith("err.")) o.err[k.slice(4) as ErrBucket] = Number(vals[i]) || 0;
      else (o as unknown as Record<string, unknown>)[k] = vals[i];
    });
    return o;
  });
};
/** How long Business Control's reading stays usable after a reload. Marcelo,
 *  2026-10-25: up to ten minutes old, the board saying "cached Nm ago", is
 *  worth not paying ≈35 GiB per reload of a large application. */
const BIZ_CACHE_TTL = "now+10m";

const memo = new Map<string, BizCube>();
const pending = new Map<string, Promise<BizCube>>();

async function loadCube(tf: Timeframe, defs: OutcomeDefs | undefined,
  appId: string | null | undefined, fromCache: boolean): Promise<BizCube> {
  const prevMap = (rows: Record<string, unknown>[], f: number) => {
    const m = new Map<string, CubeRow>();
    for (const r of rows) { const row = scaleRow(shapeRow(r), f); if (row.appId) m.set(row.appId, row); }
    return m;
  };
  /* THE SAME CACHE THE CHAIN USES, for the same reason: a reader validating
     the page reloads it several times a minute. Refresh bypasses it (the
     generation is part of every key), and only finals are ever written. */
  const cacheKey = `biz|${tf.from}|${tf.to}|${appId ?? ""}|${JSON.stringify(defs ?? {})}`;
  if (fromCache) {
    const hit = await cache.read<{ cur: Packed; prev: Packed; sliceMin?: number;
      gibPerMin?: number }>(cacheKey);
    const cur = unpack(hit?.value?.cur);
    if (hit && cur) {
      const prevM = new Map<string, CubeRow>();
      for (const r of unpack(hit.value.prev) ?? []) prevM.set(r.appId, r);
      return { cur, prev: prevM, partial: false,
        capped: cur.length >= BIZ_CUBE_CAP, cachedAt: hit.at,
        sliceMin: hit.value.sliceMin, gibPerMin: hit.value.gibPerMin };
    }
  }
  /* INSIDE THE BUDGET (0.17.35). Both legs read the full window and the
     one before it: measured on a bank's production estate, ≈141 + 163 GiB
     per open, 34 s. They now run through runSized — a settled two-minute
     probe measures what a minute of THIS application costs, and the
     window is read whole if it fits OPTIONAL_SCAN_BUDGET_GIB, or as its
     last settled minutes against the same number of minutes before them,
     scaled. Previews are given up for it: a sliced read lands in seconds. */
  let res: BizCube;
  try {
    // a one-minute probe: at two it was ≈15 of the ≈35 GiB an open cost
    const sized = await runSized(tf, [
      { build: (t) => qBizCube(t, defs, appId), max: BIZ_CUBE_CAP },
      { build: (t) => qBizPrev(t, defs, appId), max: 50 },
    ], undefined, 1);
    const f = sized.share > 0 ? 1 / sized.share : 1;
    const cur = sized.rows[0].map((r) => scaleRow(shapeRow(r), f)).filter((r) => r.appId);
    res = { cur, prev: prevMap(sized.rows[1], f), partial: false,
      capped: sized.rows[0].length >= BIZ_CUBE_CAP,
      sliceMin: sized.share < 1 ? sized.tf.minutes : undefined,
      gibPerMin: sized.gibPerMin || undefined };
  } catch {
    return { cur: [], prev: new Map(), partial: false, capped: false };
  }
  if (res.cur.length) {
    void cache.write(cacheKey, { cur: pack(res.cur), prev: pack([...(res.prev?.values() ?? [])]),
      sliceMin: res.sliceMin, gibPerMin: res.gibPerMin }, tf.minutes, BIZ_CACHE_TTL);
  }
  return res;
}

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
    /* ONE READ PER KEY, SHARED (0.17.39). Three panels ask for this cube —
       KPIs, breakdown, difficulty — and runDql only shares a query while it
       is still running: a panel that asked a moment later paid the probe and
       the slice again. Measured on production: every Business Control
       statement ran twice, ≈74 GiB for one open where one read is ≈35. The
       load is now one promise per key, finished and memoised whether or not
       the panel that started it is still on screen. */
    let p = pending.get(key);
    if (!p) {
      p = loadCube(tf, defs, appId, gen === 0)
        .then((res) => { memo.set(key, res); return res; })
        .finally(() => { pending.delete(key); });
      pending.set(key, p);
    }
    void p.then((res) => { if (live) setOut(res); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return out;
}
