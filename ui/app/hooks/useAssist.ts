// Is Dynatrace Assist usable by the person looking at this screen — and how?
//
// The platform guide is explicit that it may not be: Gen AI can be disabled on
// the account, an admin may not have allowed it on the tenant, or the user may
// lack the permission. Offering a conversation starter that cannot run is worse
// than not offering one, so the routes ask this first.
//
// AGENTIC MODE changes what we should SEND, not whether we can ask. When the
// `operator` skill is present the agent can run its own DQL and fetch platform
// data, so repeating what it could query itself is wasted payload that may
// conflict with fresher numbers it retrieves. What it cannot reach is this
// app's own state — the reader's selection, the window on screen, the mined
// journeys — and that is exactly what this app has to give.
import { useEffect, useState } from "react";
import { publicClient } from "@dynatrace-sdk/client-davis-copilot";

export interface AssistState {
  /** The conversation skill is available to this user. */
  available: boolean;
  /** The operator skill too, so the agent can fetch for itself. */
  agentic: boolean;
}

export function useAssistState(): AssistState {
  const [state, setState] = useState<AssistState>({ available: false, agentic: false });

  useEffect(() => {
    let cancelled = false;
    publicClient
      .listAvailableSkills()
      .then((r) => {
        /* The installed SDK's union predates agentic mode and does not list
         * `operator`, but a tenant that has it returns it all the same. Read
         * the wire value as strings rather than pretend the skill cannot
         * arrive — the types are a snapshot, the tenant is the truth. */
        const skills: string[] = (r.skills ?? []) as unknown as string[];
        if (!cancelled) {
          setState({
            available: skills.includes("conversation") || skills.includes("operator"),
            agentic: skills.includes("operator"),
          });
        }
      })
      // degrade silently: no Assist, no starter, the rest of the panel is unaffected
      .catch(() => { if (!cancelled) setState({ available: false, agentic: false }); });
    return () => { cancelled = true; };
  }, []);

  return state;
}

/** The older yes/no question, kept for the single-button callers. */
export function useAssist(): boolean {
  return useAssistState().available;
}
