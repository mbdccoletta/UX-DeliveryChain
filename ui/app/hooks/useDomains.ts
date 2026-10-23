// The domains this application contacts — fetched where they are read.
//
// qDomains was part of every page's first load: measured on a production
// application, 96 GB and 11 s, for the host lines of a card that starts
// closed and for the Delivery Chain's edge layer. It now runs only when the
// Delivery Chain is open or the requests card is opened, the same way the
// origin split moved to useOrigins. One memo per window and application, so
// the two readers share one scan.
import { useEffect, useState } from "react";
import { useMemoGen } from "../utils/memo";
import { qDomains, runDql, type Timeframe } from "../utils/dql";
import type { DomainRow } from "./useChainData";

const memo = new Map<string, DomainRow[]>();
const num = (v: unknown) => Number(v) || 0;

export function useDomains(tf: Timeframe, appId: string | null | undefined,
  active: boolean): DomainRow[] | null {
  const gen = useMemoGen();
  const key = appId ? `${tf.from}|${tf.to}|${appId}|${gen}` : "";
  const [out, setOut] = useState<DomainRow[] | null>(key ? memo.get(key) ?? null : null);

  useEffect(() => {
    if (!key) { setOut(null); return; }
    const hit = memo.get(key);
    if (hit) { setOut(hit); return; }
    setOut(null);
    if (!active) return;
    let live = true;
    (async () => {
      try {
        const rows = await runDql<Record<string, unknown>>(qDomains(tf, appId), 200);
        const res: DomainRow[] = rows.map((r) => ({
          appId: String(r.appId ?? ""),
          utype: (r.utype as string | null) ?? null,
          agent: (r.agent as string | null) ?? null,
          domain: String(r.domain ?? ""), provider: r.provider as string | null,
          reqs: num(r.reqs), p50: num(r.p50), p90: num(r.p90), err: num(r.err),
          bytes: num(r.bytes),
          late: r.late == null ? null : num(r.late),
        }));
        memo.set(key, res);
        if (live) setOut(res);
      } catch { if (live) setOut([]); }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, active]);

  return out;
}
