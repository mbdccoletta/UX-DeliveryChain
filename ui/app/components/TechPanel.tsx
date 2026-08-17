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
// It renders on the DELIVERY CHAIN, which is the page about the whole
// application. Journeys had a copy with a per-view table; both are gone —
// the reader moved the technical reading into the infographic, where it
// answers the filtered question ("is THIS route slower than the rest?")
// instead of restating the application's average beside a diagram.
//
// Applications that carry no vitals at all are not hidden: measured on
// Astroshop Android there is no TTFB, no LCP, no foreground time — its
// technical story is view, action and app-start duration, so that is what
// the panel shows, with the absence stated rather than left blank.
import React from "react";
import type { TechRow } from "../hooks/useTechVitals";
import { fmtN } from "../utils/dql";
import { vitalBand as band, vitalTitle } from "../utils/vitals";
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

export function TechPanel({ rows, appName, isMobile }: {
  rows: TechRow[] | null;
  appName: string;
  isMobile?: boolean;
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

  const vitals: Array<[string, number]> = app ? ([
    ["LCP", app.lcpMs], ["FCP", app.fcpMs], ["TTFB", app.ttfbMs],
    ["INP", app.inpMs], ["CLS", app.cls],
  ] as Array<[string, number]>).filter(([, v]) => v > 0) : [];

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
              {/* the acronym explains itself on hover — name, what it
                  measures in words, and the standard's own scale */}
              {vitals.map(([k, v]) => (
                <div className="tech__v" key={k} title={vitalTitle(k)}
                  style={{ ["--vt" as string]: TONE[band(k, v)] }}>
                  <b className="num">{k === "CLS" ? v.toFixed(2) : ms(v)}</b>
                  <span>{k}</span>
                  <em>{band(k, v) === "good" ? "good" : band(k, v) === "warn" ? "needs work" : "poor"}</em>
                </div>
              ))}
              {app.longMs > 0 && (
                <div className="tech__v"
                  title={"Long tasks — main-thread blocks over 50ms\n\nWhile one runs the "
                    + "page cannot answer a tap: the browser is busy executing script.\n\n"
                    + "long_task.all.avg_duration at p75"}>
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
      </div>
    </div>
  );
}
