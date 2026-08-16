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
        // TWO row kinds share an appId: the main per-app row, and the Apdex
        // leg's row carrying only satisfied/tolerating/frustrated (the bands
        // live in their own subquery so Dynatrace's error rule can rate at
        // view-instance grain). MERGE them — a plain Map(rows.map(...)) let
        // the later row overwrite the earlier one, which zeroed every main
        // field and put "0 reached a user" beside "86% of sessions hit".
        const ZERO: UxRow = { sessions: 0, hit: 0, realSessions: 0, errors: 0,
          errorsThird: 0, realErrors: 0, hitReal: 0, hitRobot: 0, hitSynth: 0,
          engaged: 0, actions: 0, abandoned: 0, satisfied: 0, tolerating: 0,
          frustrated: 0, fragments: 0 };
        const out = new Map<string, UxRow>();
        for (const r of rows) {
          const id = String(r.appId);
          const cur = out.get(id) ?? { ...ZERO };
          for (const k of Object.keys(ZERO) as Array<keyof UxRow>) {
            if (r[k] !== null && r[k] !== undefined) cur[k] = Number(r[k]) || 0;
          }
          out.set(id, cur);
        }
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
