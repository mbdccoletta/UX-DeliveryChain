// The page chrome is the platform's, not ours.
//
// AppHeader is mandatory for every app on this platform, and its geometry is
// part of the standard: logo far left, tabs after it, help menu far right. That
// is what makes an app feel like it belongs rather than like a page that
// happens to be hosted here — so the header, the navigation and the title bar
// are Strato components, while everything they frame stays exactly as it was.
import React from "react";
import { AppHeader, HelpMenu, PageLayout, TitleBar } from "@dynatrace/strato-components/layouts";
import { Select } from "@dynatrace/strato-components/forms";
import { TimeframeSelector } from "@dynatrace/strato-components/filters";
import "./styles/theme.css";
import { useChainData } from "./hooks/useChainData";
import { fmtK, fmtN, tfFrom } from "./utils/dql";
import { FlowSankey } from "./components/FlowSankey";
import { DeliveryChain } from "./components/DeliveryChain";
import { Overview } from "./components/Overview";
import { Pulse } from "./components/Pulse";
import { JourneyMap } from "./components/JourneyMap";
import { ReportView } from "./components/ReportView";
import { intentsAvailable, open as openIntent, sessionsLink } from "./utils/links";
import { useUrlState } from "./hooks/useUrlState";
import { useUxOverview } from "./hooks/useUxOverview";
import { usePageTitle } from "./hooks/usePageTitle";
import { Boundary } from "./components/Boundary";

type Tab = "home" | "flow" | "chain" | "health" | "report";
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
  ["flow", "Journeys", "Where users go and how they get there — aggregated, or step by step"],
  ["health", "Health", "The environment as a whole, aggregated"],
  ["report", "Report", "What is worth telling someone who will not read a chart"],
];
/** Everything a link has to carry for someone else to see the same screen. */
/** The window the app opens on, in the selector's own grammar. */
const TF0 = { from: "-2h", to: "now" };
const URL_DEFAULTS = {
  tab: "home", from: TF0.from, to: TF0.to,
  app: null, sel: null, session: null,
  /** Journeys page altitude: the aggregated flow, or the ordered steps. */
  view: "flow",
} as const;

