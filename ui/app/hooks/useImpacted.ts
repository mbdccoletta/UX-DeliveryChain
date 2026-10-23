// Who the errors reached, fetched only when a drawer with signals is open.
//
// The count backs the "Users impacted" row, and the exemplar session backs the
// two unit-session steps in the routes. Both are application-level facts: a
// failing pod does not know its users, but the chain is the application's, so
// the impact shown next to any of its components is the application's impact.
//
// Fetched lazily — most drawers are opened on healthy elements, where the row
// does not render and the query would be spend without a reader — and memoised
// per application and timeframe for the life of the session.
import { useEffect, useState } from "react";
import { useMemoGen } from "../utils/memo";
import { qImpacted, qImpactedSessions, runDql, withinSessionLag,
  type Timeframe } from "../utils/dql";

export interface Impacted {
  /** Distinct sessions in the window — the denominator. */
  sessions: number;
  /** Sessions that hit at least one error — the impact. */
  hit: number;
  /** Sessions belonging to real people — robots and monitors excluded. */
  realSessions: number;
  hitReal: number;
  hitRobot: number;
  hitSynth: number;
  /** The worst-hit session, carrying what the session intents require. */
  ex?: { sid: string; start: string; inst?: string; errs: number };
  /** True while these came from a PREVIEW: real, measured, not yet whole. */
  partial?: boolean;
  /** The experience score, when the caller has it final — carried here so a
   *  builder that judges from impact judges with the score too. */
  score?: number | null;
  /** Which store counted: "sessions" is what Users & Sessions lists;
   *  "events" is every session active in the window, which the list will
   *  not match. The card says which one it is showing. */
  base?: "sessions" | "events";
}

const memo = new Map<string, Impacted | null>();

/**
 * Impact for an application, or null while loading / when unavailable.
 *
 * `frontendName` decides WHICH STORE answers. With it, the figures come from
 * `user.sessions` — the store Users & Sessions reads — so the number on the
 * card is the number its own button opens, which is the whole point of
 * measuring it there. Without it (the name scan is still in flight, or this
 * estate has no frontend node for the application) the original per-session
 * scan of `user.events` answers, as it always did.
 */
export function useImpacted(
  rumAppId?: string, tf?: Timeframe, active = false, frontendName?: string,
): Impacted | null {
  const gen = useMemoGen();
  /* THE KEY NAMES ONLY WHAT CHANGES THE QUERY. Inside the session store's
     lag (a 30-minute window) the frontend name is irrelevant — the event scan
     runs whether or not the name has resolved — yet it was part of the key,
     so the scan ran once with the name empty and once again when it landed:
     the one duplicate left in a production load, and a full per-session
     scan paid twice for the same answer. */
  const fe = frontendName && !withinSessionLag(tf!) ? frontendName : "";
  const key = rumAppId && tf ? `${rumAppId}|${tf.from}|${tf.to}|${fe}|${gen}` : "";
  const [imp, setImp] = useState<Impacted | null>(key ? memo.get(key) ?? null : null);

  useEffect(() => {
    if (!key || !active) { setImp(key ? memo.get(key) ?? null : null); return; }
    if (memo.has(key)) { setImp(memo.get(key) ?? null); return; }

    // Drop the previous application's answer BEFORE fetching the next one.
    // Without this the ring, the verdict and "sessions hit" kept showing the
    // app you just switched away from until the new scan landed — the same
    // reflection the chain had, in the numbers instead of the layers.
    setImp(null);
    let live = true;
    (async () => {
      let out: Impacted | null = null;
      /* Rows → Impacted, whichever store produced them: both queries project
         the same names, which is the only reason one reader can serve both. */
      const shape = (r?: Record<string, unknown>): Impacted | null => {
        if (!r) return null;
        const o: Impacted = {
          sessions: Number(r.sessions) || 0, hit: Number(r.hit) || 0,
          realSessions: Number(r.realSessions) || 0,
          hitReal: Number(r.hitReal) || 0, hitRobot: Number(r.hitRobot) || 0,
          hitSynth: Number(r.hitSynth) || 0,
        };
        // an exemplar only counts when it actually erred — a healthy session
        // proves nothing about the impact
        if (r.exSid && r.exStart && Number(r.exErrs) > 0) {
          o.ex = {
            sid: String(r.exSid), start: String(r.exStart),
            inst: r.exInst ? String(r.exInst) : undefined,
            errs: Number(r.exErrs) || 0,
          };
        }
        return o;
      };
      /* A FIGURE THAT FIRMS UP BEATS A BLANK ONE.
         This scan is 20-30 seconds on a large application, and the card is
         the first thing a reader looks at. The preview lands in a few
         seconds; `partial` marks it so the card can say it is still
         measuring, and the final answer replaces it. */
      const ask = async (q: string) =>
        shape((await runDql<Record<string, unknown>>(q, 1, undefined, (rows) => {
          const early = shape(rows[0]);
          if (early && live) setImp({ ...early, partial: true });
        }))[0]);
      try {
        /* INSIDE THE STORE'S LAG, THE STORE IS NOT THE ANSWER. On a window
           shorter than the ~60 minutes the aggregator takes to write a
           session, user.sessions holds a handful of rows for it — not zero,
           which the guard below would catch, but a small true number that
           would read as the application's traffic. The event scan is the
           base there, and the card is told which base it got. */
        if (fe && !withinSessionLag(tf!)) {
          out = await ask(qImpactedSessions(tf!, fe));
          if (out) out.base = "sessions";
          /* NOTHING SERIALIZED IS NOT NOTHING HAPPENED. The session store
             trails live traffic by the aggregation service's 30-minute
             inactivity timeout, so a short or very recent window can hold
             real activity and no session records at all. Reading that as
             "0 sessions" would blank the verdict, the ring and the error
             share over an application that is plainly busy, so the event
             scan answers instead — fewer promises about the hand-off, but a
             page that still describes what is happening. */
          if (!out || out.sessions === 0) {
            out = await ask(qImpacted(tf!, rumAppId!));
            if (out) out.base = "events";
          }
        } else {
          out = await ask(qImpacted(tf!, rumAppId!));
          if (out) out.base = "events";
        }
      } catch {
        // no scope or the query failed — the row and the steps are not offered
        try { out = await ask(qImpacted(tf!, rumAppId!)); } catch { out = null; }
      }
      memo.set(key, out);
      if (live) setImp(out);
    })();

    return () => { live = false; };
  }, [key, active, rumAppId, tf, fe]);

  return imp;
}
