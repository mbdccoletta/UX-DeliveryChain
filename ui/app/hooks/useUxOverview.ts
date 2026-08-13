// The user-experience verdict per application, for the overview page.
//
// One scan answers it for every application at once: how many sessions the
// window held, and how many of them hit at least one error — split by who the
// session belonged to, because "954 impacted robots" and "954 impacted people"
// are different findings wearing the same number.
//
// Memoised per timeframe: the overview is the landing page, and landing twice
// should not scan twice.
import { useEffect, useState } from "react";
import { qUxByApp, runDql, type Timeframe } from "../utils/dql";

export interface UxRow {
  sessions: number;
  hit: number;
  /** Sessions belonging to real people — robots and monitors excluded. */
  realSessions: number;
  /** Errors in the window: all of them, the third-party share, and the
   *  share that actually reached a person. */
  errors: number;
  errorsThird: number;
  realErrors: number;
  hitReal: number;
  hitRobot: number;
  hitSynth: number;
  /** Sessions that went past their first view — conversion, absent a goal. */
  engaged: number;
  /** User actions in the window, and how many were abandoned mid-flight. */
  actions: number;
  abandoned: number;
  /** Apdex bands over user actions — see utils/apdex.ts for T and the formula. */
  satisfied: number;
  tolerating: number;
  frustrated: number;
  /** Sessions whose only in-window content is stray metadata — their real
   *  activity happened outside the window. Not journeys; excluded from
   *  funnels, reported as a transparency line. */
  fragments: number;
}

const memo = new Map<string, Map<string, UxRow>>();

/** Impact per application id, or null while loading / when the query failed. */
export function useUxOverview(tf: Timeframe): Map<string, UxRow> | null {
  const key = `${tf.from}|${tf.to}`;
  const [map, setMap] = useState<Map<string, UxRow> | null>(memo.get(key) ?? null);

  useEffect(() => {
    const hit = memo.get(key);
    if (hit) { setMap(hit); return; }

    let live = true;
    setMap(null);
    (async () => {
      try {
        const rows = await runDql<Record<string, unknown>>(qUxByApp(tf), 100);
        const out = new Map<string, UxRow>(rows.map((r) => [String(r.appId), {
          sessions: Number(r.sessions) || 0, hit: Number(r.hit) || 0,
          realSessions: Number(r.realSessions) || 0,
          errors: Number(r.errors) || 0, errorsThird: Number(r.errorsThird) || 0,
          realErrors: Number(r.realErrors) || 0,
          hitReal: Number(r.hitReal) || 0, hitRobot: Number(r.hitRobot) || 0,
          hitSynth: Number(r.hitSynth) || 0,
          engaged: Number(r.engaged) || 0,
          actions: Number(r.actions) || 0, abandoned: Number(r.abandoned) || 0,
          satisfied: Number(r.satisfied) || 0, tolerating: Number(r.tolerating) || 0,
          frustrated: Number(r.frustrated) || 0,
          fragments: Number(r.fragments) || 0,
        }]));
        memo.set(key, out);
        if (live) setMap(out);
      } catch {
        /* the overview still renders — cards just omit the UX verdict */
      }
    })();

    return () => { live = false; };
  }, [key, tf]);

  return map;
}
