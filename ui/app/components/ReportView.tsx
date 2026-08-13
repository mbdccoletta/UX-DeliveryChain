// Executive report: environment-wide findings with business framing.
// Anonymized by default so it can be shared outside without naming anyone;
// the toggle reveals real names for internal use only.
import React, { useEffect, useMemo, useState } from "react";
import type { ChainData } from "../hooks/useChainData";
import { buildReport, reportMarkdown } from "../utils/report";
import { forecast, type Forecast } from "../utils/forecast";
import { fmtK, fmtN } from "../utils/dql";
import type { Severity } from "../utils/insights";
import { useUxOverview } from "../hooks/useUxOverview";

const SEV_COLOR: Record<Severity, string> = {
  critical: "var(--bad)", warning: "var(--warn)", notable: "var(--info)", good: "var(--good)",
};
const SEV_LABEL: Record<Severity, string> = {
  critical: "critical", warning: "attention", notable: "context", good: "strength",
};
/** Identity hue per business area — categorical, never a judgment. */
const AREA_HUE: Record<string, string> = {
  "Digital experience": "--t-cyan",
  "Conversion": "--t-magenta",
  "Reliability": "--t-pink",
  "Observability coverage": "--t-violet",
  "Operations": "--t-azure",
  "Cloud & runtime": "--t-indigo",
  "Platform": "--t-teal",
};

export function ReportView({ data }: { data: ChainData }) {
  const [anon, setAnon] = useState(true);
  const [ahead, setAhead] = useState<Forecast | null>(null);
  const [asked, setAsked] = useState(false);
  const [copied, setCopied] = useState(false);
  const ux = useUxOverview(data.tf);
  const report = useMemo(() => buildReport(data, anon, ux), [data, anon, ux]);

  // The forecast is the one figure here that is not already on screen, so it is
  // fetched on its own rather than blocking the report. The busiest application
  // is the subject: a projection over the whole environment would average away
  // the very concentration the report is pointing at.
  const busiest = [...data.apps].sort((a, b) => b.errors - a.errors)[0];
  useEffect(() => {
    if (!busiest || asked) return;
    setAsked(true);
    forecast(
      `fetch user.events, from: now()-24h
       | filter dt.rum.application.id == "${busiest.appId.replace(/"/g, "")}"
       | makeTimeseries errors = countIf(characteristics.classifier == "error"), interval: 1h`,
      12,
    ).then(setAhead);
  }, [busiest, asked]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(reportMarkdown(report));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard may be unavailable; the button simply does nothing visible */
    }
  };

  return (
    <div className="stack">
      <div className="panel">
        <div className="panel__hd">
          <span className="lbl">Executive findings</span>
          <span className="hint">measured over the last {report.window} · nothing estimated</span>
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
        <div className="pad">
          <div className="dd">
            {report.kpis.map((k) => (
              <div className="dd__k" key={k.label} style={{ borderBottomColor: `var(--${k.tone})` }}>
                <div className="dd__kl">{k.label}</div>
                <div className="dd__kv">{k.value}</div>
              </div>
            ))}
          </div>
          {anon && (
            <p className="dd__note" style={{ marginTop: 14 }}>
              Application identities are aliased ("Application A" is the busiest). Every number is
              real and reproducible from the queries behind this screen — only the names are hidden.
            </p>
          )}
        </div>
      </div>

      {ahead && busiest && (
        <div className="panel rp__f" style={{ ["--sv" as string]: "var(--t-violet)" }}>
          <div className="pad">
            <div className="rp__meta">
              <span className="rp__sev" style={{ color: "var(--t-violet)" }}>forecast</span>
              <span className="rp__area" style={{ ["--hue" as string]: "var(--t-violet)" }}>
                Where this is heading
              </span>
            </div>
            <h2 className="rp__title">
              {ahead.slope < 0 ? "The error rate is easing, but the volume stays large"
                               : "The error rate is not improving on its own"}
            </h2>
            <p className="rp__body">
              Dynatrace&apos;s predictive analyzer projects the next{" "}
              {Math.round(ahead.horizon * (ahead.intervalMs / 3.6e6))} hours from the last 24.
              This is a projection of the current pattern, not a promise: it assumes nothing
              changes — no release, no incident, no fix.
            </p>
            <div className="rp__ev">
              {fmtK(Math.round(ahead.total))} further errors projected for{" "}
              {anon ? "Application A" : busiest.name} over the next{" "}
              {Math.round(ahead.horizon * (ahead.intervalMs / 3.6e6))}h
              {" "}(range {fmtK(Math.round(ahead.lower.reduce((a, b) => a + b, 0)))}–
              {fmtK(Math.round(ahead.upper.reduce((a, b) => a + b, 0)))}),
              {" "}trend {ahead.slope < 0 ? "down" : "up"} {fmtN(Math.abs(Math.round(ahead.slope)))}/h
              {" "}across the window.
            </div>
            <div className="rp__op">
              <b>Opportunity</b> The same analyzer runs on any metric in the platform, so this
              projection can become an alert before the threshold is crossed rather than after.
            </div>
          </div>
        </div>
      )}

      {report.findings.map((f, i) => (
        <div className="panel rp__f" key={i} style={{ ["--sv" as string]: SEV_COLOR[f.severity] }}>
          <div className="pad">
            <div className="rp__meta">
              <span className="rp__sev">{SEV_LABEL[f.severity]}</span>
              <span className="rp__area"
                style={{ ["--hue" as string]: `var(${AREA_HUE[f.area] ?? "--t-cyan"})` }}>
                {f.area}
              </span>
            </div>
            <h2 className="rp__title">{f.title}</h2>
            <p className="rp__body">{f.narrative}</p>
            <div className="rp__ev">{f.evidence}</div>
            <div className="rp__op"><b>Opportunity</b> {f.opportunity}</div>
          </div>
        </div>
      ))}

      {!report.findings.length && (
        <div className="panel"><div className="pad">
          <p className="dim" style={{ fontSize: 12, margin: 0 }}>
            No finding met its threshold in this window — widen the timeframe to give the rules
            more signal.
          </p>
        </div></div>
      )}
    </div>
  );
}
