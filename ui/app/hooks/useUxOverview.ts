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
import { isExactLimit, markOverExactLimit, overExactLimit, qExperience, qUxByApp, qUxLean, runDql, type Timeframe } from "../utils/dql";

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
  /** Experience weights over user actions — the platform's own rating, see utils/apdex.ts. */
  satisfied: number;
  tolerating: number;
  frustrated: number;
  /** Rated user actions, counted (not weighted), and how many of them
   *  carried an error of their own (error.count / has_crash on the action). */
  ratedActs: number;
  errActions: number;
  /** Crashes and freezes of real people's sessions — each is one frustrated
   *  element in the experience score (see qExperience). */
  scoreCrashes: number;
  /** Sessions whose only in-window content is stray metadata — their real
   *  activity happened outside the window. Not journeys; excluded from
   *  funnels, reported as a transparency line. */
  fragments: number;
}

const memo = new Map<string, UxMap>();

/** Impact per application id, or null while loading / when the query failed. */
/** A Map of UxRow per app id, plus whether each of its two scans is still a
 *  PREVIEW: `partial` for the per-session impact (the verdict waits on it),
 *  `scorePartial` for the experience score (only the score's caption does). */
export type UxMap = Map<string, UxRow> & { partial?: boolean; scorePartial?: boolean;
  /** Some session count is the precision-16 estimate (see distinctFn). */
  approx?: boolean };

const ZERO: UxRow = { sessions: 0, hit: 0, realSessions: 0, errors: 0,
  errorsThird: 0, realErrors: 0, hitReal: 0, hitRobot: 0, hitSynth: 0,
  engaged: 0, actions: 0, abandoned: 0, satisfied: 0, tolerating: 0,
  frustrated: 0, ratedActs: 0, errActions: 0, scoreCrashes: 0, fragments: 0 };

/* TWO row kinds share an appId — the main row and the Apdex leg's row — and
   they are MERGED field by field, never overwritten (see the note that used
   to live inside the effect). */
const fold = (rows: Record<string, unknown>[]): UxMap => {
  const out: UxMap = new Map();
  for (const r of rows) {
    const id = String(r.appId);
    const cur = out.get(id) ?? { ...ZERO };
    for (const k of Object.keys(ZERO) as Array<keyof UxRow>) {
      if (r[k] !== null && r[k] !== undefined) cur[k] = Number(r[k]) || 0;
    }
    out.set(id, cur);
  }
  return out;
};

export function useUxOverview(
  tf: Timeframe, appId?: string | null,
  /** True when the caller draws the estate comparison and must pay for it. */
  wide = false,
  /** False while nothing on screen reads the answer — the scan is a full
   *  read of the window's RUM, and App mounted it on every page for the one
   *  tab (Journeys) that draws it. */
  active = true,
  /** THE LEAN PASS (0.16.0). One scan of the two event kinds that can hurt
   *  a person — errors and user actions — answers the verdict's numerator
   *  and the experience score together. Validated field by field beside the
   *  per-session scan and the score query on staging, exact to the unit on a
   *  settled window. It carries NO session totals: the caller takes those
   *  from the scoped census (exact), which the page already reads. The
   *  fields only the Journeys tab needs (engaged, abandoned, fragments) are
   *  not in it, so that caller keeps the per-session scan. */
  lean = false,
): UxMap | null {
  const gen = useMemoGen();
  // the scope is part of the key: a payload that lacked this application
  // must not answer for the request that went and fetched it
  const key = `${tf.from}|${tf.to}|${appId ?? ""}|${wide ? "w" : "s"}|${lean ? "lean" : "full"}|${gen}`;
  const [map, setMap] = useState<UxMap | null>(memo.get(key) ?? null);

  useEffect(() => {
    const hit = memo.get(key);
    if (hit) { setMap(hit); return; }
    if (!active) { setMap(null); return; }

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
        if (lean && appId && !wide) {
          let final = false;
          const paint = (rows: Record<string, unknown>[]) => {
            if (!live) return;
            const m = fold(rows.map((r) => ({ ...r, appId })));
            m.partial = !final; m.scorePartial = !final;
            setMap(m);
          };
          let approx = false;
          const ask = (exact: boolean) => runDql<Record<string, unknown>>(qUxLean(tf, appId, exact), 1,
            undefined, (early) => { if (early.length && !final) paint(early); });
          // over the exact-count element limit, the estimate — and said so
          // an application already known to exceed the exact limit — its
          // census did — is asked for the estimate directly (see overExactLimit)
          // keyed apart from the census: the affected sessions are far fewer
          // than all sessions and usually stay exact (157k did, in production)
          const overKey = `${appId}:hit`;
          const known = overExactLimit(overKey);
          if (known) approx = true;
          const rows = await (known ? ask(false) : ask(true).catch((e: unknown) => {
            if (!isExactLimit(e)) throw e;
            markOverExactLimit(overKey);
            approx = true;
            return ask(false);
          }));
          final = true;
          const out = fold(rows.map((r) => ({ ...r, appId })));
          out.approx = approx;
          memo.set(key, out);
          if (live) setMap(out);
          return;
        }
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
          /* TWO SCANS, SIDE BY SIDE, EACH WITH ITS OWN "MEASURING". The
             per-session scan decides the verdict; the lean score scan
             (qExperience) decides the score. Neither waits for the other —
             the score's sums once rode inside the per-session scan and held
             the verdict back by 13 s. Previews paint, marked; finals decide;
             only the pair of finals is memoised. */
          let main: Record<string, unknown>[] = [], score: Record<string, unknown>[] = [];
          let mainFinal = false, scoreFinal = false;
          const paint = () => {
            if (!live) return;
            const m = fold([...rows, ...main, ...score.map((r) => ({ ...r, appId }))]);
            m.partial = !mainFinal; m.scorePartial = !scoreFinal;
            setMap(m);
          };
          const mainP = runDql<Record<string, unknown>>(qUxByApp(tf, appId), 8, undefined,
            (early) => { if (early.length && !mainFinal) { main = early; paint(); } })
            .then((r) => { main = r; }).catch(() => { main = []; })
            .finally(() => { mainFinal = true; paint(); });
          const scoreP = runDql<Record<string, unknown>>(qExperience(tf, appId), 1, undefined,
            (early) => { if (early.length && !scoreFinal) { score = early; paint(); } })
            .then((r) => { score = r; }).catch(() => { score = []; })
            .finally(() => { scoreFinal = true; paint(); });
          await Promise.all([mainP, scoreP]);
          const out = fold([...rows, ...main, ...score.map((r) => ({ ...r, appId }))]);
          memo.set(key, out);
          if (live) setMap(out);
          return;
        }
        const out = fold(rows);
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


/** THE LEAN PASS'S DENOMINATOR. Fills one application's session totals from
 *  the scoped census (exact, countDistinctExact) and keeps the row a preview
 *  until that census is final — a ratio over a preview denominator is the
 *  very thing the verdict refuses to print. */
export function withCensus(
  map: UxMap | null, appId: string,
  census: { sessions: number; realSessions?: number } | undefined,
  censusFinal: boolean,
  censusApprox = false,
): UxMap | null {
  if (!map) return null;
  const row = map.get(appId);
  const out: UxMap = new Map(map);
  out.partial = !!map.partial || !censusFinal || !census;
  out.scorePartial = map.scorePartial;
  out.approx = !!map.approx || !!censusApprox;
  if (row && census) {
    out.set(appId, { ...row, sessions: census.sessions,
      realSessions: census.realSessions ?? 0 });
  }
  return out;
}
