// Executive report engine.
//
// Aggregates the whole environment into findings that carry business weight:
// each one states a measured fact, why it costs money or risk, and the
// conversation it opens. Application names are aliased ("Application A") so
// the report can leave the building without naming anyone — the numbers stay
// real, the identities do not.
import { INTENT, fmtK, fmtMs, fmtN, reachesOutcome } from "./dql";
import { hitTone } from "./verdict";
import type { ChainData } from "../hooks/useChainData";
import type { Severity } from "./insights";

export interface ReportFinding {
  severity: Severity;
  /** Business area the finding belongs to. */
  area: string;
  /** The claim, in one line. */
  title: string;
  /** The consequence, in business terms. */
  narrative: string;
  /** The measured numbers that produced the claim. */
  evidence: string;
  /** The conversation this finding opens. */
  opportunity: string;
}

export interface Report {
  window: string;
  anonymized: boolean;
  kpis: Array<{ label: string; value: string; tone: "good" | "warn" | "bad" | "info" }>;
  findings: ReportFinding[];
}

const RANK: Record<Severity, number> = { critical: 0, warning: 1, notable: 2, good: 3 };
const pct = (a: number, b: number) => (b ? (a / b) * 100 : 0);
const fmtPct = (v: number) => `${v.toFixed(v < 10 ? 1 : 0)}%`;

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Stable aliases: the busiest application is always "Application A". */
export function aliasMap(d: ChainData): Map<string, string> {
  const m = new Map<string, string>();
  [...d.apps]
    .sort((a, b) => b.sessions - a.sessions)
    .forEach((a, i) => m.set(a.name, `Application ${String.fromCharCode(65 + i)}`));
  return m;
}

