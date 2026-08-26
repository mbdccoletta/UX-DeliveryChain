// The page chrome is the platform's, not ours.
//
// AppHeader is mandatory for every app on this platform, and its geometry is
// part of the standard: logo far left, tabs after it, help menu far right. That
// is what makes an app feel like it belongs rather than like a page that
// happens to be hosted here — so the header, the navigation and the title bar
// are Strato components, while everything they frame stays exactly as it was.
import React, { useEffect, useState } from "react";
import { AppHeader, HelpMenu, PageLayout, TitleBar } from "@dynatrace/strato-components/layouts";
import { Select } from "@dynatrace/strato-components/forms";
import { TimeframeSelector } from "@dynatrace/strato-components/filters";
import "./styles/theme.css";
import { useChainData } from "./hooks/useChainData";
import { fmtN, tfFrom, type Timeframe } from "./utils/dql";
import { FlowSankey } from "./components/FlowSankey";
import { DeliveryChain } from "./components/DeliveryChain";
import { Pulse } from "./components/Pulse";
import { ReportView } from "./components/ReportView";
import { intentsAvailable, open as openIntent, sessionsLink } from "./utils/links";
import { useUrlState } from "./hooks/useUrlState";
import { useUxOverview } from "./hooks/useUxOverview";
import { useFrontendNames } from "./hooks/useFrontendNames";
import { useJourneys } from "./hooks/useJourneys";
import { resetScan } from "./utils/cost";
import { usePageTitle } from "./hooks/usePageTitle";
import { Boundary } from "./components/Boundary";

type Tab = "home" | "flow" | "chain" | "report";
/**
 * Tab id, header label, and the sentence the title bar puts under it.
 *
 * Overview leads: the first screen answers "how are my applications and their
 * users doing" for the whole estate, and every card on it is a door into the
 * Delivery chain — the view the app is named after and the one no native app
 * reproduces: RUM stitched to Smartscape, browser through to host, with the
 * investigation routes hanging off every element.
 */
const TABS: Array<[Tab, string, string]> = [
  // no subtitle here: the card below says what the page is, and repeating it
  // in prose only pushed the numbers further down
  ["home", "Overview", ""],
  ["chain", "Delivery Chain", "Every layer a user request crosses — and what each one costs them"],
  // one page, two altitudes: Flow aggregates where users go; Journey replays
  // the steps one session class takes. A view toggle switches between them
  // without losing the application or the window.
  ["flow", "Journeys", "Where users go and how they get there"],
  ["report", "Business Control", "Two fronts, one board — numbers and trends, this window against the last"],
];
/** Everything a link has to carry for someone else to see the same screen. */
/** The window the app opens on, in the selector's own grammar. */
const TF0 = { from: "-2h", to: "now" };
const URL_DEFAULTS = {
  tab: "home", from: TF0.from, to: TF0.to,
  app: null, sel: null, session: null,
  /** Journeys page altitude: the aggregated flow, or the ordered steps. */
} as const;

