// WHERE THE TIME GOES — the engineer's reading.
//
// Business Control says the same anatomy in the owner's words ("your systems
// answer in 3ms — the rest happens on the customer's side"). This is the
// version for whoever has to fix it: the TTFB anatomy the agent actually
// records (dns · connect · request · server wait), the render tail after the
// first byte, the Core Web Vitals at p75 — the standard's own percentile —
// judged against the standard's own thresholds, and the errors by their
// platform names, never business phrasing.
//
// It renders on the two technical pages. The Delivery Chain gets the
// application's totals; Journeys adds the per-view table, because a journey
// is made of views and "which screen" is the engineer's next question.
//
// Applications that carry no vitals at all are not hidden: measured on
// Astroshop Android there is no TTFB, no LCP, no foreground time — its
// technical story is view, action and app-start duration, so that is what
// the panel shows, with the absence stated rather than left blank.
import React from "react";
import type { TechRow } from "../hooks/useTechVitals";
import { fmtN } from "../utils/dql";

/** The Core Web Vitals thresholds, as the standard defines them (ms; CLS unitless). */
const CWV: Record<string, [number, number]> = {
  LCP: [2500, 4000], FCP: [1800, 3000], INP: [200, 500], TTFB: [800, 1800], CLS: [0.1, 0.25],
};
const band = (k: string, v: number): "good" | "warn" | "bad" => {
  const t = CWV[k];
  if (!t) return "good";
  return v <= t[0] ? "good" : v <= t[1] ? "warn" : "bad";
};
const TONE: Record<string, string> = {
  good: "var(--good)", warn: "var(--warn)", bad: "var(--bad)",
};
const ms = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v)}ms`);

/** Error buckets in the platform's own vocabulary. */
const ERRS: Array<[string, string, string]> = [
  ["http5xx", "HTTP 5xx", "server errors — the backend answered with a failure"],
  ["exception", "JS exceptions", "uncaught errors in the frontend bundle"],
  ["csp", "CSP violations", "content-security-policy blocked a resource"],
  ["crash", "crashes", "the process died"],
  ["anr", "ANRs", "the main thread blocked until the OS killed the app"],
  ["noresponse", "no response", "request errors with status 0 — nothing came back"],
  ["http4xx", "HTTP 4xx", "missing content or authorization"],
  ["other", "other", "errors the platform did not classify further"],
];

export function TechPanel({ rows, appName, isMobile, withViews }: {
  rows: TechRow[] | null;
  appName: string;
  isMobile?: boolean;
  /** Journeys shows the per-view table; the chain shows totals only. */
  withViews?: boolean;
}) {
  if (rows === null) {
    return (
      <div className="panel tech">
        <div className="panel__hd"><span className="lbl">Where the time goes</span>
          <span className="hint">technical · reading the agent&apos;s own timings…</span></div>
      </div>
    );
  }
  const app = rows.find((r) => r.kind === "app");
  const views = rows.filter((r) => r.kind === "view");
  const durs = rows.filter((r) => r.kind === "dur");
  const errs = rows.filter((r) => r.kind === "err" && r.n > 0);
  if (!app && !errs.length) return null;

  // the phases the agent measures, in the order a request lives them
  const phases: Array<[string, number, string, string]> = app ? [
    ["dns", app.dnsMs, "var(--t-cyan)", "ttfb.dns_duration"],
    ["connect", app.connMs, "var(--t-azure)", "ttfb.connection_duration"],
    ["request", app.reqMs, "var(--t-violet)", "ttfb.request_duration — the response on the wire"],
    ["server wait", app.waitMs, "var(--bad)", "ttfb.waiting_duration — the server thinking"],
    ["render", Math.max(0, app.lcpMs - app.ttfbMs), "var(--warn)",
      "largest-contentful-paint minus first byte — download and paint on the device"],
  ] : [];
  const total = phases.reduce((a, [, v]) => a + v, 0);
  const hasVitals = !!app && app.meas > 0;

  const vitals: Array<[string, number, string]> = app ? [
    ["LCP", app.lcpMs, "largest contentful paint"],
    ["FCP", app.fcpMs, "first contentful paint"],
    ["TTFB", app.ttfbMs, "time to first byte"],
    ["INP", app.inpMs, "interaction to next paint"],
    ["CLS", app.cls, "cumulative layout shift"],
  ].filter((v) => (v[1] as number) > 0) as Array<[string, number, string]> : [];

  return (
    <div className="panel tech">
      <div className="panel__hd">
        <span className="lbl">Where the time goes</span>
        <span className="hint">
          technical · p75, the Web Vitals standard&apos;s own percentile · {appName}
        </span>
      </div>
      <div className="pad tech__body">
        {hasVitals ? (
          <>
            {/* the phase bar: what the agent timed, in request order */}
            <div className="tech__bar" role="img"
              aria-label={phases.map(([k, v]) => `${k} ${ms(v)}`).join(", ")}>
              {phases.map(([k, v, c]) => v > 0 && (
                <i key={k} style={{ width: `${(v / Math.max(total, 0.001)) * 100}%`, background: c }}
                  title={`${k} · ${ms(v)}`} />
              ))}
            </div>
            <div className="tech__leg">
              {phases.map(([k, v, c, why]) => (
                <span key={k} title={why}>
                  <i style={{ background: c }} />{k} · <b>{ms(v)}</b>
                </span>
              ))}
              <span className="tech__cov" title="Views carrying a first-byte breakdown — SPA soft routes and mobile screens carry none">
                {app ? `${Math.round((app.meas / Math.max(1, app.n)) * 100)}% of ${fmtN(app.n)} views measured` : ""}
              </span>
            </div>
            {/* the vitals, judged by the standard's thresholds */}
            <div className="tech__vitals">
              {vitals.map(([k, v, why]) => (
                <div className="tech__v" key={k} title={`${why} · p75`}
                  style={{ ["--vt" as string]: TONE[band(k, v)] }}>
                  <b className="num">{k === "CLS" ? v.toFixed(2) : ms(v)}</b>
                  <span>{k}</span>
                  <em>{band(k, v) === "good" ? "good" : band(k, v) === "warn" ? "needs work" : "poor"}</em>
                </div>
              ))}
              {app.longMs > 0 && (
                <div className="tech__v" title="long_task.all.avg_duration p75 — main-thread blocks">
                  <b className="num">{ms(app.longMs)}</b><span>long tasks</span><em>main thread</em>
                </div>
              )}
            </div>
          </>
        ) : (
          /* no vitals at all — say so, and show what this agent DOES record */
          <div className="tech__novitals">
            <span className="tech__nv-l">
              {isMobile ? "mobile agent — no first-byte or paint timings" : "no first-byte breakdown on these views"}
            </span>
            <div className="tech__vitals">
              {app && app.durMs > 0 && (
                <div className="tech__v" title="view_summary duration p75">
                  <b className="num">{ms(app.durMs)}</b><span>view</span><em>p75 duration</em>
                </div>
              )}
              {durs.map((d) => (
                <div className="tech__v" key={d.bucket}
                  title={`${d.bucket} duration p75 over ${fmtN(d.n)} events`}>
                  <b className="num">{ms(d.durMs)}</b>
                  <span>{d.bucket.replace("_", " ")}</span>
                  <em>p75 · {fmtN(d.n)}</em>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* errors by their platform names */}
        {errs.length > 0 && (
          <div className="tech__errs">
            {ERRS.map(([k, label, why]) => {
              const row = errs.find((e) => e.bucket === k);
              if (!row) return null;
              return (
                <span className="tech__e" key={k} title={why}>
                  <b className="num">{fmtN(row.n)}</b> {label}
                  <em>{fmtN(row.sessions)} sessions</em>
                </span>
              );
            })}
          </div>
        )}

        {/* per view — the engineer's next question is always "which screen" */}
        {withViews && views.length > 0 && hasVitals && (
          <div className="tech__views">
            <div className="tech__vh">
              <span>view</span><span>views</span><span>TTFB p75</span>
              <span>render p75</span><span>LCP p75</span>
            </div>
            {views.map((v) => {
              const render = Math.max(0, v.lcpMs - v.ttfbMs);
              return (
                <div className="tech__vr" key={v.bucket}>
                  <span className="tech__vn">{v.bucket}</span>
                  <span className="num">{fmtN(v.n)}</span>
                  <span className="num" style={{ color: TONE[band("TTFB", v.ttfbMs)] }}>{ms(v.ttfbMs)}</span>
                  <span className="num">{ms(render)}</span>
                  <span className="num" style={{ color: TONE[band("LCP", v.lcpMs)] }}>{ms(v.lcpMs)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
