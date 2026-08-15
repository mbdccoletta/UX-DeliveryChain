// Business insights — the Report page's engine, on two fronts.
//
// The reader reframed the page: not observability findings for the platform
// team ("the experience is not being measured yet") but value for the
// business, on two fronts it names — PROTECT THE BRAND and DELIVER
// PERSONALISED JOURNEYS. An insight here has to carry three things a
// business reader recognises: a number in their vocabulary (people, sessions,
// completion — never p95, never spans), the context that makes it a decision
// (against whom, trending where), and the action with a destination. And the
// fourth rule of this whole app: nothing invented — every figure comes from a
// query that already ran for the screen.
//
// Every application is aliased when the report is anonymised, so it can leave
// the building; the numbers stay real, the identities do not.
import { fmtK, fmtN, fmtMs, DONE, reachesOutcome } from "./dql";
import { HIT_WARN, HIT_BAD } from "./verdict";
import type { ChainData, AppRow } from "../hooks/useChainData";
import type { UxRow } from "../hooks/useUxOverview";

export type Front = "brand" | "journeys";
export type Weight = "critical" | "warning" | "notable" | "good";

export interface BizInsight {
  front: Front;
  weight: Weight;
  /** The claim, in the business's own words. */
  title: string;
  /** The measured fact, stated as a sentence. */
  fact: string;
  /** Why it matters to the business — the consequence. */
  consequence: string;
  /** What to do, and where — the destination is a screen of THIS app. */
  action: { label: string; tab: "chain" | "flow" | "home"; appId?: string; hl?: string };
  /** The application it is about, aliased or named. */
  app?: string;
}

export interface BizReport {
  window: string;
  anonymized: boolean;
  /** The two fronts' headline numbers. */
  brandKpis: Array<{ label: string; value: string; tone: Weight }>;
  journeyKpis: Array<{ label: string; value: string; tone: Weight }>;
  insights: BizInsight[];
}

const RANK: Record<Weight, number> = { critical: 0, warning: 1, notable: 2, good: 3 };
const pct = (a: number, b: number) => (b ? (a / b) * 100 : 0);
const fmtPct = (v: number) => `${v.toFixed(v < 10 ? 1 : 0)}%`;

/** Stable aliases: the busiest application is always "Application A". */
export function aliasMap(d: ChainData): Map<string, string> {
  const m = new Map<string, string>();
  [...d.apps]
    .sort((a, b) => b.sessions - a.sessions)
    .forEach((a, i) => m.set(a.name, `Application ${String.fromCharCode(65 + i)}`));
  return m;
}

