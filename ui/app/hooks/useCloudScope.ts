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
import { qCloudPlacement, qLambdaPlacement, runDql } from "../utils/dql";

export interface CloudPlacement {
  /** The placement this describes — a HOST id, or for serverless the
   *  AWS_LAMBDA_FUNCTION id — how the edge finds its source card. */
  host: string;
  /** Serverless placements carry a REGION, not an availability zone, and the
   *  card must say which it is saying. */
  kind?: "instance" | "lambda";
  region?: string;
  account?: string;
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

/** Cloud placements for these hosts and lambdas, or null while loading. */
export function useCloudScope(
  hostIds: string[],
  /** AWS_LAMBDA_FUNCTION placement ids — a lambda-backed service produces no
   *  HOST, and the Provider column born only from hosts never existed for
   *  it. The function node itself carries provider, region and account
   *  (measured on guu84124), so serverless earns the column too. */
  lambdaIds: string[] = [],
  active = true,
): CloudPlacement[] | null {
  const ids = [...hostIds].sort();
  const fns = [...lambdaIds].sort();
  const key = active && (ids.length || fns.length)
    ? `${ids.join(",")}|${fns.join(",")}` : "";
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
        const rows = ids.length
          ? await runDql<Record<string, unknown>>(qCloudPlacement(ids), 60) : [];
        const list: CloudPlacement[] = rows.map((r) => ({
          host: String(r.host ?? ""), kind: "instance" as const,
          instanceId: String(r.instanceId ?? ""),
          instanceType: String(r.instanceType ?? ""),
          instanceName: String(r.instanceName ?? r.instanceId ?? ""),
          zoneId: r.zoneId ? String(r.zoneId) : undefined,
          zoneType: r.zoneType ? String(r.zoneType) : undefined,
          zoneName: r.zoneName ? String(r.zoneName) : undefined,
        })).filter((p) => p.instanceId);
        if (fns.length) {
          try {
            const lam = await runDql<Record<string, unknown>>(qLambdaPlacement(fns), 40);
            for (const r of lam) {
              if (!r.fn) continue;
              list.push({
                host: String(r.fn), kind: "lambda",
                instanceId: String(r.fn),
                instanceType: "AWS_LAMBDA_FUNCTION",
                instanceName: String(r.name ?? r.fn),
                region: r.region ? String(r.region) : undefined,
                account: r.account ? String(r.account) : undefined,
              });
            }
          } catch { /* the functions stay in Run; the column simply lacks them */ }
        }
        memo.set(key, list);
        if (live) setOut(list);
      } catch {
        // Smartscape unavailable — the chain simply ends at the host, which is
        // what it did before this layer existed
        if (live) setOut([]);
      }
    })();

    return () => { live = false; };
  }, [key]);

  return out;
}
