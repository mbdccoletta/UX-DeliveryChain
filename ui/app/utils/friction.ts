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

/** Above this the move is slow enough that users notice waiting. */
const SLOW_P90_NS = 3e9;
/** Share of interactions with poor responsiveness before it counts. */
const SLOW_INP_SHARE = 0.2;

/** Reads the health of one move between two views. */
export function edgeHealth(t: TransitionRow): EdgeHealth {
  const lost = t.abandoned + t.timeouts;
  if (lost > 0) {
    const what = t.abandoned >= t.timeouts ? "closed the tab mid-action" : "the action timed out";
    return {
      health: "losing",
      note: `${fmtN(lost)} of ${fmtN(t.sessions)} ${what}`,
    };
  }
  const inpShare = t.actions ? t.slowInp / t.actions : 0;
  if (inpShare >= SLOW_INP_SHARE) {
    return {
      health: "slow",
      note: `${Math.round(inpShare * 100)}% of interactions respond poorly`,
    };
  }
  if (t.p90 > SLOW_P90_NS) {
    return { health: "slow", note: `p90 ${fmtMs(t.p90)} to complete` };
  }
  return { health: "ok", note: `p50 ${fmtMs(t.p50)}` };
}
export function frictionFor(
  friction: FrictionRow[], view: string, appId?: string | null,
): FrictionRow[] {
  return friction
    .filter((f) => f.view === view && (!appId || f.appId === appId))
    .sort((a, b) => b.abandoned + b.timeouts - (a.abandoned + a.timeouts));
}
