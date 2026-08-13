// The landing page's own data: a trend and every breakdown, two scans total.
//
// The trend is sessions and errors per bin — the shape of the last hours, not
// just their sum. The breakdown query returns the full dimension tuple and is
// rolled up per dimension HERE: a session carries one OS, one device, one app
// version and one country, so the tuple stays small and one scan answers what
// the classic overview asks four panels about.
//
// Memoised per application and timeframe, like every other landing query: the
// first page must not bill twice for being looked at twice.
import { useEffect, useState } from "react";
import { qPulseBreakdown, qPulseSeries, runDql, type Timeframe } from "../utils/dql";

export interface PulsePoint {
  t: string; sessions: number; errors: number; actions: number; requests: number;
}

export interface PulseSlice { label: string; sessions: number; errors: number }

export interface PulseData {
  series: PulsePoint[];
  /** KPIs only the breakdown scan knows. */
  appStarts: number;
  actions: number;
  requests: number;
  /** Requests answered 4xx/5xx — the web-requests error rate's numerator. */
  reqFail: number;
  /** Errors whose type is an exception — the closest measurable kin of a
   *  crash: this RUM schema records no crash classifier at all. */
  exceptions: number;
  /** Top slices per dimension, largest first, blanks dropped. */
  os: PulseSlice[];
  devices: PulseSlice[];
  versions: PulseSlice[];
  countries: PulseSlice[];
  userTypes: PulseSlice[];
}

const memo = new Map<string, PulseData | null>();

/** Rolls the tuple rows up into one dimension's top slices. */
function rollup(
  rows: Array<Record<string, unknown>>, label: (r: Record<string, unknown>) => string,
): PulseSlice[] {
  const acc = new Map<string, PulseSlice>();
  for (const r of rows) {
    const l = label(r).trim();
    if (!l || l === "null" || l === "—") continue;
    const hit = acc.get(l) ?? { label: l, sessions: 0, errors: 0 };
    hit.sessions += Number(r.sessions) || 0;
    hit.errors += Number(r.errors) || 0;
    acc.set(l, hit);
  }
  return [...acc.values()].sort((a, b) => b.sessions - a.sessions).slice(0, 6);
}

export function usePulse(rumAppId?: string, tf?: Timeframe): PulseData | null {
  const key = rumAppId && tf ? `${rumAppId}|${tf.from}|${tf.to}` : "";
  const [data, setData] = useState<PulseData | null>(key ? memo.get(key) ?? null : null);

  useEffect(() => {
    if (!key) { setData(null); return; }
    if (memo.has(key)) { setData(memo.get(key) ?? null); return; }

    let live = true;
    setData(null);
    (async () => {
      let out: PulseData | null = null;
      try {
        const [series, tuples] = await Promise.all([
          runDql<Record<string, unknown>>(qPulseSeries(tf!, rumAppId!), 200),
          runDql<Record<string, unknown>>(qPulseBreakdown(tf!, rumAppId!), 500),
        ]);
        out = {
          series: series.map((r) => ({
            t: String(r.t ?? ""), sessions: Number(r.sessions) || 0,
            errors: Number(r.errors) || 0, actions: Number(r.actions) || 0,
            requests: Number(r.requests) || 0,
          })),
          appStarts: tuples.reduce((a, r) => a + (Number(r.starts) || 0), 0),
          actions: tuples.reduce((a, r) => a + (Number(r.actions) || 0), 0),
          requests: tuples.reduce((a, r) => a + (Number(r.requests) || 0), 0),
          reqFail: tuples.reduce((a, r) => a + (Number(r.reqfail) || 0), 0),
          exceptions: tuples.reduce((a, r) => a + (Number(r.exceptions) || 0), 0),
          os: rollup(tuples, (r) => r.os ? `${r.os}${r.osv ? " " + r.osv : ""}` : ""),
          devices: rollup(tuples, (r) => r.man || r.model
            ? [r.man, r.model].filter(Boolean).join(" ") : ""),
          versions: rollup(tuples, (r) => r.ver ? String(r.ver) : ""),
          countries: rollup(tuples, (r) => r.cc ? String(r.cc) : ""),
          userTypes: rollup(tuples, (r) => r.ut ? String(r.ut) : ""),
        };
      } catch {
        /* the page still renders from the shared data — panels just close */
      }
      memo.set(key, out);
      if (live) setData(out);
    })();

    return () => { live = false; };
  }, [key, rumAppId, tf]);

  return data;
}
