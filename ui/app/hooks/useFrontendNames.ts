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
import { frontendNodes } from "../utils/frontendMetrics";

let memo: Map<string, string> | null = null;
let inflight: Promise<Map<string, string>> | null = null;

/* FROM THE METRIC STORE FIRST (0.17.4). The pairing is also in every
   dt.frontend.* series — dt.smartscape.frontend beside frontend.name — and
   Smartscape maps the node to the entity, so the whole map costs ≈0 GiB
   where the session-store scan read ≈14 GiB on a bank's estate. The scan
   stays as the fallback for an environment that publishes no metric. */
async function fromMetrics(minutes: number): Promise<Map<string, string>> {
  const [nodes, rows] = await Promise.all([frontendNodes(), runDql<Record<string, unknown>>(`
timeseries v = countDistinct(dt.frontend.session.active.estimated_count, scalar: true),
  from: now()-${Math.max(180, Math.round(minutes))}m, to: now(),
  by: { dt.smartscape.frontend, frontend.name }`, 5000)]);
  const ent = new Map(nodes.map((x) => [x.id, x.entity]));
  const m = new Map<string, string>();
  for (const r of [...rows].sort((x, y) => Number(y.v) - Number(x.v))) {
    const e = ent.get(String(r["dt.smartscape.frontend"] ?? ""));
    const fe = r["frontend.name"];
    if (e && fe && !m.has(e)) m.set(e, String(fe));
  }
  return m;
}

function load(minutes: number): Promise<Map<string, string>> {
  if (!inflight) {
    inflight = fromMetrics(minutes).catch(() => new Map<string, string>())
      .then((m) => (m.size ? m.entries() : null))
      .then((e) => (e ? [...e].map(([ent, fe]) => ({ ent, fe, n: "1" }))
        : runDql<{ ent: string; fe: string; n: string }>(qFrontendNames(minutes), 1000)))
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
export function useFrontendNames(minutes = 180,
  /** False while another source (the metric store) may answer — the scan is
   *  a three-hour read of the session store, ≈14 GiB on a bank's estate. */
  enabled = true,
): Map<string, string> | null {
  const [map, setMap] = useState<Map<string, string> | null>(memo);
  useEffect(() => {
    if (memo || !enabled) return;
    let live = true;
    load(minutes).then((m) => { if (live) setMap(m); });
    return () => { live = false; };
  }, [minutes, enabled]);
  return map;
}