export function App() {
  const { state, set } = useUrlState<{
    tab: string; from: string; to: string; app: string | null; sel: string | null;
    /** Validation: pin every RUM query to one session. */
    session: string | null;
    /** "anomalies" spotlights the chain's anomalous components on arrival. */
    hl: string | null;
    /** A cohort intent the Flow opens straight into an infographic:
     *  "unconverted" = the journeys that reached no goal. */
    coh: string | null;
    /** The value of one conversion + its currency — set on Business Control,
     *  read wherever money is derived (route economics included). In the URL
     *  so a shared link carries the same figures. */
    tkt: string | null;
    cur: string | null;
    /** Monitored-share (coverage %) — url state for the same reason as tkt:
     *  a shared link must carry the same figures. */
    cov: string | null;
    /** Routes picked on Journeys, handed to Business Control so its journey
     *  front recomputes for exactly them. Pick ids, tab-separated. */
    rt: string | null;
  }>({ ...URL_DEFAULTS, hl: null, coh: null, tkt: null, cur: null, cov: null, rt: null });

  // old ?tab=journey links keep working: they land on the merged page,
  // already switched to the journey view
  const tab = (state.tab === "journey" ? "flow"
    : TABS.some(([id]) => id === state.tab) ? state.tab : "home") as Tab;
  // The step-by-step JourneyMap and its toggle were removed by request; the
  // Flow (whose step mode now takes custom paths) is the Journeys page.
  // Any window the platform selector can express — presets and custom ranges
  // alike — travels in the URL as the two expressions the queries will use.
  /* THE 24-HOUR CEILING. Scan cost is linear in the window (measured:
   * ~16.9 GB for 2h of this estate — a 30-day pick would be ~6 TB), so the
   * window's LENGTH is capped at 24h: the END the reader chose is kept and
   * the start is pulled up to 24h before it. Recency is not constrained —
   * yesterday's 2h window is as valid as today's. The label says when the
   * cap acted, because a silently different window is the lie this app
   * refuses to tell. */
  const tf = React.useMemo(() => {
    const raw = tfFrom(state.from || TF0.from, state.to || TF0.to);
    if (raw.minutes <= 1440) return raw;
    if (/^now\(\)$/i.test(raw.to.trim())) {
      const capped = tfFrom("-24h", "now");
      return { ...capped, label: `${capped.label} — capped at 24h` };
    }
    const endIso = raw.to.replace(/"/g, "");
    const end = new Date(endIso);
    if (!Number.isFinite(end.getTime())) {
      const capped = tfFrom("-24h", "now");
      return { ...capped, label: `${capped.label} — capped at 24h` };
    }
    const start = new Date(end.getTime() - 24 * 3600e3);
    const capped = tfFrom(start.toISOString(), end.toISOString());
    return { ...capped, label: `${capped.label} — capped at 24h` };
  }, [state.from, state.to]);
  const appId = state.app;

  // a new view or a different application is worth a history entry; changing
  // the window is an adjustment, and the guide calls that out by name
  const setTab = (t: Tab) => set({ tab: t, sel: null });
  const setAppId = (a: string | null) => set({ app: a, sel: null });
  const setTf = (from: string, to: string) => set({ from, to }, false);


  /* What this window has read stays counted even though nothing prints it any
   * more: the readout is gone, the accounting is not. It is what a ceiling
   * reads before deciding a query is too wide to run. */
  useEffect(() => { resetScan(`${tf.from}|${tf.to}`); }, [tf.from, tf.to]);

  /** A journey handed back to the flow to be re-picked; saving replaces it. */
  /* Pressing "define a conversion journey" anywhere must START the process,
   * not deposit the reader on another page to hunt for a second button. This
   * token travels with the navigation and opens the flow already in
   * definition mode, waiting for the one click that is actually theirs. */

  const d = useChainData(tf, state.session);
  // memoised per timeframe; the Journeys funnel reads fragment counts from it
  const uxMap = useUxOverview(tf);
  /* Users & Sessions filters by frontend.name, not the inventory name —
   * see useFrontendNames for the measured mismatch. */
  const feNames = useFrontendNames();
  /* journeys data only where journeys are read (Journeys + Business
   * Control) — four user.events scans Overview and the chain stopped paying */
  /* warmed the moment the pointer TOUCHES the Journeys/Business Control
   * tab — by the click, the four scans are usually already in flight */
  const [warmJourneys, setWarmJourneys] = useState(false);
  const jd = useJourneys(tf,
    warmJourneys || tab === "flow" || tab === "report", state.session);
  // the customer's own conversion definitions — taught on Journeys, read by
  // every screen that speaks of conversion
  usePageTitle(TABS.find(([id]) => id === tab)?.[1]);

  /* An appId the loaded window does not know (a quiet app whose RUM id
   * vanished from qApps, a stale share link) used to render a GHOST chain:
   * empty selector, "No coverage" columns, a nameless Render card — the
   * reader's screenshot. Unknown falls back exactly like null does: to the
   * busiest application. While loading, the url's choice stands so the
   * selection does not flicker away and back. */
  const current = d.loading
    ? (appId ?? "")
    : appId && d.apps.some((a) => a.appId === appId)
      ? appId
      : d.apps[0]?.appId ?? "";
  // the engineer's reading of the same anatomy Business Control speaks in
  // business words — shown on the two technical pages, one scan shared
  // the flow page reads its technical vitals from the INFOGRAPHIC now, where
  // they answer the filtered question; only the chain needs this scan

  // The header quotes the same per-session scan the pages quote, so the title
  // bar and the card below it can never state two different session counts.
  const totalSessions = uxMap
    ? d.apps.reduce((a, x) => a + (uxMap.get(x.appId)?.sessions ?? x.sessions), 0)
    : d.apps.reduce((a, x) => a + x.sessions, 0);
  const activeProblems = d.problems.length;
  /* ENVIRONMENT-scoped active signals — custom alerts and OpenPipeline
   * extractions bound to the tenant itself. No card carries that id, so the
   * audit found them shown by the platform's own apps and invisible here;
   * the estate line is the one place scoped exactly like they are. */
  const envAlerts = [...new Set(d.signals
    .filter((s) => s.entityId.startsWith("ENVIRONMENT"))
    .map((s) => s.name))];
  // The classic model and RUM both key a mobile app's entity as
  // MOBILE_APPLICATION-…, whichever of the two named it — verified against
  // every mobile app currently listed. A web app's entity never starts this
  // way, so absence defaults an app into "Web" rather than hiding it.
  const mobileApps = d.apps.filter((a) => a.entity?.startsWith("MOBILE_APPLICATION-"));
  const webApps = d.apps.filter((a) => !a.entity?.startsWith("MOBILE_APPLICATION-"));

  const view = TABS.find(([id]) => id === tab);

  return (
    <>
      <AppHeader>
        <AppHeader.Navigation>
          {/* the standard: clicking the logo lands on the first tab */}
          {/* WHY A REGISTRY URL, NOT A DATA URI: AppIcon fetch()es its src
              and the CSP's connect-src has no data: — the data-URI attempt
              failed silently into the "?" fallback. The dev server serves
              app.config's icon.png at this same registry path for OUR app
              id (measured: 200 image/png; the component's default asks for
              "local-dev-mode" and 404s), and after a deploy the platform
              registry answers the identical URL. One src, both worlds. */}
          <AppHeader.Logo appName="UX Delivery Chain"
            appIcon="/platform/app-engine/registry/v1/app-icons/my.deliverychain.ux"
            onClick={() => setTab("home")} />
          {TABS.map(([id, label]) => (
            <AppHeader.NavigationItem key={id} isSelected={tab === id} onClick={() => setTab(id)}
              onMouseEnter={(id === "flow" || id === "report")
                ? () => setWarmJourneys(true) : undefined}>
              {label}
            </AppHeader.NavigationItem>
          ))}
        </AppHeader.Navigation>
        <AppHeader.ActionItems>
          {/* app-wide action: how old the numbers are, and how to refresh them */}
          <AppHeader.ActionButton
            onClick={d.refresh}
            aria-label={d.cachedAt
              ? "These numbers came from the cache. Re-query Grail."
              : "Measured just now. Re-query Grail."}>
            {d.loading ? "loading…"
              : d.cachedAt ? `cached ${Math.round((Date.now() - d.cachedAt) / 1000)}s ago` : "live"}
          </AppHeader.ActionButton>
        </AppHeader.ActionItems>
        <AppHeader.Menus>
          {/* the menu has fixed, named slots — the platform decides the wording
              and the order, which is the point of a standard help menu */}
          <HelpMenu entries={{
            documentation: {
              href: "https://docs.dynatrace.com/docs/discover-dynatrace/references/dynatrace-query-language",
              target: "_blank",
            },
            feedback: { href: "https://community.dynatrace.com", target: "_blank" },
          }} />
        </AppHeader.Menus>
      </AppHeader>

      <PageLayout>
      <PageLayout.Header>
        <TitleBar>
          <TitleBar.Title>{view?.[1] ?? "Delivery Chain"}</TitleBar.Title>
          {(d.loading || view?.[2]) && (
            <TitleBar.Subtitle>
              {d.loading ? "querying Grail and Smartscape…" : view?.[2]}
            </TitleBar.Subtitle>
          )}
          <TitleBar.Suffix>
            <div className="ctl">
              {!d.loading && (
                <span className="lbl">
                  {d.apps.length} applications · {fmtN(totalSessions)} sessions ·{" "}
                  {activeProblems} active problems
                  {envAlerts.length > 0 && (
                    <span title={`Active alerts scoped to the ENVIRONMENT itself — no single component owns them: ${envAlerts.slice(0, 8).join(" · ")}`}>
                      {" "}· {envAlerts.length} environment alert{envAlerts.length > 1 ? "s" : ""}
                    </span>
                  )}
                </span>
              )}
              {!d.loading && d.apps.length > 0 && (
                <Select
                  value={current}
                  onChange={(v) => { if (v) setAppId(v as string); }}>
                  <Select.Trigger placeholder="Application" />
                  <Select.Content>
                    {/* Web and mobile read differently in the rest of this app —
                        mobile carries no ingress, no third-party requests, and
                        (where RUM never reported) no measured sessions at all —
                        so the picker separates them instead of interleaving by
                        session count. `entity` is the reliable signal: RUM and
                        the classic-model fallback both key a mobile app's
                        entity as MOBILE_APPLICATION-…, web apps never do. */}
                    {webApps.length > 0 && (
                      <Select.Group>
                        <Select.GroupLabel>Web</Select.GroupLabel>
                        {webApps.map((a) => (
                          <Select.Option key={a.appId} value={a.appId} textValue={a.name}>
                            {a.name}
                          </Select.Option>
                        ))}
                      </Select.Group>
                    )}
                    {mobileApps.length > 0 && (
                      <Select.Group>
                        <Select.GroupLabel>Mobile</Select.GroupLabel>
                        {mobileApps.map((a) => (
                          <Select.Option key={a.appId} value={a.appId} textValue={a.name}>
                            {a.name}
                          </Select.Option>
                        ))}
                      </Select.Group>
                    )}
                  </Select.Content>
                </Select>
              )}
              {/* the platform's own selector: presets, custom range, stepper */}
              <TimeframeSelector
                value={{ from: state.from || TF0.from, to: state.to || TF0.to }}
                onChange={(v) => setTf(v?.from.value ?? TF0.from, v?.to.value ?? TF0.to)}>
                {/* only windows the 24h ceiling allows — the platform's
                    default list offers 7/30/90 days, which the cap above
                    would silently shrink; better not to offer them */}
                <TimeframeSelector.Presets>
                  <TimeframeSelector.PresetItem value={{ from: "-30m", to: "now" }}>Last 30 minutes</TimeframeSelector.PresetItem>
                  <TimeframeSelector.PresetItem value={{ from: "-1h", to: "now" }}>Last 1 hour</TimeframeSelector.PresetItem>
                  <TimeframeSelector.PresetItem value={{ from: "-2h", to: "now" }}>Last 2 hours</TimeframeSelector.PresetItem>
                  <TimeframeSelector.PresetItem value={{ from: "-6h", to: "now" }}>Last 6 hours</TimeframeSelector.PresetItem>
                  <TimeframeSelector.PresetItem value={{ from: "-12h", to: "now" }}>Last 12 hours</TimeframeSelector.PresetItem>
                  <TimeframeSelector.PresetItem value={{ from: "-24h", to: "now" }}>Last 24 hours</TimeframeSelector.PresetItem>
                </TimeframeSelector.Presets>
              </TimeframeSelector>
            </div>
          </TitleBar.Suffix>
        </TitleBar>
      </PageLayout.Header>
      <PageLayout.Content>
      <div className="wrap">

      {state.session && (
        <div className="banner banner--info">
          <b>One session only:</b> <span className="num">{state.session}</span> — every figure on
          this screen describes that single session, so the mined path can be read against the raw
          events. <button className="flow-sel__b" onClick={() => set({ session: null })}>
            show everything
          </button>
        </div>
      )}

      {d.errors.length > 0 && (
        <div className="banner">
          <b>Failed queries ({d.errors.length}):</b> {d.errors.slice(0, 3).join(" · ")}
          {d.errors.length > 3 && " …"} — check the app scopes in <span className="num">app.config.json</span>.
        </div>
      )}

      {d.loading ? (
        <div className="loading"><i />querying Grail and Smartscape…</div>
      ) : (
        <>
          {tab === "home" && current && (
            <Boundary label="Overview">
              <Pulse data={d} appId={current}
                onOpenChain={() => { setAppId(current); setTab("chain"); }}
                onAnalyze={() => {
                  // the dedicated Gen3 sessions app, filtered to THIS
                  // application; standalone (no intent bus) falls back to the
                  // in-app Journey view
                  const a = d.apps.find((x) => x.appId === current);
                  if (intentsAvailable() && a) {
                    openIntent(sessionsLink(tf, feNames?.get(a.entity ?? "") ?? a.name,
                      uxMap?.get(current)?.sessions ?? a.sessions));
                  } else { setAppId(current); set({ tab: "flow", sel: null }); }
                }} />
            </Boundary>
          )}

          {tab === "flow" && !jd && (
            <div className="loading"><i />mining the journeys…</div>
          )}
          {tab === "flow" && jd && (
            <div className="stack">
              <Boundary label="Flow"><FlowSankey apps={d.apps} seqs={jd.sequences} appId={current || null}
                transitions={jd.transitions} friction={jd.friction} views={jd.views} ux={uxMap}
                tf={tf}
                cohort={state.coh === "unconverted" ? "unconverted" : null}
                onCohortConsumed={() => set({ coh: null }, false)}
                onBizScope={(picks) => set({ tab: "report", rt: picks.join("\t") })}
                onPickApp={(id) => { setAppId(id); }}
                onOpen={(_t, id) => { setAppId(id); setTab("chain"); }} /></Boundary>
            </div>
          )}

          {tab === "chain" && current && (
            <Boundary label="Delivery chain">
              <DeliveryChain data={d} appId={current}
                sel={state.sel} onSel={(v) => set({ sel: v })}
                highlight={state.hl === "anomalies" ? "anomalies" : null}
                onHighlightClear={() => set({ hl: null }, false)} />
            </Boundary>
          )}
          {tab === "report" && !jd && (
            <div className="loading"><i />mining the journeys…</div>
          )}
          {/* MOUNTED even while journeys mine — hidden. Gating the mount on
              jd serialised the board: 2.9s of journeys THEN 3.3s of its own
              KPI scans (measured, 6.2s total). Mounted hidden, both waves
              run in parallel and the board appears in the slower one. */}
          {tab === "report" && (
            <div style={jd ? undefined : { display: "none" }}>
            <Boundary label="Report">
              <ReportView data={{ ...d, views: jd?.views ?? [], sequences: jd?.sequences ?? [],
                  transitions: jd?.transitions ?? [], friction: jd?.friction ?? [] }} scopeApp={current}
                onRoutePicks={(picks) => set({ rt: picks.length ? picks.join("\t") : null }, false)}
                routePicks={state.rt ? state.rt.split("\t").filter(Boolean) : null}
                onClearRoutes={() => set({ rt: null }, false)}
                cov={state.cov ?? ""} onCov={(v) => set({ cov: v || null }, false)}
                onGo={(t, id, hl) => set({ tab: t, app: id ?? state.app, sel: null,
                  hl: t === "chain" ? (hl ?? null) : null,
                  coh: t === "flow" ? (hl ?? null) : null })} />
            </Boundary>
            </div>
          )}
        </>
      )}
      </div>
      </PageLayout.Content>
      </PageLayout>
    </>
  );
}

