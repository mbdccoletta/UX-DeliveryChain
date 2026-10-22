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
  type Timeframe } from "../utils/dql";
import { mergeJourneys, type FrictionRow, type SeqRow, type TransitionRow,
  type ViewRow } from "./useChainData";

export interface JourneysData {
  views: ViewRow[]; sequences: SeqRow[];
  transitions: TransitionRow[]; friction: FrictionRow[];
}

const memo = new Map<string, JourneysData>();

export function useJourneys(
  tf: Timeframe, active: boolean, session?: string | null,
): JourneysData | null {
  const gen = useMemoGen();
  const key = active ? `${tf.from}|${tf.to}|${session ?? ""}|${gen}` : "";
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
          runDql<Record<string, unknown>>(qViews(tf, session), 200),
          runDql<Record<string, unknown>>(qSequences(tf, session), 1000),
          runDql<Record<string, unknown>>(qTransitions(tf, session), 200),
          runDql<Record<string, unknown>>(qFriction(tf, session), 30),
        ]);
        const res: JourneysData = {
          views: views.map((r) => ({
            appId: String(r.appId ?? ""), view: String(r.view ?? ""),
            views: num(r.views), sessions: num(r.sessions), p50: num(r.p50),
          })),
          sequences: mergeJourneys(sequences),
          transitions: transitions.map((r) => ({
            appId: String(r.appId ?? ""), src: String(r.src ?? ""), dst: String(r.dst ?? ""),
            sessions: num(r.sessions), actions: num(r.actions),
            p50: num(r.p50), p90: num(r.p90), abandoned: num(r.abandoned),
            timeouts: num(r.timeouts), slowInp: num(r.slowInp),
          })),
          friction: friction.map((r) => ({
            appId: String(r.appId ?? ""), view: String(r.view ?? ""),
            tag: (r.tag as string | null) ?? null, xpath: (r.xpath as string | null) ?? null,
            actions: num(r.actions), abandoned: num(r.abandoned),
            timeouts: num(r.timeouts), cls: num(r.cls),
          })),
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