export function App() {
  const { state, set } = useUrlState<{
    tab: string; from: string; to: string; app: string | null; sel: string | null;
    /** Validation: pin every RUM query to one session. */
    session: string | null;
    view: string;
  }>({ ...URL_DEFAULTS });

  // old ?tab=journey links keep working: they land on the merged page,
  // already switched to the journey view
  const tab = (state.tab === "journey" ? "flow"
    : TABS.some(([id]) => id === state.tab) ? state.tab : "home") as Tab;
  const jview = state.tab === "journey" || state.view === "journey" ? "journey" : "flow";
  // Any window the platform selector can express — presets and custom ranges
  // alike — travels in the URL as the two expressions the queries will use.
  const tf = React.useMemo(
    () => tfFrom(state.from || TF0.from, state.to || TF0.to),
    [state.from, state.to],
  );
  const appId = state.app;

  // a new view or a different application is worth a history entry; changing
  // the window is an adjustment, and the guide calls that out by name
  const setTab = (t: Tab) => set({ tab: t, sel: null });
  const setAppId = (a: string | null) => set({ app: a, sel: null });
  const setTf = (from: string, to: string) => set({ from, to }, false);


  const d = useChainData(tf, state.session);
  // memoised per timeframe; the Journeys funnel reads fragment counts from it
  const uxMap = useUxOverview(tf);
  usePageTitle(TABS.find(([id]) => id === tab)?.[1]);

  const current = appId ?? d.apps[0]?.appId ?? "";
  // The header quotes the same per-session scan the pages quote, so the title
  // bar and the card below it can never state two different session counts.
  const totalSessions = uxMap
    ? d.apps.reduce((a, x) => a + (uxMap.get(x.appId)?.sessions ?? x.sessions), 0)
    : d.apps.reduce((a, x) => a + x.sessions, 0);
  const totalErrors = d.apps.reduce((a, x) => a + x.errors, 0);
  const activeProblems = d.problems.length;

  const view = TABS.find(([id]) => id === tab);

  return (
    <>
      <AppHeader>
        <AppHeader.Navigation>
          {/* the standard: clicking the logo lands on the first tab */}
          <AppHeader.Logo appName="DeliveryChain UX" onClick={() => setTab("home")} />
          {TABS.map(([id, label]) => (
            <AppHeader.NavigationItem key={id} isSelected={tab === id} onClick={() => setTab(id)}>
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
                </span>
              )}
              {!d.loading && d.apps.length > 0 && tab !== "report" && (
                <Select
                  value={tab === "flow" && jview === "flow" ? appId : current}
                  clearable={tab === "flow" && jview === "flow"}
                  onChange={(v) => setAppId((v as string | null) ?? null)}>
                  <Select.Trigger placeholder="All applications" />
                  <Select.Content>
                    {d.apps.map((a) => (
                      <Select.Option key={a.appId} value={a.appId} textValue={a.name}>
                        {a.name}
                      </Select.Option>
                    ))}
                  </Select.Content>
                </Select>
              )}
              {/* the platform's own selector: presets, custom range, stepper */}
              <TimeframeSelector
                value={{ from: state.from || TF0.from, to: state.to || TF0.to }}
                onChange={(v) => setTf(v?.from.value ?? TF0.from, v?.to.value ?? TF0.to)} />
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
                    openIntent(sessionsLink(tf, a.name,
                      uxMap?.get(current)?.sessions ?? a.sessions));
                  } else { setAppId(current); set({ tab: "flow", view: "journey", sel: null }); }
                }}
                onSeeEstate={() => setTab("health")} />
            </Boundary>
          )}

          {tab === "flow" && (
            <div className="stack">
              <div className="seg seg--views" role="group" aria-label="Journeys view">
                <button className={jview === "flow" ? "on" : ""}
                  aria-pressed={jview === "flow"}
                  onClick={() => set({ view: "flow", tab: "flow" })}>
                  Flow · where they go</button>
                <button className={jview === "journey" ? "on" : ""}
                  aria-pressed={jview === "journey"}
                  onClick={() => set({ view: "journey", tab: "flow" })}>
                  Journey · step by step</button>
              </div>
              {jview === "flow" ? (
                <Boundary label="Flow"><FlowSankey apps={d.apps} seqs={d.sequences} appId={appId}
                  transitions={d.transitions} friction={d.friction} views={d.views} ux={uxMap}
                  onPickApp={(id) => { setAppId(id); }}
                  onOpen={(t, id) => { setAppId(id);
                    if ((t as string) === "journey") set({ view: "journey", tab: "flow", sel: null });
                    else setTab("chain"); }} /></Boundary>
              ) : current ? (
                <Boundary label="Journey"><JourneyMap data={d} appId={current} /></Boundary>
              ) : null}
            </div>
          )}

          {tab === "chain" && current && (
            <Boundary label="Delivery chain">
              <DeliveryChain data={d} appId={current}
                sel={state.sel} onSel={(v) => set({ sel: v })} />
            </Boundary>
          )}
          {tab === "report" && <Boundary label="Report"><ReportView data={d} /></Boundary>}

          {tab === "health" && (
            <div className="stack">
              {/* the estate heatmap — the triage table for whoever owns 500 apps */}
              <Boundary label="Estate">
                <Overview data={d} onOpen={(id) => { setAppId(id); setTab("chain"); }} />
              </Boundary>
              <div className="panel">
                <div className="panel__hd"><span className="lbl">Environment health</span>
                  <span className="hint">aggregated · {tf.label}</span></div>
                <div className="pad">
                  <div className="dd">
                    <K l="Applications" v={String(d.apps.length)} c="var(--info)" />
                    <K l="Sessions" v={fmtN(totalSessions)} c="var(--info)" />
                    <K l="Errors" v={fmtK(totalErrors)} c={totalErrors ? "var(--bad)" : "var(--good)"} />
                    <K l="Active problems" v={String(activeProblems)} c={activeProblems ? "var(--bad)" : "var(--good)"} />
                    <K l="Services in Smartscape" v={fmtN(d.topology.find((t) => t.type === "SERVICE")?.nodes ?? 0)} c="var(--info)" />
                  </div>
                </div>
              </div>

              <div className="panel">
                <div className="panel__hd"><span className="lbl">Applications</span>
                  <span className="hint">sessions · views · errors</span></div>
                <div className="pad" style={{ overflowX: "auto" }}>
                  <table className="dt">
                    <thead><tr><th>Application</th><th>Sessions</th><th>Views</th><th>Errors</th><th>Errors/view</th></tr></thead>
                    <tbody>
                      {d.apps.map((a) => (
                        <tr key={a.appId}>
                          <td style={{ fontFamily: "var(--sans)" }}>{a.name}</td>
                          <td>{fmtN(uxMap?.get(a.appId)?.sessions ?? a.sessions)}</td>
                          <td>{fmtN(a.views)}</td>
                          <td style={{ color: a.errors > a.views ? "var(--bad)" : undefined }}>{fmtN(a.errors)}</td>
                          <td>{a.views ? (a.errors / a.views).toFixed(1) : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="panel">
                <div className="panel__hd"><span className="lbl">Problems detected by the AI</span>
                  <span className="hint">dt.davis.problems · active</span></div>
                <div className="pad" style={{ overflowX: "auto" }}>
                  <table className="dt">
                    <thead><tr><th>ID</th><th>Problem</th><th>Category</th><th>Entities</th></tr></thead>
                    <tbody>
                      {d.problems.map((p) => (
                        <tr key={p.display_id}>
                          <td className="hi">{p.display_id}</td>
                          <td style={{ fontFamily: "var(--sans)" }}>{p.name}</td>
                          <td>{p.category}</td>
                          <td>{(p.affected ?? []).join(", ") || "—"}</td>
                        </tr>
                      ))}
                      {!d.problems.length && <tr><td colSpan={4}>No active problems.</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="panel">
                <div className="panel__hd"><span className="lbl">Custom alerts &amp; extensions</span>
                  <span className="hint">event.provider · 24h</span></div>
                <div className="pad" style={{ overflowX: "auto" }}>
                  <table className="dt">
                    <thead><tr><th>Provider</th><th>Event type</th><th>Volume</th></tr></thead>
                    <tbody>
                      {d.providers.slice(0, 14).map((p) => (
                        <tr key={p.provider + p.type}>
                          <td className="hi">{p.provider}</td><td>{p.type}</td><td>{fmtN(p.events)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
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

function K({ l, v, c }: { l: string; v: string; c: string }) {
  return (
    <div className="dd__k" style={{ borderBottomColor: c }}>
      <div className="dd__kl">{l}</div><div className="dd__kv">{v}</div>
    </div>
  );
}
