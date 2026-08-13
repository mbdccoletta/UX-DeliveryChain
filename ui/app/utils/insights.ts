// Insight engine.
//
// Every rule below is computed from measured data and only fires when its
// condition actually holds — no filler, no restating the table above it.
// Each insight carries the evidence that produced it, so a reader can check
// the claim instead of trusting it.
import { INTENT, fmtK, fmtMs, fmtN, reachesOutcome } from "./dql";
import type { ChainData } from "../hooks/useChainData";

export type Severity = "critical" | "warning" | "notable" | "good";

export interface Insight {
  severity: Severity;
  /** The finding, stated as a claim. */
  title: string;
  /** Why it matters, in business or engineering consequence. */
  body: string;
  /** Numbers that produced the claim. */
  evidence: string;
  /** What to do next, when there is a clear move. */
  action?: string;
}

const RANK: Record<Severity, number> = { critical: 0, warning: 1, notable: 2, good: 3 };
const pct = (a: number, b: number) => (b ? (a / b) * 100 : 0);
const fmtPct = (v: number) => `${v.toFixed(v < 10 ? 1 : 0)}%`;

/** Median, used to compare an application against its peers. */
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function insightsFor(
  tier: number,
  elementName: string,
  entityIds: string[],
  d: ChainData,
  appId: string,
): Insight[] {
  const out: Insight[] = [];
  const app = d.apps.find((a) => a.appId === appId);
  const push = (i: Insight) => out.push(i);

  /* ─────── layer 01 · user & device ─────── */
  if (tier === 0) {
    const total = d.devices.reduce((a, r) => a + r.sessions, 0);
    const synthetic = d.devices
      .filter((r) => r.utype === "synthetic" || r.utype === "robot")
      .reduce((a, r) => a + r.sessions, 0);
    const mobile = d.devices
      .filter((r) => Number(r.res.split("×")[0]) < 800)
      .reduce((a, r) => a + r.sessions, 0);
    const top = [...d.devices].sort((a, b) => b.sessions - a.sessions)[0];

    if (total && synthetic / total > 0.95) {
      push({
        severity: "critical",
        title: "No real user traffic is being measured here",
        body: "Every session in this window comes from a synthetic monitor or a robot. Conversion, bounce and engagement computed from this data describe the test harness, not customers — treat them as a health check of the instrumentation, not of the business.",
        evidence: `${fmtN(synthetic)} of ${fmtN(total)} sessions are synthetic or robot (${fmtPct(pct(synthetic, total))}).`,
        action: "Confirm the RUM agent is injected on the production domain before using these numbers in a business review.",
      });
    }
    if (total && mobile > 0 && mobile / total < 0.05) {
      push({
        severity: "notable",
        title: "Mobile is a rounding error in this sample",
        body: "The mobile viewport barely appears, so mobile-specific regressions would be statistically invisible here. Any mobile experience claim needs a separate, larger sample.",
        evidence: `${fmtN(mobile)} of ${fmtN(total)} sessions (${fmtPct(pct(mobile, total))}) use a viewport narrower than 800px.`,
      });
    }
    if (top && total && top.sessions / total > 0.5) {
      push({
        severity: "notable",
        title: "One device profile dominates the sample",
        body: "A single resolution and orientation accounts for most sessions, which means device-dependent problems (layout shifts, touch targets, DPR-sensitive assets) have almost no chance of surfacing.",
        evidence: `${top.res} · ${top.orient ?? "—"} covers ${fmtN(top.sessions)} sessions (${fmtPct(pct(top.sessions, total))}).`,
      });
    }
  }

  /* ─────── layer 02 · network & third parties ─────── */
  if (tier === 1) {
    const first = d.domains.find((x) => x.provider === "first_party");
    const me = d.domains.find((x) => x.domain === elementName);
    const totalReq = d.domains.reduce((a, x) => a + x.reqs, 0);
    const totalErr = d.domains.reduce((a, x) => a + x.err, 0);

    if (me && first && me.p50 > first.p50 * 1.4) {
      push({
        severity: "warning",
        title: "This third party is slower than your own backend",
        body: "A dependency you do not control sits on the critical path and answers slower than first-party traffic. It caps how fast the page can ever become, no matter what you optimise internally.",
        evidence: `${me.domain} p50 ${fmtMs(me.p50)} versus ${first.domain} p50 ${fmtMs(first.p50)} — ${(me.p50 / first.p50).toFixed(1)}× slower across ${fmtN(me.reqs)} requests.`,
        action: "Self-host the asset or add preconnect/preload so the handshake does not block first paint.",
      });
    }
    if (totalErr === 0 && totalReq > 1000) {
      push({
        severity: "good",
        title: "The network layer is not the bottleneck",
        body: "Not a single request failed in this window. Whatever hurts the experience downstream, it is not connectivity or availability at the transport layer — rule it out and look further along the chain.",
        evidence: `0 responses with status ≥ 400 across ${fmtK(totalReq)} requests over ${d.domains.length} domains.`,
      });
    }
    if (me && me.bytes > 20 * 1024 * 1024) {
      push({
        severity: "notable",
        title: "This domain moves a significant share of the payload",
        body: "Transfer volume of this size is worth checking against cache headers: repeated downloads of the same assets inflate both latency and egress cost.",
        evidence: `${fmtK(Math.round(me.bytes / 1024))} KB transferred over ${fmtN(me.reqs)} requests.`,
      });
    }
  }

  /* ─────── layer 03 · application ─────── */
  if (tier === 2 && app) {
    const peers = d.apps.filter((a) => a.views > 0);
    const ratios = peers.map((a) => a.errors / Math.max(1, a.views));
    const med = median(ratios);
    const mine = app.errors / Math.max(1, app.views);
    const envErrors = d.apps.reduce((a, x) => a + x.errors, 0);

    if (med > 0 && mine > med * 2) {
      push({
        severity: "critical",
        title: "Error density here is far above the rest of the environment",
        body: "Users of this application hit errors at a rate its peers do not. Because the peer applications run on the same platform, the cause is far more likely to be in this application's own path than in shared infrastructure.",
        evidence: `${mine.toFixed(1)} errors per view versus a peer median of ${med.toFixed(1)} — ${(mine / med).toFixed(1)}× higher, across ${fmtN(peers.length)} applications.`,
        action: "Compare this application's service chain against the healthiest peer: they share the edge, so the divergence starts below it.",
      });
    }
    if (envErrors > 0 && app.errors / envErrors > 0.5) {
      push({
        severity: "warning",
        title: "One application produces most of the environment's errors",
        body: "Error totals for the whole environment are effectively this application's totals. Any environment-wide error trend you watch is really tracking this one app.",
        evidence: `${fmtK(app.errors)} of ${fmtK(envErrors)} errors (${fmtPct(pct(app.errors, envErrors))}) come from ${app.name}.`,
      });
    }

    const views = d.views.filter((v) => v.appId === appId);
    const worst = [...views].sort((a, b) => b.p50 - a.p50)[0];
    if (worst && worst.p50 > 10e9) {
      push({
        severity: "critical",
        title: "The slowest view shows a timeout signature, not gradual slowness",
        body: "A p50 this high on a user-facing view is not congestion — it is a call that waits on something until it gives up. Optimising rendering or assets will not move it; the blocking dependency has to be found.",
        evidence: `${worst.view} has p50 ${fmtMs(worst.p50)} across ${fmtN(worst.sessions)} sessions.`,
        action: "Open the trace for this view and look for a single span consuming nearly the whole duration.",
      });
    }

    const seqs = d.sequences.filter((s) => s.appId === appId);
    const reachesCheckout = seqs.some((s) => reachesOutcome(s.journey));
    const reachesCart = seqs.some((s) => s.journey.some((v) => INTENT.test(v)));
    if (seqs.length && reachesCart && !reachesCheckout) {
      push({
        severity: "warning",
        title: "Conversion cannot be measured for this application",
        body: "Discovered journeys reach the cart and stop. There is no instrumented step after it, so every funnel number past the cart is absent rather than zero — the business cannot tell an abandoned cart from an uninstrumented success.",
        evidence: `${fmtN(seqs.length)} distinct journeys mined; none reaches a completion view.`,
        action: "Instrument the final view of the flow, or send a business event when it completes.",
      });
    }
    const covered = seqs.reduce((a, s) => a + s.sessions, 0);
    if (app.sessions > 0 && covered / app.sessions < 0.9) {
      const blind = app.sessions - covered;
      push({
        severity: "warning",
        title: "A share of sessions never records a single view",
        body: "These sessions exist but carry no page, so they cannot enter any funnel or journey analysis. They are counted in totals and invisible in every breakdown, which quietly biases every rate you compute.",
        evidence: `${fmtN(blind)} of ${fmtN(app.sessions)} sessions (${fmtPct(pct(blind, app.sessions))}) have no view_summary event.`,
      });
    }
  }

  /* ─────── layer 04 · edge ─────── */
  if (tier === 3) {
    const first = d.domains.find((x) => x.provider === "first_party");
    const views = d.views.filter((v) => v.appId === appId);
    const worst = [...views].sort((a, b) => b.p50 - a.p50)[0];
    if (first && worst && worst.p50 > first.p50 * 20) {
      push({
        severity: "critical",
        title: "The delay does not start at the edge",
        body: "The ingress answers quickly while the view it serves takes orders of magnitude longer. The time is being spent past this hop — in a downstream service or a dependency it waits on — so tuning the proxy would change nothing.",
        evidence: `Ingress p50 ${fmtMs(first.p50)} against ${worst.view} at ${fmtMs(worst.p50)} — a factor of ${Math.round(worst.p50 / first.p50)}.`,
        action: "Follow the chain to the right and look for the first hop whose latency matches the view.",
      });
    }
    if (first && first.err === 0 && first.reqs > 10000) {
      push({
        severity: "good",
        title: "The entry point is clean at high volume",
        body: "Tens of thousands of requests without a single failed response means routing, TLS and upstream availability at this hop are healthy. Exclude the edge when triaging.",
        evidence: `${fmtK(first.reqs)} requests through ${first.domain} with 0 errors.`,
      });
    }
  }

  /* ─────── layer 05 · services ─────── */
  if (tier === 4) {
    const raw = d.calls.find((c) => c.src.split(" - ")[0] === elementName)?.src ?? elementName;
    const fanOut = d.calls.filter((c) => c.src === raw).length;
    const fanIn = d.calls.filter((c) => c.dst === raw).length;

    if (fanOut >= 6) {
      push({
        severity: "warning",
        title: "This service is an orchestrator, so its blast radius is wide",
        body: "It depends on many services at once, which means its latency is the sum of the slowest paths and its failure surface is the union of theirs. A single slow dependency is enough to degrade it.",
        evidence: `Calls ${fanOut} services: ${d.calls.filter((c) => c.src === raw).map((c) => c.dst.split(" - ")[0]).slice(0, 6).join(", ")}.`,
        action: "Check which of the downstream calls is slowest before investigating this service itself.",
      });
    }
    if (fanIn >= 2 && fanOut >= 1) {
      push({
        severity: "critical",
        title: "A shared dependency on the critical path",
        body: "Several services call this one, so its degradation propagates to every caller at once. Incidents that look unrelated upstream can share this single root.",
        evidence: `Called by ${fanIn} services and calls ${fanOut} further downstream.`,
      });
    }
    const own = d.problems.filter((p) => (p.entityIds ?? []).some((id) => entityIds.includes(id)));
    const downstream = d.calls.filter((c) => c.src === raw).map((c) => c.dstId);
    const downProblems = d.problems.filter((p) => (p.entityIds ?? []).some((id) => downstream.includes(id)));
    if (!own.length && downProblems.length) {
      push({
        severity: "warning",
        title: "The symptom would surface here, but the cause is downstream",
        body: "This service carries no problem of its own while something it depends on does. Alerting on this service would report a consequence; the fix belongs one hop further.",
        evidence: `${downProblems.length} active problem(s) on services called by ${elementName}.`,
      });
    }
  }

  /* ─────── layer 06 · runtime ─────── */
  if (tier === 5) {
    const clouds = new Set(
      d.runtime.map((r) => (r.node.startsWith("gke") ? "GKE" : r.node.startsWith("aks") ? "AKS" : "other")),
    );
    const mine = d.runtime.find((r) => r.pod === elementName);
    if (clouds.size > 1) {
      push({
        severity: "notable",
        title: "The workload is split across two cloud providers",
        body: "Pods of the same application mesh run on different providers. Latency between them crosses a provider boundary, and an incident on either side affects only part of the traffic — which makes symptoms look intermittent.",
        evidence: `Nodes observed on ${[...clouds].join(" and ")} across ${fmtN(d.runtime.length)} mapped pods.`,
      });
    }
    if (mine) {
      const sameNode = d.runtime.filter((r) => r.nodeId === mine.nodeId).length;
      if (sameNode >= 3) {
        push({
          severity: "warning",
          title: "Several pods share this node",
          body: "Concentrating pods on one node means a node-level event — pressure, eviction, restart — takes all of them down together, regardless of how the deployments are configured.",
          evidence: `${sameNode} mapped pods run on ${mine.node}.`,
          action: "Check anti-affinity rules if these pods are meant to be replicas of each other.",
        });
      }
    }
  }

  /* ─────── layer 07 · infrastructure ─────── */
  if (tier === 6) {
    const svcTotal = d.topology.find((t) => t.type === "SERVICE")?.nodes ?? 0;
    const inGraph = new Set(d.calls.flatMap((c) => [c.srcId, c.dstId])).size;
    if (svcTotal > 0 && inGraph > 0 && inGraph < svcTotal * 0.6) {
      push({
        severity: "notable",
        title: "Most services in the environment never appear in a call relation",
        body: "The topology knows about far more services than the call graph connects. Those services are either idle, isolated, or their traffic is not being traced — and none of them can be reached by dependency analysis.",
        evidence: `${fmtN(inGraph)} of ${fmtN(svcTotal)} services participate in a mapped call relation (${fmtPct(pct(inGraph, svcTotal))}).`,
      });
    }
  }

  /* ─────── any layer: signals bound to this entity ─────── */
  if (entityIds.length) {
    const probs = d.problems.filter((p) => (p.entityIds ?? []).some((id) => entityIds.includes(id)));
    const alerts = d.signals.filter((s) => entityIds.includes(s.entityId) && s.provider === "METRIC_EVENTS");
    if (probs.length) {
      push({
        severity: "critical",
        title: "Davis has an open problem on this exact entity",
        body: "This is not a correlation across a layer — the AI attributed the problem to this entity id. It is the most direct evidence available that this element is the one misbehaving.",
        evidence: probs.map((p) => `${p.display_id} · ${p.name} (${p.category})`).join(" · "),
        action: "Open the problem to see the root cause the AI already computed instead of re-deriving it.",
      });
    }
    if (alerts.some((a) => a.status === "ACTIVE")) {
      const a = alerts.find((x) => x.status === "ACTIVE")!;
      push({
        severity: "warning",
        title: "A custom alert someone configured is firing here",
        body: "Unlike a detected anomaly, this threshold was set deliberately by a team — it encodes an expectation that is currently being violated.",
        evidence: `${a.name} · ${fmtN(a.events)} occurrence(s) in 24h.`,
      });
    }
  }

  return out.sort((a, b) => RANK[a.severity] - RANK[b.severity]).slice(0, 4);
}
