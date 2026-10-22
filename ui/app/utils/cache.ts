// Caches a whole screen's worth of query results between loads.
//
// The 16 queries behind one screen scan roughly 2 GB of Grail, and today every
// reload and every timeframe change pays that again. A short-lived cache keeps
// the numbers on screen while cutting the repeat cost — the trade is staleness,
// so the age is always shown and refreshing always bypasses this.
//
// USER app state, not app state: a query result is scoped to the permissions of
// whoever ran it. Storing it per-app would let someone without RUM scopes read
// RUM figures another user's session fetched. Per-user keeps that boundary.
import { stateClient } from "@dynatrace-sdk/client-state";

/** Bump when the cached shape changes, so old entries are ignored, not misread. */
// v2: device and domain rows gained appId — v1 entries would filter to nothing
const VERSION = "15"; // v15: failures rows know whether they are truly named

/**
 * How long a window's data stays usable. A 7-day window barely moves minute to
 * minute; a 30-minute one does. The platform's floor is now+1m.
 */
const TTL: Record<string, string> = {
  "30m": "now+1m", "2h": "now+2m", "24h": "now+5m", "7d": "now+10m",
};

/**
 * THE TTL FOLLOWS THE WINDOW'S LENGTH, and it was being asked the wrong
 * question. Callers pass a composite cache identity — `now()-24h|now()` — and
 * this map is indexed by duration labels, so every single write missed and
 * took the two-minute fallback. A 30-minute window was then cached longer
 * than intended and a 24-hour one expired in two minutes, paying for a fresh
 * scan of the most expensive window this app offers, over and over.
 *
 * Minutes are the honest input: they come from the Timeframe itself and
 * cannot drift from a label.
 */
function ttlFor(minutes?: number): string {
  if (!minutes || !Number.isFinite(minutes)) return "now+2m";
  if (minutes <= 30) return TTL["30m"];
  if (minutes <= 120) return TTL["2h"];
  if (minutes <= 1440) return TTL["24h"];
  return TTL["7d"];
}

export interface Cached<T> {
  value: T;
  /** When it was written, so the screen can show how old it is. */
  at: number;
}

const keyFor = (tf: string) => `chain-${VERSION}-${tf}`;

/** Reads a cached payload, or null when absent, expired or from an old shape. */
export async function read<T>(tf: string): Promise<Cached<T> | null> {
  try {
    const s = await stateClient.getUserAppState({ key: keyFor(tf) });
    const parsed = JSON.parse(s.value) as Cached<T> & { version?: string };
    if (parsed.version !== VERSION) return null;
    return { value: parsed.value, at: parsed.at };
  } catch {
    // absent, expired, or the scope is missing — either way, just query
    return null;
  }
}

/** Stores a payload. Failure is silent: a cache miss is never worth an error. */
export async function write<T>(tf: string, value: T, minutes?: number): Promise<void> {
  try {
    await stateClient.setUserAppState({
      key: keyFor(tf),
      body: {
        value: JSON.stringify({ version: VERSION, at: Date.now(), value }),
        validUntilTime: ttlFor(minutes),
      },
    });
  } catch {
    /* over the size limit, or no scope — the app works without the cache */
  }
}
