// The customer's OWN conversion definitions — taught by clicking.
//
// The reader's intelligence rule: a customer who has defined no conversion
// anywhere teaches this app on the Journeys page — pick the views that mean
// "converted" and press "define conversion". The definition is stored per
// application (platform user-app-state, the same store the cache uses) and
// REPLACES the keyword heuristic for that application in every query and
// screen at once; clearing it returns the app to the measured fallback.
//
// Stored per USER because that is the scope this app's manifest already
// holds; promoting definitions to team-wide app-state is one added scope.
import { useCallback, useEffect, useState } from "react";
import { stateClient } from "@dynatrace-sdk/client-state";
import type { OutcomeDefs } from "../utils/dql";

const KEY = "outcome-defs";

let cached: OutcomeDefs | null = null;

export function useOutcomeDefs(): {
  defs: OutcomeDefs; ready: boolean;
  save: (appId: string, views: string[]) => Promise<void>;
  clear: (appId: string) => Promise<void>;
} {
  const [defs, setDefs] = useState<OutcomeDefs>(cached ?? {});
  const [ready, setReady] = useState(cached !== null);

  useEffect(() => {
    if (cached !== null) return;
    let live = true;
    (async () => {
      try {
        const s = await stateClient.getUserAppState({ key: KEY });
        const parsed = s?.value ? JSON.parse(s.value) as OutcomeDefs : {};
        cached = parsed;
        if (live) { setDefs(parsed); setReady(true); }
      } catch {
        // no state yet — an empty map is the honest default
        cached = {};
        if (live) { setDefs({}); setReady(true); }
      }
    })();
    return () => { live = false; };
  }, []);

  const persist = useCallback(async (next: OutcomeDefs) => {
    cached = next;
    setDefs(next);
    try {
      await stateClient.setUserAppState({
        key: KEY, body: { value: JSON.stringify(next) } });
    } catch { /* state write refused — the definition still applies this session */ }
  }, []);

  const save = useCallback((appId: string, views: string[]) =>
    persist({ ...(cached ?? {}), [appId]: [...new Set(views)] }), [persist]);
  const clear = useCallback((appId: string) => {
    const next = { ...(cached ?? {}) };
    delete next[appId];
    return persist(next);
  }, [persist]);

  return { defs, ready, save, clear };
}