export function buildReport(d: ChainData, anonymize: boolean,
  ux?: Map<string, { sessions: number; hit: number }> | null): Report {
  const aliases = aliasMap(d);
  const nm = (name: string) => (anonymize ? aliases.get(name) ?? name : name);
  const out: ReportFinding[] = [];

  // Same per-session scan the header, the estate table and every application
  // page quote — a report that restates the window must restate it identically.
  const sessionsOf = (a: { appId: string; sessions: number }) =>
    ux?.get(a.appId)?.sessions ?? a.sessions;
  const totalSessions = d.apps.reduce((a, x) => a + sessionsOf(x), 0);
  const totalHit = ux ? d.apps.reduce((a, x) => a + (ux.get(x.appId)?.hit ?? 0), 0) : null;
  const totalViews = d.apps.reduce((a, x) => a + x.views, 0);
  const totalErrors = d.apps.reduce((a, x) => a + x.errors, 0);
  const deviceSessions = d.devices.reduce((a, r) => a + r.sessions, 0);
  const synthetic = d.devices
    .filter((r) => r.utype === "synthetic" || r.utype === "robot")
    .reduce((a, r) => a + r.sessions, 0);

  /* ── 1 · real-user visibility ── */
  if (deviceSessions && synthetic / deviceSessions > 0.5) {
    const share = pct(synthetic, deviceSessions);
    out.push({
      severity: share > 0.95 * 100 ? "critical" : "warning",
      area: "Digital experience",
      title: "The customer experience is not being measured yet",
      narrative:
        "Almost all measured traffic comes from synthetic monitors and robots. Every experience decision — what to fix first, whether a release helped — is currently being made without a single real user in the data.",
      evidence: `${fmtN(synthetic)} of ${fmtN(deviceSessions)} sessions (${fmtPct(share)}) are synthetic or robot traffic.`,
      opportunity:
        "Extend RUM to the production domains: the platform is already collecting at this depth for test traffic, so real-user visibility is a rollout away, not a project.",
    });
  }

  /* ── 2 · conversion blind spot ── */
  const blindApps = d.apps.filter((a) => {
    const seqs = d.sequences.filter((s) => s.appId === a.appId);
    return (
      seqs.length > 0 &&
      seqs.some((s) => s.journey.some((v) => INTENT.test(v))) &&
      !seqs.some((s) => reachesOutcome(s.journey))
    );
  });
  for (const a of blindApps.slice(0, 1)) {
    out.push({
      severity: "critical",
      area: "Conversion",
      title: "Revenue funnels go dark before the money step",
      narrative:
        `Mined journeys for ${nm(a.name)} reach the cart and stop — no instrumented step exists after it. The business cannot distinguish an abandoned cart from a completed order, so conversion, and everything priced on it, is unmeasurable.`,
      evidence: `${fmtN(d.sequences.filter((s) => s.appId === a.appId).length)} distinct journeys discovered; none reaches a completion view.`,
      opportunity:
        "Business events on order completion close the funnel end-to-end and turn this same data into revenue-at-risk numbers per incident.",
    });
  }

  /* ── 3 · sessions invisible to any analysis ── */
  const worstCoverage = d.apps
    .map((a) => {
      const covered = d.sequences
        .filter((s) => s.appId === a.appId)
        .reduce((acc, s) => acc + s.sessions, 0);
      return { a, blind: a.sessions - covered };
    })
    .filter((x) => x.a.sessions > 100 && x.blind / x.a.sessions > 0.15)
    .sort((x, y) => pct(y.blind, y.a.sessions) - pct(x.blind, x.a.sessions))[0];
  if (worstCoverage) {
    out.push({
      severity: "warning",
      area: "Observability coverage",
      title: "A slice of every metric is computed on incomplete data",
      narrative:
        `${nm(worstCoverage.a.name)} has sessions that never record a single page view. They inflate session counts while being invisible to funnels, journeys and engagement — every rate derived from this data carries a silent bias.`,
      evidence: `${fmtN(worstCoverage.blind)} of ${fmtN(worstCoverage.a.sessions)} sessions (${fmtPct(pct(worstCoverage.blind, worstCoverage.a.sessions))}) contain no view event.`,
      opportunity:
        "An instrumentation review closes the gap; the same review usually surfaces untagged single-page-app routes worth measuring on their own.",
    });
  }

  /* ── 4 · error concentration ── */
  const peers = d.apps.filter((a) => a.views > 0);
  const med = median(peers.map((a) => a.errors / Math.max(1, a.views)));
  const hotspot = peers
    .map((a) => ({ a, ratio: a.errors / Math.max(1, a.views) }))
    .filter((x) => med > 0 && x.ratio > med * 2)
    .sort((x, y) => y.ratio - x.ratio)[0];
  if (hotspot) {
    out.push({
      severity: "critical",
      area: "Reliability",
      title: "One application concentrates the experience risk",
      narrative:
        `Users of ${nm(hotspot.a.name)} hit errors at a rate its peers on the same platform do not. Whatever error budget the business thinks it has, this application is spending most of it.`,
      evidence: `${hotspot.ratio.toFixed(1)} errors per view against a peer median of ${med.toFixed(1)} — ${(hotspot.ratio / med).toFixed(1)}× higher; ${fmtK(hotspot.a.errors)} of ${fmtK(totalErrors)} environment errors (${fmtPct(pct(hotspot.a.errors, totalErrors))}).`,
      opportunity:
        "Session-level replay and error analytics on this one application turns an error count into the exact user paths that produce it — a contained, high-visibility win.",
    });
  }

  /* ── 5 · incident load the AI already carries ── */
  if (d.problems.length) {
    const cats = [...new Set(d.problems.map((p) => p.category))].filter(Boolean);
    out.push({
      severity: d.problems.length >= 5 ? "warning" : "notable",
      area: "Operations",
      title: "The AI is already holding open incidents nobody has to triage manually",
      narrative:
        "Each of these was detected, correlated and attributed to entities automatically. The open question is not detection — it is what happens next: today the follow-up is manual.",
      evidence: `${fmtN(d.problems.length)} active problems across ${cats.length} categories (${cats.slice(0, 4).join(", ")}).`,
      opportunity:
        "Workflow automation on problem-open events — ticketing, rollback, paging — converts detection latency the platform already won into resolution latency the business feels.",
    });
  }

  /* ── 6 · multi-cloud complexity ── */
  const clouds = new Set(
    d.runtime.map((r) => (r.node.startsWith("gke") ? "GKE" : r.node.startsWith("aks") ? "AKS" : "other")),
  );
  clouds.delete("other");
  if (clouds.size > 1) {
    out.push({
      severity: "notable",
      area: "Cloud & runtime",
      title: "The same application mesh spans two cloud providers",
      narrative:
        "Pods of one workload run on different providers, so latency crosses a provider boundary and incidents on either side degrade only part of the traffic — the class of problem that looks intermittent and burns the most engineering hours.",
      evidence: `Workloads observed on ${[...clouds].join(" and ")} across ${fmtN(d.runtime.length)} mapped pods.`,
      opportunity:
        "A single topology across both providers is the differentiator here: per-cloud tooling structurally cannot see this boundary, and this environment already crosses it.",
    });
  }

  /* ── 7 · tracing coverage ── */
  const svcTotal = d.topology.find((t) => t.type === "SERVICE")?.nodes ?? 0;
  const inGraph = new Set(d.calls.flatMap((c) => [c.srcId, c.dstId])).size;
  if (svcTotal > 0 && inGraph > 0 && inGraph < svcTotal * 0.6) {
    out.push({
      severity: "notable",
      area: "Observability coverage",
      title: "Most known services are outside the traced call graph",
      narrative:
        "The topology registers far more services than the call graph connects. Dependency analysis, blast-radius estimation and root-cause automation stop at the edge of the traced set — the rest is invisible to all of it.",
      evidence: `${fmtN(inGraph)} of ${fmtN(svcTotal)} services participate in a mapped call relation (${fmtPct(pct(inGraph, svcTotal))}).`,
      opportunity:
        "Extending tracing to the unconnected services grows every automated analysis in the platform at once — one instrumentation effort, compounding returns.",
    });
  }

  /* ── 8 · third-party dependency risk ── */
  const first = d.domains.find((x) => x.provider === "first_party");
  const slowTp = d.domains
    .filter((x) => x.provider !== "first_party" && first && x.p50 > first.p50 * 1.4)
    .sort((a, b) => b.p50 - a.p50)[0];
  if (slowTp && first) {
    out.push({
      severity: "notable",
      area: "Digital experience",
      title: "A dependency outside the company's control caps page speed",
      narrative:
        "A third-party domain on the critical path answers slower than the first-party backend. No internal optimisation can beat that floor — and no internal team owns it.",
      evidence: `${slowTp.domain} p50 ${fmtMs(slowTp.p50)} vs first-party ${fmtMs(first.p50)} (${(slowTp.p50 / first.p50).toFixed(1)}×) over ${fmtN(slowTp.reqs)} requests.`,
      opportunity:
        "Third-party SLA reporting from real-user data gives procurement leverage the vendor cannot argue with.",
    });
  }

  /* ── 9 · signal consolidation already achieved ── */
  const extProviders = d.providers.filter((p) => p.provider && p.provider !== "METRIC_EVENTS");
  if (extProviders.length >= 3) {
    out.push({
      severity: "good",
      area: "Platform",
      title: "Signals from across the estate already land in one place",
      narrative:
        "Events arrive from multiple independent sources — extensions, network devices, cloud agents, business feeds. The consolidation work that usually blocks value is already done; what remains is exploiting it.",
      evidence: `${fmtN(extProviders.length)} distinct event providers active in 24h, ${fmtK(extProviders.reduce((a, p) => a + p.events, 0))} events.`,
      opportunity:
        "Cross-source correlation — business events against infrastructure signals — is available today with zero additional ingest.",
    });
  }

  const kpis: Report["kpis"] = [
    { label: "Applications measured", value: String(d.apps.length), tone: "info" },
    { label: "Sessions", value: fmtN(totalSessions), tone: "info" },
    // the estate verdict, by the same rule the other screens are coloured by
    ...(totalHit !== null && totalSessions > 0 ? [{
      label: "Sessions error-free",
      value: `${Math.floor((1 - totalHit / totalSessions) * 100)}%`,
      tone: hitTone(totalHit / totalSessions) === "good" ? "good" as const
        : hitTone(totalHit / totalSessions) === "warn" ? "warn" as const : "bad" as const,
    }] : []),
    { label: "Views", value: fmtK(totalViews), tone: "good" },
    { label: "Errors", value: fmtK(totalErrors), tone: totalErrors > totalViews ? "bad" : "warn" },
    { label: "Active AI-detected problems", value: String(d.problems.length), tone: d.problems.length ? "bad" : "good" },
    { label: "Services in topology", value: fmtN(svcTotal), tone: "good" },
  ];

  return {
    window: d.tf.label,
    anonymized: anonymize,
    kpis,
    findings: out.sort((a, b) => RANK[a.severity] - RANK[b.severity]),
  };
}

/** The report as Markdown, ready to paste into a deck, e-mail or doc. */
export function reportMarkdown(r: Report): string {
  const sev: Record<Severity, string> = {
    critical: "CRITICAL", warning: "ATTENTION", notable: "CONTEXT", good: "STRENGTH",
  };
  const lines = [
    `# Digital delivery — executive findings`,
    ``,
    `Window: last ${r.window} · all figures measured, none estimated${r.anonymized ? " · application names anonymized" : ""}`,
    ``,
    `| Indicator | Value |`,
    `| --- | --- |`,
    ...r.kpis.map((k) => `| ${k.label} | ${k.value} |`),
    ``,
  ];
  for (const f of r.findings) {
    lines.push(
      `## [${sev[f.severity]}] ${f.title}`,
      ``,
      `*${f.area}*`,
      ``,
      f.narrative,
      ``,
      `> Evidence: ${f.evidence}`,
      ``,
      `**Opportunity:** ${f.opportunity}`,
      ``,
    );
  }
  return lines.join("\n");
}
