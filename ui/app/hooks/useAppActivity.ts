// Sessions per application in the window, for the picker — every frontend at
// once, from the metric store (≈0 GiB): dt.frontend.session.active by
// dt.smartscape.frontend, mapped to the RUM id through Smartscape.
import { useEffect, useState } from "react";
import { runDql, type Timeframe } from "../utils/dql";
import { frontendNodes, qFmScalar } from "../utils/frontendMetrics";

const memo = new Map<string, Map<string, number>>();

/** lower-cased RUM application id → sessions; null while asked. */
export function useAppActivity(tf: Timeframe): Map<string, number> | null {
  const key = `${tf.from}|${tf.to}`;
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
        const rum = new Map(nodes.map((n) => [n.id, n.rumId]));
        const m = new Map<string, number>();
        for (const r of rows) {
          const id = rum.get(String(r["dt.smartscape.frontend"] ?? ""));
          if (id) m.set(id, (m.get(id) ?? 0) + (Number(r.v) || 0));
        }
        memo.set(key, m);
        if (live) setOut(m);
      })
      .catch(() => { if (live) setOut(new Map()); });
    return () => { live = false; };
  }, [key]);
  return out;
}
