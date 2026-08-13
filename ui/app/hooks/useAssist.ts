// Is Dynatrace Assist usable by the person looking at this screen?
//
// The platform guide is explicit that it may not be: Gen AI can be disabled on
// the account, an admin may not have allowed it on the tenant, or the user may
// lack the permission. Offering a conversation starter that cannot run is worse
// than not offering one, so the routes ask this first.
import { useEffect, useState } from "react";
import { publicClient } from "@dynatrace-sdk/client-davis-copilot";

export function useAssist(): boolean {
  const [ok, setOk] = useState(false);

  useEffect(() => {
    let cancelled = false;
    publicClient
      .listAvailableSkills()
      .then((r) => {
        if (!cancelled) setOk(r.skills?.includes("conversation") ?? false);
      })
      // degrade silently: no Assist, no starter, the rest of the panel is unaffected
      .catch(() => { if (!cancelled) setOk(false); });
    return () => { cancelled = true; };
  }, []);

  return ok;
}
