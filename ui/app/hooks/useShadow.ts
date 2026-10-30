// Shadow mode: measure candidate queries beside the current ones.
//
// "What does not match cannot be substituted" (Marcelo, 2026-10-23). Before a
// figure moves to a cheaper source, the cheaper source runs alongside the
// current one and the difference is put on screen — number by number, with
// what each side read. Nothing here feeds a figure the page shows.
//
// Opt-in only (?compare=1) and started only once the page's own figures are
// final, so the candidates never compete with the page for Grail.
import { useEffect, useState } from "react";
import {
  alignedTf, alignedWindow, isExactLimit, qApps, qExperience, qGeo, qPulse, qPulseBreakdown, qPulseSeries,
  qShadowCensus, qShadowErrorMetrics,
  qShadowLean, qShadowLeanGrouped, qShadowSessionsEvents, qShadowSessionsMetric,
  qShadowTtfbEvents, qShadowTtfbMetric, qShadowViews, qUxByApp,
  runDql, type Timeframe,
} from "../utils/dql";
import { apdexOf } from "../utils/apdex";

export interface ShadowRow {
  group: string; measure: string;
  current: number | null; candidate: number | null;
  /** How the two were obtained, in a few words. */
  currentSrc: string; candidateSrc: string;
  /** A share in 0–1: compared in points, not in percent of percent. */
  isShare?: boolean;
}
export interface ShadowCost { label: string; gb: number; s: number }
export interface Shadow { rows: ShadowRow[]; cost: ShadowCost[]; done: boolean; error?: string }

/** What the page shows today — the numbers each candidate must match. */
export interface ShadowCurrent {
  sessions: number; realSessions: number; hitReal: number; score: number | null;
  actions: number;
  census: { errors: number; crashes: number; anrs: number; views: number;
    p50View: number; p90View: number; p95View: number } | null;
  geo: Array<{ cc: string; realHit: number }>;
}

/** Read ONCE, when the app loads: the app rewrites its query string as the
 *  reader moves, and a switch read later could already be gone. */
const SHADOW_AT_LOAD = (() => {
  try { return new URLSearchParams(window.location.search).get("compare") === "1"; }
  catch { return false; }
})();
export const shadowRequested = (): boolean => SHADOW_AT_LOAD;

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
/** Grail prints nanoseconds; Date.parse wants at most milliseconds. */
const parseTs = (s: string) => Date.parse(s.replace(/\.(\d{3})\d*Z$/, ".$1Z"));

