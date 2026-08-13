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
import { qImpacted, runDql, type Timeframe } from "../utils/dql";

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
}

const memo = new Map<string, Impacted | null>();

/** Impact for an application, or null while loading / when unavailable. */
export function useImpacted(
  rumAppId?: string, tf?: Timeframe, active = false,
): Impacted | null {
  const key = rumAppId && tf ? `${rumAppId}|${tf.from}|${tf.to}` : "";
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
      try {
        const rows = await runDql<Record<string, unknown>>(qImpacted(tf!, rumAppId!), 1);
        const r = rows[0];
        if (r) {
          out = {
            sessions: Number(r.sessions) || 0, hit: Number(r.hit) || 0,
            realSessions: Number(r.realSessions) || 0,
            hitReal: Number(r.hitReal) || 0, hitRobot: Number(r.hitRobot) || 0,
            hitSynth: Number(r.hitSynth) || 0,
          };
          // an exemplar only counts when it actually erred — a healthy session
          // proves nothing about the impact
          if (r.exSid && r.exStart && Number(r.exErrs) > 0) {
            out.ex = {
              sid: String(r.exSid), start: String(r.exStart),
              inst: r.exInst ? String(r.exInst) : undefined,
              errs: Number(r.exErrs) || 0,
            };
          }
        }
      } catch {
        // no scope or the query failed — the row and the steps are not offered
      }
      memo.set(key, out);
      if (live) setImp(out);
    })();

    return () => { live = false; };
  }, [key, active, rumAppId, tf]);

  return imp;
}
