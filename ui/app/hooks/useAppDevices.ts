// The devices a mobile application declares it runs on.
//
// The Consume layer counts sessions, which is the right thing to count and the
// wrong thing to have nothing of: an application with no RUM in Grail drew
// "No coverage", and that reads as "nobody uses this" when what happened is
// that nobody measured it here. Measured on guu84124, the inventory does say
// something — MOBILE_APPLICATION-773D0C09E8E14B58 declares IOS and ANDROID.
//
// A declaration is not a measurement, and the card that carries it must not
// pretend otherwise: it names the device family and shows no session count,
// because there is none. That is more than silence and less than a number,
// which is exactly what is true.
//
// Asked only where the sessions are missing — where they exist, they are the
// better answer and this never runs.
import { useEffect, useState } from "react";
import { qAppOsFamilies, runDql } from "../utils/dql";

const memo = new Map<string, string[]>();

/** Declared device families, or null while loading / nothing to ask about. */
export function useAppDevices(entityId?: string, active = true): string[] | null {
  const key = active && entityId && entityId.startsWith("MOBILE_APPLICATION-")
    ? entityId : "";
  const [out, setOut] = useState<string[] | null>(key ? memo.get(key) ?? null : null);

  useEffect(() => {
    if (!key) { setOut(null); return; }
    const hit = memo.get(key);
    if (hit) { setOut(hit); return; }

    setOut(null);
    let live = true;
    (async () => {
      try {
        const rows = await runDql<Record<string, unknown>>(qAppOsFamilies(key), 1);
        const raw = rows[0]?.os;
        const list = (Array.isArray(raw) ? raw : raw ? [raw] : [])
          .map((v) => String(v)).filter(Boolean);
        memo.set(key, list);
        if (live) setOut(list);
      } catch {
        // nothing declared either — the layer says "No coverage", as before
        if (live) setOut([]);
      }
    })();

    return () => { live = false; };
  }, [key]);

  return out;
}