export function useShadow(
  ready: boolean, tf: Timeframe, appId: string, frontendName: string | undefined,
  current: ShadowCurrent | null,
): Shadow | null {
  const [out, setOut] = useState<Shadow | null>(null);
  const on = shadowRequested();
  const key = on && ready && current ? `${tf.from}|${tf.to}|${appId}|${frontendName ?? ""}` : "";

  useEffect(() => {
    if (!key || !current) return;
    let live = true;
    const cost: ShadowCost[] = [];
    const meta = (label: string) => ({ onMeta: (m: { scannedBytes: number; elapsedMs: number }) => {
      cost.push({ label, gb: m.scannedBytes / 1e9, s: m.elapsedMs / 1000 });
    } });
    setOut({ rows: [], cost, done: false });
    (async () => {
      const rows: ShadowRow[] = [];
      try {
        /* 1. ONE FIXED WINDOW FOR BOTH SIDES. The page's own figures are read
           on a relative window (now()-1h) that slides while the candidates
           run seconds later — a comparison against them measures the slide
           (measured on staging: 21 vs 20 affected sessions, 203 vs 204 satisfied
           actions, all at the window's edge). So the REFERENCE — the very
           queries the page uses today — is re-run on a minute-aligned,
           absolute window, and every candidate reads that same window. */
        const at = alignedTf(Math.max(1, Math.round(tf.minutes)));
        /* OVER THE PLATFORM'S EXACT-COUNT LIMIT (1,000,000 values), an exact
           query here fails — and inside one Promise.all it took the whole
           panel down with it, including the comparisons that do work at that
           scale. Each exact count falls back to the precision-16 estimate on
           that one error, and the panel says which sides became estimates. */
        const estimated: string[] = [];
        const exactOr = async (label: string, build: (exact: boolean) => string, cap: number) => {
          try {
            return await runDql<Record<string, unknown>>(build(true), cap, undefined, undefined, meta(label));
          } catch (e) {
            if (!isExactLimit(e)) throw e;
            estimated.push(label);
            return runDql<Record<string, unknown>>(build(false), cap, undefined, undefined, meta(`${label} (estimate)`));
          }
        };
        const [refUx, refExp, refCensus, refGeo] = await Promise.all([
          runDql<Record<string, unknown>>(qUxByApp(at, appId), 8, undefined, undefined, meta("reference: per-session scan (today)")),
          runDql<Record<string, unknown>>(qExperience(at, appId), 1, undefined, undefined, meta("reference: experience score (today)")),
          exactOr("reference: census (today)", (x) => qApps(at, null, appId, x), 200),
          runDql<Record<string, unknown>>(qGeo(at, appId), 12, undefined, undefined, meta("reference: geo (today)")),
        ]);
        const [lean, census, grouped, views, errM] = await Promise.all([
          exactOr("candidate: lean affected + score", (x) => qShadowLean(at, appId, x), 1),
          exactOr("candidate: census sessions", (x) => qShadowCensus(at, appId, x), 1),
          exactOr("candidate: lean pass by country × user type", (x) => qShadowLeanGrouped(at, appId, x), 2000),
          runDql<Record<string, unknown>>(qShadowViews(at, appId), 1, undefined, undefined, meta("candidate: views from view_summary only")),
          frontendName
            ? runDql<Record<string, unknown>>(qShadowErrorMetrics(at, frontendName), 1, undefined, undefined, meta("candidate: error metrics"))
            : Promise.resolve([] as Record<string, unknown>[]),
        ]);
        const U = refUx.find((r) => r.sessions !== null && r.sessions !== undefined) ?? {};
        const X = refExp[0] ?? {};
        const A = refCensus.find((r) => String(r.appId ?? "") === appId) ?? refCensus[0] ?? {};
        const L = lean[0] ?? {}, C = census[0] ?? {};
        const ref = {
          sessions: num(U.sessions), realSessions: num(U.realSessions), hitReal: num(U.hitReal),
          actions: num(U.actions),
          score: apdexOf({ satisfied: Number(X.satisfied) || 0, tolerating: Number(X.tolerating) || 0,
            frustrated: Number(X.frustrated) || 0 }),
        };
        const cand = {
          sessions: num(C.sessions), realSessions: num(C.realSessions), hitReal: num(L.hitReal),
          score: apdexOf({ satisfied: Number(L.satisfied) || 0, tolerating: Number(L.tolerating) || 0,
            frustrated: Number(L.frustrated) || 0 }),
        };
        const cur = "per-session scan (today)";
        if (estimated.length) rows.push({ group: "platform limit", isShare: false,
          measure: `estimated, not exact: ${estimated.join(" · ")}`, current: null, candidate: null,
          currentSrc: "countDistinctExact refuses more than 1,000,000 values",
          candidateSrc: "countDistinct(precision: 16), ~0.4%" });
        const win = `${at.from.slice(12, 17)}–${at.to.slice(12, 17)} UTC`;
        rows.push(
          { group: `verdict · ${win}`, measure: "sessions", current: ref.sessions, candidate: cand.sessions,
            currentSrc: cur, candidateSrc: "census countDistinct" },
          { group: `verdict · ${win}`, measure: "real-user sessions", current: ref.realSessions, candidate: cand.realSessions,
            currentSrc: cur, candidateSrc: "census countDistinct" },
          { group: `verdict · ${win}`, measure: "real sessions affected", current: ref.hitReal, candidate: cand.hitReal,
            currentSrc: cur, candidateSrc: "lean pass (error + user_action)" },
          { group: `verdict · ${win}`, measure: "affected share", isShare: true,
            current: ref.realSessions && ref.hitReal !== null ? ref.hitReal / ref.realSessions : null,
            candidate: cand.realSessions && cand.hitReal !== null ? cand.hitReal / cand.realSessions : null,
            currentSrc: cur, candidateSrc: "lean ÷ census" },
          { group: `verdict · ${win}`, measure: "experience score", isShare: true, current: ref.score, candidate: cand.score,
            currentSrc: "experience query (today)", candidateSrc: "lean pass" },
        );
        /* THE REST OF WHAT THE OVERVIEW READS OFF THE PER-SESSION SCAN.
           Each field the switch would move to the lean pass is compared here
           first; a field that does not match stays on the scan. */
        const lean2 = `lean pass · ${win}`;
        const pair = (measure: string, cv: unknown, lv: unknown, src: string) =>
          rows.push({ group: lean2, measure, current: num(cv), candidate: num(lv),
            currentSrc: src, candidateSrc: "lean pass (error + user_action)" });
        pair("sessions affected (all users)", U.hit, L.hit, cur);
        pair("robot sessions affected", U.hitRobot, L.hitRobot, cur);
        pair("synthetic sessions affected", U.hitSynth, L.hitSynth, cur);
        pair("errors", U.errors, L.errors, cur);
        pair("errors in real-user sessions", U.realErrors, L.realErrors, cur);
        pair("third-party errors", U.errorsThird, L.errorsThird, cur);
        pair("user actions", U.actions, L.actions, cur);
        pair("rated actions (real users)", X.ratedActs, L.ratedActs, "experience query (today)");
        pair("rated actions with an error", X.errActions, L.errActions, "experience query (today)");
        pair("crashes / freezes in the score", X.scoreCrashes, L.scoreCrashes, "experience query (today)");
        const sum = (k: string) => grouped.reduce((a, r) => a + (Number(r[k]) || 0), 0);
        rows.push(
          { group: `grouped pass · ${win}`, measure: "real sessions affected (Σ groups)", current: ref.hitReal, candidate: sum("hitReal"),
            currentSrc: cur, candidateSrc: "Σ country × user type" },
          { group: `grouped pass · ${win}`, measure: "Σ groups vs ungrouped lean pass", current: cand.hitReal, candidate: sum("hitReal"),
            currentSrc: "lean pass, ungrouped", candidateSrc: "Σ country × user type" },
          { group: `grouped pass · ${win}`, measure: "experience score", isShare: true, current: ref.score,
            candidate: apdexOf({ satisfied: sum("satisfied"), tolerating: sum("tolerating"), frustrated: sum("frustrated") }),
            currentSrc: "experience query (today)", candidateSrc: "Σ country × user type" },
          { group: `grouped pass · ${win}`, measure: "crashes", current: num(A.crashes), candidate: sum("crashes"),
            currentSrc: "census (today)", candidateSrc: "lean pass (real users)" },
          { group: `grouped pass · ${win}`, measure: "ANRs", current: num(A.anrs), candidate: sum("anrs"),
            currentSrc: "census (today)", candidateSrc: "lean pass (real users)" },
        );
        const byCc = new Map<string, number>();
        for (const r of grouped) { const cc = String(r.cc ?? ""); if (cc) byCc.set(cc, (byCc.get(cc) ?? 0) + (Number(r.hitReal) || 0)); }
        for (const g of refGeo.slice(0, 8)) {
          rows.push({ group: `grouped pass · ${win}`, measure: `country ${String(g.country)}: real sessions affected`,
            current: num(g.realHit ?? g.hitSessions), candidate: byCc.get(String(g.country)) ?? 0,
            currentSrc: "geo scan (today)", candidateSrc: "lean pass by country" });
        }
        const V = views[0] ?? {};
        const ms = (v: unknown) => (num(v) === null ? null : Number(v) / 1e6);
        rows.push(
          { group: `census fields · ${win}`, measure: "views", current: num(A.views), candidate: num(V.views),
            currentSrc: "census (today, all events)", candidateSrc: "view_summary only" },
          { group: `census fields · ${win}`, measure: "view time p50 (ms)", current: ms(A.p50View), candidate: ms(V.p50View),
            currentSrc: "census (today)", candidateSrc: "view_summary only" },
          { group: `census fields · ${win}`, measure: "view time p90 (ms)", current: ms(A.p90View), candidate: ms(V.p90View),
            currentSrc: "census (today)", candidateSrc: "view_summary only" },
          { group: `census fields · ${win}`, measure: "view time p95 (ms)", current: ms(A.p95View), candidate: ms(V.p95View),
            currentSrc: "census (today)", candidateSrc: "view_summary only" },
        );
        const E = errM[0] ?? {};
        if (errM.length) rows.push(
          { group: `error metrics · ${win}`, measure: "errors", current: num(A.errors), candidate: num(E.errors),
            currentSrc: "census (today, events)", candidateSrc: "dt.frontend.error.count" },
          { group: `error metrics · ${win}`, measure: "crashes", current: num(A.crashes), candidate: num(E.crashes),
            currentSrc: "census (today, events)", candidateSrc: "error.count · crash" },
          { group: `error metrics · ${win}`, measure: "ANRs", current: num(A.anrs), candidate: num(E.anrs),
            currentSrc: "census (today, events)", candidateSrc: "error.count · anr" },
          { group: `error metrics · ${win}`, measure: "user actions", current: ref.actions, candidate: num(E.actions),
            currentSrc: cur, candidateSrc: "dt.frontend.user_action.count" },
        );
        /* 1b. ONE SCAN FOR THE PULSE (0.16.4). The merged qPulse beside the two
           queries it replaces, on the aligned window, with the live-lag cut
           reproduced as an absolute timestamp three minutes before the end. */
        {
          const toMs = Date.parse(at.to.replace(/"/g, ""));
          const cutIso = `"${new Date(toMs - 3 * 60000).toISOString()}"`;
          const atCut = { ...at, to: cutIso } as typeof at;
          const [refSeries, refBreak, merged] = await Promise.all([
            runDql<Record<string, unknown>>(qPulseSeries(atCut, appId), 1000, undefined, undefined, meta("reference: pulse series (today)")),
            runDql<Record<string, unknown>>(qPulseBreakdown(at, appId), 1, undefined, undefined, meta("reference: pulse totals (today)")),
            runDql<Record<string, unknown>>(qPulse(at, appId, cutIso), 1000, undefined, undefined, meta("candidate: one pulse scan")),
          ]);
          const drawn = merged.filter((r) => (Number(r.early) || 0) > 0);
          const S = (rs: Record<string, unknown>[], k: string) => rs.reduce((a, r) => a + (Number(r[k]) || 0), 0);
          const g = `one pulse scan · ${win}`;
          const pr = (measure: string, c: number, n: number, src: string) => rows.push({ group: g, measure,
            current: c, candidate: n, currentSrc: src, candidateSrc: "qPulse" });
          pr("bins drawn", refSeries.length, drawn.length, "qPulseSeries");
          pr("Σ sessions per bin", S(refSeries, "sessions"), S(drawn, "sessions"), "qPulseSeries");
          pr("Σ errors per bin", S(refSeries, "errors"), S(drawn, "errors"), "qPulseSeries");
          pr("Σ actions per bin", S(refSeries, "actions"), S(drawn, "actions"), "qPulseSeries");
          pr("Σ requests per bin", S(refSeries, "requests"), S(drawn, "requests"), "qPulseSeries");
          // bin by bin: the largest gap on any single bar
          const byT = new Map(drawn.map((r) => [String(r.t), r]));
          let worst = 0;
          for (const r of refSeries) {
            const m = byT.get(String(r.t));
            for (const k of ["sessions", "errors", "actions", "requests"]) {
              worst = Math.max(worst, Math.abs((Number(r[k]) || 0) - (Number(m?.[k]) || 0)));
            }
          }
          pr("largest difference on one bar", 0, worst, "every bin, every field");
          pr("requests (card total)", Number(refBreak[0]?.requests) || 0, S(merged, "reqAll"), "qPulseBreakdown");
          pr("failed calls (card total)", Number(refBreak[0]?.reqfail) || 0, S(merged, "failAll"), "qPulseBreakdown");
        }
        if (live) setOut({ rows: [...rows], cost: [...cost], done: false });

        /* 2. SESSIONS FROM THE METRIC STORE — same aligned window both sides */
        if (frontendName) {
          const w = alignedWindow(Math.max(1, Math.round(tf.minutes)));
          const [ev, mTotal, mType, mCountry, mBin] = await Promise.all([
            runDql<Record<string, unknown>>(qShadowSessionsEvents(w, appId), 200, undefined, undefined, meta("reference: events, aligned window")),
            runDql<Record<string, unknown>>(qShadowSessionsMetric(w, frontendName, "total"), 1, undefined, undefined, meta("candidate: metric total")),
            runDql<Record<string, unknown>>(qShadowSessionsMetric(w, frontendName, "user type"), 20, undefined, undefined, meta("candidate: metric by user type")),
            runDql<Record<string, unknown>>(qShadowSessionsMetric(w, frontendName, "country"), 300, undefined, undefined, meta("candidate: metric by country")),
            runDql<Record<string, unknown>>(qShadowSessionsMetric(w, frontendName, "bin"), 1, undefined, undefined, meta("candidate: metric per 2 min")),
          ]);
          const evOf = (k: string) => ev.filter((r) => r.k === k);
          /* first-byte per country (web applications record it) */
          const [tEv, tM] = await Promise.all([
            runDql<Record<string, unknown>>(qShadowTtfbEvents(w, appId), 30, undefined, undefined, meta("reference: TTFB p75 by country, events")),
            runDql<Record<string, unknown>>(qShadowTtfbMetric(w, frontendName), 300, undefined, undefined, meta("candidate: TTFB p75 by country, metric")),
          ]);
          for (const r of tEv.slice(0, 8)) {
            const m = tM.find((x) => String(x["geo.country.iso_code"]) === String(r.cc));
            rows.push({ group: "TTFB from metric", measure: `country ${r.cc}: first byte p75 (ms)`,
              current: num(r.ttfbMs), candidate: num(m?.ttfb), currentSrc: "events, aligned", candidateSrc: "dt.frontend.web.navigation.time_to_first_byte" });
          }
          const src = "events countDistinct, aligned";
          const msrc = "dt.frontend.session.active.estimated_count";
          rows.push({ group: "sessions from metric", measure: `total (${w.from.slice(11, 16)}–${w.to.slice(11, 16)} UTC)`,
            current: num(evOf("total")[0]?.sessions), candidate: num(mTotal[0]?.sessions), currentSrc: src, candidateSrc: msrc });
          for (const r of evOf("user type")) {
            const m = mType.find((x) => String(x["dt.rum.user_type"]) === String(r.b));
            rows.push({ group: "sessions from metric", measure: `user type: ${r.b ?? "—"}`,
              current: num(r.sessions), candidate: num(m?.sessions), currentSrc: src, candidateSrc: msrc });
          }
          for (const r of evOf("country")) {
            const m = mCountry.find((x) => String(x["geo.country.iso_code"]) === String(r.b));
            rows.push({ group: "sessions from metric", measure: `country: ${r.b ?? "—"}`,
              current: num(r.sessions), candidate: num(m?.sessions), currentSrc: src, candidateSrc: msrc });
          }
          /* per 2-minute bin: the middle bins (the edges straddle the window) */
          const mb = mBin[0] as { sessions?: number[]; timeframe?: { start?: string }; interval?: number } | undefined;
          const mStart = mb?.timeframe?.start ? parseTs(String(mb.timeframe.start)) : NaN;
          const iv = Number(mb?.interval ?? 0) / 1e6;
          const evBins = new Map(evOf("bin").map((r) => [parseTs(String(r.b)), Number(r.sessions) || 0]));
          const pairs: Array<[number, number]> = [];
          (mb?.sessions ?? []).forEach((v, i) => {
            const e = evBins.get(mStart + i * iv);
            if (e !== undefined && v !== null) pairs.push([e, Number(v)]);
          });
          const mid = pairs.slice(1, -1);
          if (mid.length) {
            rows.push({ group: "sessions from metric", measure: `per 2-min bin, ${mid.length} middle bins (sum)`,
              current: mid.reduce((a, p) => a + p[0], 0), candidate: mid.reduce((a, p) => a + p[1], 0),
              currentSrc: src, candidateSrc: msrc });
            const worst = mid.reduce((a, p) => Math.max(a, p[0] ? Math.abs(p[1] / p[0] - 1) : 0), 0);
            rows.push({ group: "sessions from metric", measure: "worst single bin", isShare: true,
              current: 0, candidate: worst, currentSrc: "|metric ÷ events − 1|", candidateSrc: "largest of the middle bins" });
          }
        }
        if (live) setOut({ rows, cost: [...cost], done: true });
      } catch (e) {
        if (live) setOut({ rows, cost: [...cost], done: true, error: String((e as Error)?.message ?? e) });
      }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return on ? out : null;
}
