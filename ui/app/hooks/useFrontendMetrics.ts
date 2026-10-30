// The Overview's first paint from the metric store — see utils/frontendMetrics.
import { useEffect, useState } from "react";
import { useMemoGen } from "../utils/memo";
import { frontendMetrics, type FrontendMetrics } from "../utils/frontendMetrics";
import type { Timeframe } from "../utils/dql";

/** undefined while loading; null when the metric store cannot answer for this
 *  application (no FRONTEND node, no published sessions) — the caller then
 *  keeps the event path; otherwise the numbers. */
export function useFrontendMetrics(
  tf: Timeframe, rumAppId?: string | null,
): FrontendMetrics | null | undefined {
  const gen = useMemoGen();
  const [fm, setFm] = useState<FrontendMetrics | null | undefined>(undefined);
  useEffect(() => {
    if (!rumAppId) { setFm(null); return; }
    let live = true;
    setFm(undefined);
    frontendMetrics(tf, rumAppId, gen).then((r) => { if (live) setFm(r); });
    return () => { live = false; };
  }, [tf.from, tf.to, rumAppId, gen]);
  return fm;
}
