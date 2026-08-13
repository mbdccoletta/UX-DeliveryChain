// The provider behind this application's machines.
//
// The chain used to end at the host. Smartscape keeps going: a host runs on an
// EC2 instance or a GCE instance, and that instance sits in an availability
// zone. Validated against Gen3 before this existed — HOST-34B959AE58123C71
// (15 services) → AWS_EC2_INSTANCE-B1CFB55F52DF66F6 → use1-az1.
//
// CONDITIONAL BY DESIGN. Measured on this tenant, 7 of 49 hosts have a cloud
// parent; the other 42 have none. Rather than draw an empty column for them,
// the layer is absent, and the chain honestly ends at Infrastructure. An empty
// column would be one more component connected to nothing, which is the defect
// this whole pass set out to remove.
import { useEffect, useState } from "react";
import { qCloudPlacement, runDql } from "../utils/dql";

export interface CloudPlacement {
  /** The HOST this describes — how the edge finds its source card. */
  host: string;
  instanceId: string;
  instanceType: string;
  /** The provider's own name. Not unique: three instances here are all called
   *  "live", so a card that shows only this shows three identical boxes. */
  instanceName: string;
  zoneId?: string;
  zoneType?: string;
  zoneName?: string;
}

const memo = new Map<string, CloudPlacement[]>();

/** Cloud placements for these hosts, or null while loading / none scoped. */
export function useCloudScope(hostIds: string[], active = true): CloudPlacement[] | null {
  const ids = [...hostIds].sort();
  const key = active && ids.length ? ids.join(",") : "";
  const [out, setOut] = useState<CloudPlacement[] | null>(
    key ? memo.get(key) ?? null : null);

  useEffect(() => {
    if (!key) { setOut(null); return; }
    const hit = memo.get(key);
    if (hit) { setOut(hit); return; }

    setOut(null);
    let live = true;
    (async () => {
      try {
        const rows = await runDql<Record<string, unknown>>(qCloudPlacement(ids), 60);
        const list: CloudPlacement[] = rows.map((r) => ({
          host: String(r.host ?? ""),
          instanceId: String(r.instanceId ?? ""),
          instanceType: String(r.instanceType ?? ""),
          instanceName: String(r.instanceName ?? r.instanceId ?? ""),
          zoneId: r.zoneId ? String(r.zoneId) : undefined,
          zoneType: r.zoneType ? String(r.zoneType) : undefined,
          zoneName: r.zoneName ? String(r.zoneName) : undefined,
        })).filter((p) => p.instanceId);
        memo.set(key, list);
        if (live) setOut(list);
      } catch {
        // Smartscape unavailable — the chain simply ends at the host, which is
        // what it did before this layer existed
        if (live) setOut([]);
      }
    })();

    return () => { live = false; };
  }, [key, ids.join(",")]);

  return out;
}
