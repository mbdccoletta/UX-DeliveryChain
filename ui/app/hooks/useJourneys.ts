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
import { num, qFriction, qSequences, qTransitions, qViews, runDql,
  runSized, type Timeframe } from "../utils/dql";
import { mergeJourneys, type FrictionRow, type SeqRow, type TransitionRow,
  type ViewRow } from "./useChainData";

export interface JourneysData {
  views: ViewRow[]; sequences: SeqRow[];
  transitions: TransitionRow[]; friction: FrictionRow[];
  /** Minutes of the window actually read when it was sliced to the scan
   *  budget (counts are then scaled to the whole window); absent = all. */
  sliceMin?: number;
  /** The mining failed — not "no paths". Never memoised. */
  failed?: boolean;
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
  /** Sessions of the window (no longer used to size the read: 0.17.33). */
  _sessions = 0,
): JourneysData | null {
  const gen = useMemoGen();
  /* INSIDE THE BUDGET. The four mining scans read ≈58 GiB of a ~6M-session
     hour on production. On such an application they read a settled slice of
     the window sized to OPTIONAL_SCAN_BUDGET_GIB (sliceFor) — sessions stay
     whole inside it, so the mined paths are real paths — and every count is
     scaled to the window; shares, rankings and paths are the slice's. A
     one-session url reads the whole window: it is one session. */
  /* …sized by a measured probe since 0.17.33 (runSized), not by sessions. */
  const key = active ? `${tf.from}|${tf.to}|${session ?? ""}|${appId ?? ""}|${gen}` : "";
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
        const sized = session
          ? { rows: await Promise.all([
                runDql<Record<string, unknown>>(qViews(tf, session, appId), 200),
                runDql<Record<string, unknown>>(qSequences(tf, session, appId), 1000),
                runDql<Record<string, unknown>>(qTransitions(tf, session, appId), 200),
                runDql<Record<string, unknown>>(qFriction(tf, session, appId), 30),
              ]), tf, share: 1 }
          : await runSized(tf, [
              { build: (t) => qViews(t, session, appId), max: 200 },
              { build: (t) => qSequences(t, session, appId), max: 1000 },
              { build: (t) => qTransitions(t, session, appId), max: 200 },
              { build: (t) => qFriction(t, session, appId), max: 30 },
            ]);
        const [views, sequences, transitions, friction] = sized.rows;
        const slice = sized.share < 1 ? { tf: sized.tf, share: sized.share } : null;
        const k = 1 / sized.share;
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
        // a read cut by the scan ceiling is shown once, never remembered as whole
        if (!("truncated" in sized && sized.truncated)) memo.set(key, res);
        if (live) setOut(res);
      } catch {
        if (live) setOut({ views: [], sequences: [], transitions: [], friction: [], failed: true });
      }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return out;
}
