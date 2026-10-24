// The journey-mining reads, fetched only where journeys are read.
//
// Four user.events scans (views, sequences, transitions, friction) used to
// ride EVERY refresh, while only two screens consume them — Journeys and
// Business Control. The performance audit put the eager load at 30.4 GB;
// with these and the layer-stats pair moved behind their screens, Overview
// and the chain pay only for what they draw. Memoised per window (and per
// validation session), shared module-wide: opening Journeys after Business
// Control costs nothing new.
import { useEffect, useState } from "react";
import { useMemoGen } from "../utils/memo";
import { JOURNEY_BYTES_PER_SESSION, num, qFriction, qSequences, qTransitions, qViews, runDql,
  sliceFor, type Timeframe } from "../utils/dql";
import { mergeJourneys, type FrictionRow, type SeqRow, type TransitionRow,
  type ViewRow } from "./useChainData";

export interface JourneysData {
  views: ViewRow[]; sequences: SeqRow[];
  transitions: TransitionRow[]; friction: FrictionRow[];
  /** Minutes of the window actually read when it was sliced to the scan
   *  budget (counts are then scaled to the whole window); absent = all. */
  sliceMin?: number;
}

const memo = new Map<string, JourneysData>();

export function useJourneys(
  tf: Timeframe, active: boolean, session?: string | null,
  /** The application on screen. The journeys are mined per application and
   *  every consumer filters by it, so reading the estate was scanning — and
   *  paying for — paths nobody would draw. Measured on a production tenant,
   *  an estate-wide RUM scan of a 2h window cost about 230 GB against 32 GB
   *  scoped: these four were the most expensive page in the app once the
   *  Overview was dealt with. */
  appId?: string | null,
  /** Sessions of the window, to size the read to the budget (0.17.16). */
  sessions = 0,
): JourneysData | null {
  const gen = useMemoGen();
  /* INSIDE THE BUDGET. The four mining scans read ≈58 GiB of a ~6M-session
     hour on production. On such an application they read a settled slice of
     the window sized to OPTIONAL_SCAN_BUDGET_GIB (sliceFor) — sessions stay
     whole inside it, so the mined paths are real paths — and every count is
     scaled to the window; shares, rankings and paths are the slice's. A
     one-session url reads the whole window: it is one session. */
  const slice = session ? null : sliceFor(tf, (sessions * JOURNEY_BYTES_PER_SESSION) / 2 ** 30);
  const rt = slice ? slice.tf : tf;
  const k = slice ? 1 / slice.share : 1;
  const key = active ? `${rt.from}|${rt.to}|${session ?? ""}|${appId ?? ""}|${gen}` : "";
  const [out, setOut] = useState<JourneysData | null>(key ? memo.get(key) ?? null : null);

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
        const [views, sequences, transitions, friction] = await Promise.all([
          runDql<Record<string, unknown>>(qViews(rt, session, appId), 200),
          runDql<Record<string, unknown>>(qSequences(rt, session, appId), 1000),
          runDql<Record<string, unknown>>(qTransitions(rt, session, appId), 200),
          runDql<Record<string, unknown>>(qFriction(rt, session, appId), 30),
        ]);
        const res: JourneysData = {
          views: views.map((r) => ({
            appId: String(r.appId ?? ""), view: String(r.view ?? ""),
            views: Math.round(num(r.views) * k), sessions: Math.round(num(r.sessions) * k), p50: num(r.p50),
          })),
          sequences: mergeJourneys(sequences.map((r) => (k === 1 ? r
            : { ...r, sessions: Math.round(num(r.sessions) * k) }))),
          transitions: transitions.map((r) => ({
            appId: String(r.appId ?? ""), src: String(r.src ?? ""), dst: String(r.dst ?? ""),
            sessions: Math.round(num(r.sessions) * k), actions: Math.round(num(r.actions) * k),
            p50: num(r.p50), p90: num(r.p90), abandoned: Math.round(num(r.abandoned) * k),
            timeouts: Math.round(num(r.timeouts) * k), slowInp: Math.round(num(r.slowInp) * k),
          })),
          friction: friction.map((r) => ({
            appId: String(r.appId ?? ""), view: String(r.view ?? ""),
            tag: (r.tag as string | null) ?? null, xpath: (r.xpath as string | null) ?? null,
            actions: Math.round(num(r.actions) * k), abandoned: Math.round(num(r.abandoned) * k),
            timeouts: Math.round(num(r.timeouts) * k), cls: num(r.cls),
          })),
          ...(slice ? { sliceMin: slice.tf.minutes } : {}),
        };
        memo.set(key, res);
        if (live) setOut(res);
      } catch {
        if (live) setOut({ views: [], sequences: [], transitions: [], friction: [] });
      }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return out;
}