export function buildBizReport(
  d: ChainData, anonymize: boolean, ux: Map<string, UxRow> | null,
): BizReport {
  const aliases = aliasMap(d);
  const nm = (a: AppRow) => (anonymize ? aliases.get(a.name) ?? a.name : a.name);
  const out: BizInsight[] = [];
  const isMobile = (a: AppRow) => !!a.entity?.startsWith("MOBILE_APPLICATION-");

  // ── the estate, in people ──
  // Real people only: robots and monitors are not customers, and a brand
  // figure that counted them would be a figure the business could not act on.
  const rows = d.apps.map((a) => ({ a, u: ux?.get(a.appId) }));
  const real = rows.reduce((s, r) => s + (r.u?.realSessions ?? 0), 0);
  const hitReal = rows.reduce((s, r) => s + (r.u?.hitReal ?? 0), 0);
  const crashes = d.apps.reduce((s, a) => s + a.crashes, 0);
  const anrs = d.apps.reduce((s, a) => s + a.anrs, 0);
  const engaged = rows.reduce((s, r) => s + (r.u?.engaged ?? 0), 0);
  const actions = rows.reduce((s, r) => s + (r.u?.actions ?? 0), 0);
  const abandoned = rows.reduce((s, r) => s + (r.u?.abandoned ?? 0), 0);
  const sat = rows.reduce((s, r) => s + (r.u?.satisfied ?? 0), 0);
  const tol = rows.reduce((s, r) => s + (r.u?.tolerating ?? 0), 0);
  const fru = rows.reduce((s, r) => s + (r.u?.frustrated ?? 0), 0);
  const rated = sat + tol + fru;
  const apdex = rated ? (sat + tol / 2) / rated : null;

  /* ═══════════════ FRONT 1 · PROTECT THE BRAND ═══════════════ */

  // 1. People hit, application by application — the brand's exposure
  for (const { a, u } of rows) {
    if (!u || u.realSessions === 0) continue;
    const share = u.hitReal / u.realSessions;
    if (share < HIT_WARN) continue;
    out.push({
      front: "brand",
      weight: share >= HIT_BAD ? "critical" : "warning",
      app: nm(a),
      title: `${fmtPct(share * 100)} of ${nm(a)}'s real users met an error`,
      fact: `${fmtN(u.hitReal)} of ${fmtN(u.realSessions)} human sessions in the window ran into at least one error`
        + (u.hitRobot + u.hitSynth > 0
          ? ` — robots and monitors (${fmtN(u.hitRobot + u.hitSynth)} more) are excluded from this figure` : "") + ".",
      consequence: share >= HIT_BAD
        ? "More than half of the people using this application saw it fail. At this rate the brand is being judged by its errors, not its features — every session is a potential review, support ticket or churned customer."
        : "One in ten or more customers is meeting a failure. Below the threshold most teams notice, above the one customers remember.",
      action: { label: "See which errors reached them", tab: "home", appId: a.appId },
    });
  }

  // 2. Fatal on mobile — the session ends, the customer is gone
  for (const a of d.apps) {
    if (!isMobile(a) || (a.crashes + a.anrs) === 0) continue;
    const u = ux?.get(a.appId);
    const base = u?.realSessions ?? a.sessions;
    const fatalShare = base ? (a.crashes + a.anrs) / base : 0;
    out.push({
      front: "brand",
      weight: fatalShare >= 0.05 ? "critical" : fatalShare >= 0.01 ? "warning" : "notable",
      app: nm(a),
      title: `${nm(a)} crashed on ${fmtN(a.crashes)} sessions${a.anrs ? ` and froze on ${fmtN(a.anrs)}` : ""}`,
      fact: `${fmtN(a.crashes)} crashes${a.anrs ? ` and ${fmtN(a.anrs)} ANRs (the app frozen until the OS killed it)` : ""} across ${fmtN(base)} sessions — ${fmtPct(fatalShare * 100)} of them ended this way.`,
      consequence: "A crash is the one failure a customer cannot retry: the session ends, and on a store-listed app it ends in a rating. Crash rate is the single number that most directly moves the app-store score.",
      action: { label: "Inspect the crashes", tab: "home", appId: a.appId },
    });
  }

  // 3. Where the failures come from — third parties vs own code
  {
    const third = rows.reduce((s, r) => s + (r.u?.errorsThird ?? 0), 0);
    const all = rows.reduce((s, r) => s + (r.u?.errors ?? 0), 0);
    if (all > 0 && third / all >= 0.25) {
      out.push({
        front: "brand", weight: "notable",
        title: `${fmtPct(pct(third, all))} of all failures come from third parties the brand does not control`,
        fact: `${fmtN(third)} of ${fmtN(all)} errors in the window originated in third-party domains — CDNs, tag managers, analytics, payment or ad providers.`,
        consequence: "The customer does not distinguish: a failure on the page is the brand's failure. But the fix is contractual, not engineering — this is a vendor conversation, and the number is the agenda.",
        action: { label: "See the third-party path in the delivery chain", tab: "chain" },
      });
    }
  }

  // 4. Davis problems with people behind them
  {
    const open = d.problems.length;
    if (open > 0) {
      const withApps = d.problems.filter((p) =>
        (p.entityIds ?? []).some((e) => /APPLICATION-/.test(e))).length;
      out.push({
        front: "brand", weight: withApps > 0 ? "warning" : "notable",
        title: `${fmtN(open)} incident${open === 1 ? "" : "s"} open right now${withApps ? `, ${fmtN(withApps)} directly on a customer-facing application` : ""}`,
        fact: `Davis has ${fmtN(open)} active problem${open === 1 ? "" : "s"} in the window; ${withApps ? `${fmtN(withApps)} of them` : "none"} ${withApps === 1 ? "is" : "are"} attached to an application customers use.`,
        consequence: withApps
          ? "An incident on a customer application is already a brand event — the question is only whether the business hears about it from monitoring or from customers."
          : "The open incidents are below the customer layer for now; the delivery chain shows which applications they could reach.",
        action: { label: "See where the incidents sit in the chain", tab: "chain", hl: "anomalies" },
      });
    }
  }

  /* ═══════════════ FRONT 2 · DELIVER PERSONALISED JOURNEYS ═══════════════ */

  // 5. Where each application's journey breaks — the funnel in business words
  for (const a of d.apps) {
    const mine = d.sequences.filter((s) => s.appId === a.appId && s.journey.length > 0);
    const total = mine.reduce((s, x) => s + x.sessions, 0);
    if (total < 30) continue;
    const outcomes = mine.some((s) => reachesOutcome(s.journey));
    if (!outcomes) continue;
    const done = mine.filter((s) => reachesOutcome(s.journey)).reduce((s, x) => s + x.sessions, 0);
    // the view most sessions were on when they stopped without finishing
    const lastStop = new Map<string, number>();
    for (const s of mine) {
      if (reachesOutcome(s.journey)) continue;
      const last = s.journey[s.journey.length - 1];
      lastStop.set(last, (lastStop.get(last) ?? 0) + s.sessions);
    }
    const [worstView, worstN] = [...lastStop.entries()].sort((x, y) => y[1] - x[1])[0] ?? ["", 0];
    const rate = pct(done, total);
    out.push({
      front: "journeys",
      weight: rate < 25 ? "critical" : rate < 50 ? "warning" : "notable",
      app: nm(a),
      title: `${fmtPct(rate)} of ${nm(a)}'s journeys reach the goal${worstView ? ` — most losses stop at ${worstView}` : ""}`,
      fact: `${fmtN(done)} of ${fmtN(total)} journeys with a recorded path completed${worstView ? `; ${fmtN(worstN)} sessions ended on ${worstView} without finishing` : ""}.`,
      consequence: worstView
        ? `Every session that stops at ${worstView} is a customer who wanted the outcome and did not get it. That view is where a personalised nudge — a saved cart, a simpler form, a targeted offer — pays first.`
        : "The journeys that stop short are the audience personalisation exists for.",
      action: { label: "Open the flow and isolate the drop-off", tab: "flow", appId: a.appId },
    });
  }

  // 6. Engagement — who goes past the first screen
  for (const { a, u } of rows) {
    if (!u || u.realSessions < 50) continue;
    const bounce = 1 - u.engaged / Math.max(1, u.sessions);
    if (bounce < 0.5) continue;
    out.push({
      front: "journeys", weight: bounce >= 0.75 ? "warning" : "notable",
      app: nm(a),
      title: `${fmtPct(bounce * 100)} of ${nm(a)}'s sessions never go past the first screen`,
      fact: `${fmtN(u.sessions - u.engaged)} of ${fmtN(u.sessions)} sessions saw one view and left.`,
      consequence: "A first screen that most people leave is either doing its job in one glance or failing to invite the next step — the entry-view breakdown tells which, segment by segment.",
      action: { label: "See who these users are", tab: "flow", appId: a.appId },
    });
  }

  // 7. Abandoned actions — intent that went nowhere
  for (const { a, u } of rows) {
    if (!u || u.actions < 100) continue;
    const ab = u.abandoned / u.actions;
    if (ab < 0.05) continue;
    out.push({
      front: "journeys", weight: ab >= 0.15 ? "warning" : "notable",
      app: nm(a),
      title: `${fmtPct(ab * 100)} of actions on ${nm(a)} were abandoned mid-flight`,
      fact: `${fmtN(u.abandoned)} of ${fmtN(u.actions)} user actions ended because the user left the page or the tab before they completed.`,
      consequence: "An abandoned action is a customer who clicked and gave up waiting. It is the most direct measure of a journey losing patience — and it names the exact interaction to shorten.",
      action: { label: "Find the views where it happens", tab: "flow", appId: a.appId },
    });
  }

  // 8. Perceived speed — the Apdex, in the business's words
  if (apdex !== null && rated >= 100) {
    const slowShare = fru / rated;
    out.push({
      front: "journeys",
      weight: apdex < 0.7 ? "critical" : apdex < 0.85 ? "warning" : apdex < 0.94 ? "notable" : "good",
      title: apdex >= 0.94
        ? `Customers rate the experience fast — Apdex ${apdex.toFixed(2)}`
        : `${fmtPct(slowShare * 100)} of customer actions were slow enough to frustrate`,
      fact: `Of ${fmtN(rated)} rated user actions, ${fmtN(sat)} were satisfied (≤3 s), ${fmtN(tol)} tolerating and ${fmtN(fru)} frustrated (>12 s) — Apdex ${apdex.toFixed(2)}.`,
      consequence: apdex >= 0.94
        ? "Speed is not the lever for growth here; the personalisation levers are content and path, not performance."
        : "Slow actions convert worse and are remembered longer than fast ones. The Apdex names the share of the audience that is losing patience — and the delivery chain names the layer costing them the time.",
      action: { label: "See where the time goes", tab: "chain" },
    });
  }

  // ── KPI strips ──
  const brandKpis = [
    { label: "real users hit by errors", value: real ? fmtPct(pct(hitReal, real)) : "—",
      tone: (real && hitReal / real >= HIT_BAD ? "critical" : real && hitReal / real >= HIT_WARN ? "warning" : "good") as Weight },
    { label: "human sessions", value: fmtK(real), tone: "notable" as Weight },
    { label: "crashes + ANRs (mobile)", value: fmtN(crashes + anrs),
      tone: (crashes + anrs > 0 ? "warning" : "good") as Weight },
    { label: "open incidents", value: fmtN(d.problems.length),
      tone: (d.problems.length > 0 ? "warning" : "good") as Weight },
  ];
  const journeyKpis = [
    { label: "engaged beyond first screen", value: real ? fmtPct(pct(engaged, rows.reduce((s, r) => s + (r.u?.sessions ?? 0), 0))) : "—", tone: "notable" as Weight },
    { label: "actions abandoned", value: actions ? fmtPct(pct(abandoned, actions)) : "—",
      tone: (actions && abandoned / actions >= 0.15 ? "warning" : "good") as Weight },
    { label: "apdex", value: apdex === null ? "—" : apdex.toFixed(2),
      tone: (apdex === null ? "notable" : apdex < 0.7 ? "critical" : apdex < 0.85 ? "warning" : "good") as Weight },
    { label: "applications", value: fmtN(d.apps.length), tone: "notable" as Weight },
  ];

  return {
    window: d.tf.label, anonymized: anonymize, brandKpis, journeyKpis,
    insights: out.sort((a, b) => RANK[a.weight] - RANK[b.weight]),
  };
}

/** The report as Markdown, ready to paste into a deck, e-mail or doc. */
export function bizMarkdown(r: BizReport): string {
  const w: Record<Weight, string> = {
    critical: "CRITICAL", warning: "ATTENTION", notable: "CONTEXT", good: "STRENGTH" };
  const front = (f: Front) => r.insights.filter((i) => i.front === f);
  const block = (title: string, kpis: BizReport["brandKpis"], list: BizInsight[]) => [
    `## ${title}`, ``,
    `| Indicator | Value |`, `| --- | --- |`,
    ...kpis.map((k) => `| ${k.label} | ${k.value} |`), ``,
    ...list.flatMap((i) => [
      `### [${w[i.weight]}] ${i.title}`, ``,
      i.fact, ``,
      `**Why it matters:** ${i.consequence}`, ``,
      `**Action:** ${i.action.label}`, ``,
    ]),
  ];
  return [
    `# Business insights — digital experience`, ``,
    `Window: ${r.window} · every figure measured, none estimated${r.anonymized ? " · application names anonymized" : ""}`, ``,
    ...block("Protect the brand", r.brandKpis, front("brand")),
    ...block("Deliver personalised journeys", r.journeyKpis, front("journeys")),
  ].join("\n");
}
