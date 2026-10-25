// Sessions per application in the window, for the picker — every frontend at
// once, from the metric store (≈0 GiB): dt.frontend.session.active by
// dt.smartscape.frontend, mapped to the RUM id through Smartscape.
import { useEffect, useState } from "react";
import { runDql, type Timeframe } from "../utils/dql";
import { useMemoGen } from "../utils/memo";
import { frontendNodes, qFmScalar } from "../utils/frontendMetrics";

const memo = new Map<string, Map<string, number>>();

/** lower-cased RUM application id → sessions; null while asked. */
export function useAppActivity(tf: Timeframe): Map<string, number> | null {
  /* Refresh reaches it: a relative window's text never changes, so without
     the generation the counts stayed as first read for the life of the tab */
  const gen = useMemoGen();
  const key = `${tf.from}|${tf.to}|${gen}`;
  const [out, setOut] = useState<Map<string, number> | null>(memo.get(key) ?? null);
  useEffect(() => {
    const hit = memo.get(key);
    if (hit) { setOut(hit); return; }
    setOut(null);
    let live = true;
    Promise.all([frontendNodes(), runDql<Record<string, unknown>>(qFmScalar(tf,
      "countDistinct(dt.frontend.session.active.estimated_count, scalar: true)",
      undefined, "dt.smartscape.frontend"), 5000)])
      .then(([nodes, rows]) => {
        /* NO NODES IS A FAILED READ, NOT AN ESTATE WITH NO TRAFFIC: an empty
           map would file every application under "No sessions". Null keeps
           the picker ungrouped instead, and nothing is memoised. */
        if (!nodes.length) { if (live) setOut(null); return; }
        const rum = new Map(nodes.map((n) => [n.id, n.rumId]));
        const m = new Map<string, number>();
        for (const r of rows) {
          const id = rum.get(String(r["dt.smartscape.frontend"] ?? ""));
          if (id) m.set(id, (m.get(id) ?? 0) + (Number(r.v) || 0));
        }
        memo.set(key, m);
        if (live) setOut(m);
      })
      .catch(() => { if (live) setOut(null); });
    return () => { live = false; };
  }, [key]);
  return out;
}
