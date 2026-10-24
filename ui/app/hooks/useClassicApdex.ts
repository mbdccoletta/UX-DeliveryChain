// See utils/classicApdex — the classic rating, as the application list shows it.
import { useEffect, useState } from "react";
import { classicApdex, classicGeoApdex, type ClassicApdex, type ClassicGeo } from "../utils/classicApdex";
import type { Timeframe } from "../utils/dql";

/** undefined while asked or not needed yet; null when classic has none. */
export function useClassicApdex(entity: string | undefined, tf: Timeframe,
  active: boolean): ClassicApdex | null | undefined {
  const [v, setV] = useState<ClassicApdex | null | undefined>(undefined);
  useEffect(() => {
    if (!active || !entity) { setV(active ? null : undefined); return; }
    let live = true;
    setV(undefined);
    classicApdex(entity, tf).then((r) => { if (live) setV(r); });
    return () => { live = false; };
  }, [entity, tf.from, tf.to, active]);
  return v;
}

/** The classic rating per place, while the application itself is rated by it. */
export function useClassicGeo(entity: string | undefined, tf: Timeframe,
  active: boolean): ClassicGeo | null | undefined {
  const [v, setV] = useState<ClassicGeo | null | undefined>(undefined);
  useEffect(() => {
    if (!active || !entity) { setV(active ? null : undefined); return; }
    let live = true;
    setV(undefined);
    classicGeoApdex(entity, tf).then((r) => { if (live) setV(r); });
    return () => { live = false; };
  }, [entity, tf.from, tf.to, active]);
  return v;
}
