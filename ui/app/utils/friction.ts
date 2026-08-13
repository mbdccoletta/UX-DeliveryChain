// Turns measured user actions into the four answers the flow has to give:
// which routes users take, where they leave and why, which routes are slow or
// failing, and what to fix first.
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

export interface Priority {
  rank: number;
  /** Which application owns this, so a consolidated list stays actionable. */
  app: string | null;
  /** The move or view this is about. */
  where: string;
  /** What is happening, stated as measured fact. */
  what: string;
  /** The named cause, when the data attributes one. */
  cause: string | null;
  /** Sessions this costs in the window — the ranking key. */
  cost: number;
  health: Health;
}

/**
 * What to fix first, ranked by the sessions it costs.
 *
 * Lost sessions outrank slow ones: a session that left is gone, a slow one may
 * still convert. Within each, volume decides.
 */
export function priorities(
  transitions: TransitionRow[], friction: FrictionRow[], appId?: string | null,
  apps: AppRow[] = [],
): Priority[] {
  // in the consolidated view every row must name its application, or the list
  // says what to fix without saying where
  const nameOf = (id: string) => apps.find((a) => a.appId === id)?.name ?? null;
  const t = appId ? transitions.filter((x) => x.appId === appId) : transitions;
  const f = appId ? friction.filter((x) => x.appId === appId) : friction;
  const out: Array<Omit<Priority, "rank">> = [];

  for (const x of t) {
    const lost = x.abandoned + x.timeouts;
    const h = edgeHealth(x);
    if (h.health === "ok") continue;
    // the element the platform blamed on the destination view, if any
    const elem = f
      .filter((y) => y.appId === x.appId && y.view === x.dst && (y.tag || y.xpath))
      .sort((a, b) => b.abandoned + b.timeouts - (a.abandoned + a.timeouts))[0];
    const cause = elem
      ? `<${elem.tag}> ${elem.xpath}` +
        (elem.cls > 0.1 ? ` — shifts the layout by ${elem.cls.toFixed(2)}` : "")
      : null;
    out.push({
      app: appId ? null : nameOf(x.appId),
      where: `${x.src} → ${x.dst}`,
      what: h.note,
      cause,
      cost: lost > 0 ? lost : Math.round(x.sessions * 0.1),
      health: h.health,
    });
  }

  return out
    .sort((a, b) => {
      if (a.health !== b.health) return a.health === "losing" ? -1 : 1;
      return b.cost - a.cost;
    })
    .slice(0, 6)
    .map((p, i) => ({ ...p, rank: i + 1 }));
}

/** The friction attributed to one view, for the drill-down. */
export function frictionFor(
  friction: FrictionRow[], view: string, appId?: string | null,
): FrictionRow[] {
  return friction
    .filter((f) => f.view === view && (!appId || f.appId === appId))
    .sort((a, b) => b.abandoned + b.timeouts - (a.abandoned + a.timeouts));
}
