// What Users & Sessions calls each application.
//
// Every deep link into the sessions app opens with a `Frontends` chip, and
// that chip filters on `frontend.name` from user.sessions — a vocabulary the
// entity inventory does not share. Send the inventory name and the platform
// accepts the chip, matches no session, and shows an empty list that reads as
// "this region has no sessions" when it means "no frontend is called that".
//
// One scan per browser session for the whole map (the pairing is a property
// of the app, not the window), shared module-wide. When more than one
// frontend rode the same entity the busiest pairing wins — the rows arrive
// sorted by count, so first write per entity is the dominant one.
import { useEffect, useState } from "react";
import { qFrontendNames, runDql } from "../utils/dql";

let memo: Map<string, string> | null = null;
let inflight: Promise<Map<string, string>> | null = null;

function load(): Promise<Map<string, string>> {
  if (!inflight) {
    inflight = runDql<{ ent: string; fe: string; n: string }>(qFrontendNames(), 100)
      .then((rows) => {
        const m = new Map<string, string>();
        for (const r of rows) {
          if (r.ent && r.fe && !m.has(String(r.ent))) m.set(String(r.ent), String(r.fe));
        }
        memo = m;
        return m;
      })
      .catch(() => {
        // no map: sessions links stay HIDDEN (callers gate on a resolved
        // name — the inventory-name fallback was retired by the audit);
        // the next mount retries the scan
        inflight = null;
        return new Map<string, string>();
      });
  }
  return inflight;
}

/** entity id → frontend.name, or null while it loads. */
export function useFrontendNames(): Map<string, string> | null {
  const [map, setMap] = useState<Map<string, string> | null>(memo);
  useEffect(() => {
    if (memo) return;
    let live = true;
    load().then((m) => { if (live) setMap(m); });
    return () => { live = false; };
  }, []);
  return map;
}
