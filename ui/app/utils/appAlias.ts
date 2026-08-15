// Stable application aliases for Business Control's anonymised mode.
//
// The board can leave the building: the busiest application is always
// "Application A", the next "Application B", so a shared screenshot names the
// numbers without naming anyone. The identities are hidden, never the figures.
import type { ChainData } from "../hooks/useChainData";

/** Stable aliases: the busiest application is always "Application A". */
export function aliasMap(d: ChainData): Map<string, string> {
  const m = new Map<string, string>();
  [...d.apps]
    .sort((a, b) => b.sessions - a.sessions)
    .forEach((a, i) => m.set(a.name, `Application ${String.fromCharCode(65 + i)}`));
  return m;
}
