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
import { useMemoGen } from "../utils/memo";
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
  /** Of the frustrated: actions an ERRORED VIEW reassigned there (Dynatrace's
   *  error rule at view grain) rather than slowness. Feeds the explainer. */
  fruErr: number;
  /** Sessions whose only in-window content is stray metadata — their real
   *  activity happened outside the window. Not journeys; excluded from
   *  funnels, reported as a transparency line. */
  fragments: number;
}

const memo = new Map<string, Map<string, UxRow>>();

/** Impact per application id, or null while loading / when the query failed. */
export function useUxOverview(
  tf: Timeframe, appId?: string | null,
  /** True when the caller draws the estate comparison and must pay for it. */
  wide = false,
): Map<string, UxRow> | null {
  const gen = useMemoGen();
  // the scope is part of the key: a payload that lacked this application
  // must not answer for the request that went and fetched it
  const key = `${tf.from}|${tf.to}|${appId ?? ""}|${wide ? "w" : "s"}|${gen}`;
  const [map, setMap] = useState<Map<string, UxRow> | null>(memo.get(key) ?? null);

  useEffect(() => {
    const hit = memo.get(key);
    if (hit) { setMap(hit); return; }

    let live = true;
    setMap(null);
    (async () => {
      try {
        /* THE SELECTED APPLICATION IS NEVER CROWDED OUT.
           The estate scan answers the comparison line and is capped at a
           hundred rows; a production tenant has more frontends than that, and
           the row that falls off is the one on screen — an Apdex reading "—"
           over hundreds of thousands of rated actions. So when the estate's
           answer does not contain the application being shown, it is asked
           for on its own. One extra query, only where the cap actually bit,
           and a fraction of the scan the estate costs. */
        /* THE ESTATE SCAN ONLY WHEN THE ESTATE IS THE QUESTION.
           Measured in production: this is the per-session summarize over
           every application, it is the query that hit Grail's 500 GB limit,
           and the page used it to fill ONE card's Apdex bands plus a single
           comparison line. Scoped, it is a fraction of that. The comparison
           line is the only thing that needs the whole estate, so it is the
           only thing that pays for it — and when it cannot be drawn, it says
           so rather than comparing an application with itself. */
        const rows = wide
          ? await runDql<Record<string, unknown>>(qUxByApp(tf), 100)
          : [] as Record<string, unknown>[];
        /* ALWAYS, NOT ONLY WHEN THE ROW IS MISSING.
           The first cut asked for the application on its own when the estate
           answer did not contain it — and the Apdex stayed blank, because
           this query returns TWO rows per application and only one of them
           carries the bands. The main row survived the hundred-row cap while
           its Apdex row did not, so the application looked present and its
           score did not exist. A presence test that can be half right is
           worse than no test: it fails quietly on exactly the estates the cap
           was going to hurt.
           So the scoped rows are always fetched when an application is
           selected, and they are merged LAST, which makes them win. It is the
           cheap query of the two — and it is the shape the estate scan should
           eventually take for everything except the comparison line. */
        if (appId) {  // eslint-disable-line no-constant-condition
          try {
            rows.push(...await runDql<Record<string, unknown>>(
              qUxByApp(tf, appId), 8));
          } catch { /* the estate's answer still stands on its own */ }
        }
        // TWO row kinds share an appId: the main per-app row, and the Apdex
        // leg's row carrying only satisfied/tolerating/frustrated (the bands
        // live in their own subquery so Dynatrace's error rule can rate at
        // view-instance grain). MERGE them — a plain Map(rows.map(...)) let
        // the later row overwrite the earlier one, which zeroed every main
        // field and put "0 reached a user" beside "86% of sessions hit".
        const ZERO: UxRow = { sessions: 0, hit: 0, realSessions: 0, errors: 0,
          errorsThird: 0, realErrors: 0, hitReal: 0, hitRobot: 0, hitSynth: 0,
          engaged: 0, actions: 0, abandoned: 0, satisfied: 0, tolerating: 0,
          frustrated: 0, fruErr: 0, fragments: 0 };
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
