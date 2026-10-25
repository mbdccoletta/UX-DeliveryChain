// Turns measured user actions into the health of one move between two views,
// and the friction behind it.
//
// The ranked "Fix first" list this file also built is gone: the reader called
// it out as useless, and it was — its rows fragmented one finding across every
// product id ("/product/*puk6v6ev0 · 66% of interactions respond poorly", five
// times over), which is noise, not a priority. What it tried to say is said
// better by the per-view technical table and the drop-off diagram.
//
// Every figure comes from a user action the browser reported. Nothing here is
// modelled or estimated — where a cause cannot be named, the finding says so
// rather than guessing one.
import { fmtMs, fmtN } from "./dql";
import type { AppRow, FrictionRow, TransitionRow } from "../hooks/useChainData";

export type Health = "ok" | "slow" | "losing";

export interface EdgeHealth {
  health: Health;
  /** What the user experienced on this move, in one line. */
  note: string;
}


/** Reads the health of one move between two views. */
export function edgeHealth(t: TransitionRow): EdgeHealth {
  const lost = t.abandoned + t.timeouts;
  if (lost > 0) {
    /* BOTH REASONS, OR NEITHER NAMED. This used to pick whichever count was
       larger and attribute the WHOLE total to it, so three tab closures and
       two timeouts were reported as "5 closed the tab mid-action" — two of
       which did no such thing. Each cause now carries its own measured
       number, and when only one of them happened only that one is named. */
    const parts: string[] = [];
    if (t.abandoned > 0) parts.push(`${fmtN(t.abandoned)} closed the tab mid-action`);
    if (t.timeouts > 0) parts.push(`${fmtN(t.timeouts)} timed out`);
    return {
      health: "losing",
      // "8 of 3" was possible: these count ACTIONS, sessions counts SESSIONS
      note: `${parts.join(" · ")} · ${fmtN(t.sessions)} sessions on this move`,
    };
  }
  /* PRINTED, NOT JUDGED (0.17.43). "Slow" was this app's own lines — a 3 s
     p90 and 20% poorly-responding interactions — colouring moves the platform
     never rated. The measurements stay in the note; only what the platform
     itself recorded (abandoned and timed-out actions, above) colours a move. */
  const inpShare = t.actions ? t.slowInp / t.actions : 0;
  return { health: "ok", note: `p50 ${fmtMs(t.p50)} · p90 ${fmtMs(t.p90)}`
    + (inpShare > 0 ? ` · ${Math.round(inpShare * 100)}% of interactions respond poorly` : "") };
}
export function frictionFor(
  friction: FrictionRow[], view: string, appId?: string | null,
): FrictionRow[] {
  return friction
    .filter((f) => f.view === view && (!appId || f.appId === appId))
    .sort((a, b) => b.abandoned + b.timeouts - (a.abandoned + a.timeouts));
}
