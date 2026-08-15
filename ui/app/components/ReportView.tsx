// Business insights — the Report page, on the two fronts the reader named:
// PROTECT THE BRAND and DELIVER PERSONALISED JOURNEYS.
//
// Every card is fact → consequence → action, in the business's vocabulary,
// and every action lands on a screen of this app already scoped to the
// application in question. Anonymised by default so the page can leave the
// building; the numbers stay real, the identities do not.
import React, { useMemo, useState } from "react";
import type { ChainData } from "../hooks/useChainData";
import { buildBizReport, bizMarkdown, type BizInsight, type Front, type Weight } from "../utils/bizInsights";
import { useUxOverview } from "../hooks/useUxOverview";

const W_COLOR: Record<Weight, string> = {
  critical: "var(--bad)", warning: "var(--warn)", notable: "var(--info)", good: "var(--good)",
};
const W_LABEL: Record<Weight, string> = {
  critical: "critical", warning: "attention", notable: "context", good: "strength",
};
const FRONT: Record<Front, { title: string; sub: string; hue: string }> = {
  brand: {
    title: "Protect the brand",
    sub: "Where real customers meet failure — and what it costs before anyone tells you",
    hue: "var(--t-pink)",
  },
  journeys: {
    title: "Deliver personalised journeys",
    sub: "Where journeys break, who breaks them, and where a targeted change pays first",
    hue: "var(--t-cyan)",
  },
};

export function ReportView({ data, onGo }: {
  data: ChainData;
  /** Navigate inside the app: the insight's action lands scoped to its application. */
  onGo?: (tab: "chain" | "flow" | "home", appId?: string, hl?: string) => void;
}) {
  const [anon, setAnon] = useState(true);
  const [copied, setCopied] = useState(false);
  const ux = useUxOverview(data.tf);
  const report = useMemo(() => buildBizReport(data, anon, ux), [data, anon, ux]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(bizMarkdown(report));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard may be unavailable */ }
  };

  const Section = ({ front }: { front: Front }) => {
    const f = FRONT[front];
    const list = report.insights.filter((i) => i.front === front);
    const kpis = front === "brand" ? report.brandKpis : report.journeyKpis;
    return (
      <section className="biz" style={{ ["--fh" as string]: f.hue }}>
        <header className="biz__hd">
          <h2 className="biz__title">{f.title}</h2>
          <p className="biz__sub">{f.sub}</p>
          <div className="biz__kpis">
            {kpis.map((k) => (
              <div className="biz__kpi" key={k.label} style={{ ["--kt" as string]: W_COLOR[k.tone] }}>
                <b className="num">{k.value}</b>
                <span>{k.label}</span>
              </div>
            ))}
          </div>
        </header>
        {list.length === 0 && (
          <div className="panel biz__none">
            Nothing on this front stands out in the {report.window} — which is a finding: the
            figures above are the baseline to protect.
          </div>
        )}
        {list.map((i, k) => <Card key={k} i={i} />)}
      </section>
    );
  };

  const Card = ({ i }: { i: BizInsight }) => (
    <article className="panel biz__card" style={{ ["--sv" as string]: W_COLOR[i.weight] }}>
      <div className="biz__meta">
        <span className="biz__w">{W_LABEL[i.weight]}</span>
        {i.app && <span className="biz__app">{i.app}</span>}
      </div>
      <h3 className="biz__claim">{i.title}</h3>
      <p className="biz__fact">{i.fact}</p>
      <p className="biz__why"><b>Why it matters</b> {i.consequence}</p>
      {onGo && (
        <button className="biz__go"
          onClick={() => onGo(i.action.tab, i.action.appId, i.action.hl)}>
          {i.action.label} →
        </button>
      )}
    </article>
  );

  return (
    <div className="stack">
      <div className="panel">
        <div className="panel__hd">
          <span className="lbl">Business insights</span>
          <span className="hint">measured over the {report.window} · every figure real, none estimated</span>
          <div className="spacer" />
          <div className="seg" role="group" aria-label="Identity">
            <button className={anon ? "on" : ""} aria-pressed={anon} onClick={() => setAnon(true)}
              title="Application names replaced by aliases — safe to share">anonymized</button>
            <button className={!anon ? "on" : ""} aria-pressed={!anon} onClick={() => setAnon(false)}
              title="Real names — internal use">named</button>
          </div>
          <button className="rp__copy" onClick={copy}>
            {copied ? "copied ✓" : "copy as Markdown"}
          </button>
        </div>
        {anon && (
          <div className="pad">
            <p className="dd__note">
              Application identities are aliased ("Application A" is the busiest). Every number is
              real and reproducible from the queries behind this screen — only the names are hidden.
            </p>
          </div>
        )}
      </div>

      <Section front="brand" />
      <Section front="journeys" />
    </div>
  );
}
