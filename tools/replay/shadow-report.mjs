#!/usr/bin/env node
// Recompute the shadow comparisons (?compare=1) from a scenario: every
// candidate beside the figure the page showed, per window the capture holds.
//   node tools/replay/shadow-report.mjs <scenario-name>
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const sc = JSON.parse(readFileSync(join(here, "scenarios", `${process.argv[2]}.json`), "utf8"));
const S = sc.statements.filter((s) => s.final);
const win = (q) => (q.match(/from: ?"?([^,"]+)"?, to: ?"?([^,"|\n]+)"?/) ?? []).slice(1).map((x) => x.trim()).join(" → ");
const pick = (re, w) => S.filter((s) => re.test(s.query) && (!w || win(s.query) === w));
const first = (re, w) => pick(re, w)[0]?.final.records ?? null;
const n = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
const apdex = (s, t, f) => (s + t + f ? (s + t / 2) / (s + t + f) : null);
const rows = [];
const add = (w, group, measure, cur, cand, share = false) => rows.push({ w, group, measure, cur, cand, share });

const lean = pick(/fieldsAdd _crash = _real/);
for (const L of lean.filter((s) => !/by: \{ cc =/.test(s.query))) {
  const w = win(L.query);
  // since 0.16.0 the page itself runs the lean pass on its live window;
  // only the shadow's aligned (absolute) windows are comparisons
  if (!/^\d{4}-/.test(w)) continue;
  const l = L.final.records[0] ?? {};
  const ux = first(/errsThird = countIf/, w)?.find((r) => r.sessions !== null) ?? null;
  const exp = first(/ratedActs = count/, w)?.[0] ?? null;
  // the shadow census: user.events, exactly two distinct counts (not the session store)
  const cen = first(/^fetch user\.events[^|]*\| filter dt\.rum\.application\.id == "<APP>" \| summarize sessions = countDistinct(?:Exact)?\(dt\.rum\.session\.id(?:, precision: 16)?\), realSessions = countDistinct/, w)?.[0] ?? null;
  const grp = pick(/fieldsAdd _crash = _real[\s\S]*by: \{ cc =/, w)[0]?.final.records ?? [];
  const views = first(/filter characteristics\.classifier == "view_summary"\s*\| summarize views = count\(\)/, w)?.[0] ?? null;
  const census = first(/summarize sessions = countDistinct\(dt\.rum\.session\.id\), views = countIf/, w)?.[0] ?? null;
  const errM = first(/crashes = sum\(dt\.frontend\.error\.count, filter/, w)?.[0] ?? null;
  const geo = first(/by: \{ country = geo\.country\.iso_code \}/, w) ?? [];
  const sum = (k) => grp.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const curScore = exp ? apdex(+exp.satisfied, +exp.tolerating, +exp.frustrated) : null;
  if (ux) {
    add(w, "verdict", "sessions", n(ux.sessions), n(cen?.sessions));
    add(w, "verdict", "real-user sessions", n(ux.realSessions), n(cen?.realSessions));
    add(w, "verdict", "real sessions affected", n(ux.hitReal), n(l.hitReal));
    add(w, "verdict", "affected share", ux.realSessions ? ux.hitReal / ux.realSessions : null,
      cen?.realSessions ? l.hitReal / cen.realSessions : null, true);
    add(w, "grouped pass", "affected, Σ groups vs exact", n(ux.hitReal), sum("hitReal"));
    add(w, "grouped pass", "affected, Σ groups vs ungrouped", n(l.hitReal), sum("hitReal"));
    // 0.15.24: the rest of what the Overview reads off the per-session scan
    if ("hitRobot" in l) {
      add(w, "lean pass", "sessions affected (all users)", n(ux.hit), n(l.hit));
      add(w, "lean pass", "robot sessions affected", n(ux.hitRobot), n(l.hitRobot));
      add(w, "lean pass", "synthetic sessions affected", n(ux.hitSynth), n(l.hitSynth));
      add(w, "lean pass", "errors", n(ux.errors), n(l.errors));
      add(w, "lean pass", "errors in real-user sessions", n(ux.realErrors), n(l.realErrors));
      add(w, "lean pass", "third-party errors", n(ux.errorsThird), n(l.errorsThird));
      add(w, "lean pass", "user actions", n(ux.actions), n(l.actions));
    }
  }
  if (exp && "ratedActs" in l) {
    add(w, "lean pass", "rated actions (real users)", n(exp.ratedActs), n(l.ratedActs));
    add(w, "lean pass", "rated actions with an error", n(exp.errActions), n(l.errActions));
    add(w, "lean pass", "crashes / freezes in the score", n(exp.scoreCrashes), n(l.scoreCrashes));
  }
  add(w, "verdict", "experience score", curScore, apdex(+l.satisfied || 0, +l.tolerating || 0, +l.frustrated || 0), true);
  add(w, "grouped pass", "experience score", curScore, apdex(sum("satisfied"), sum("tolerating"), sum("frustrated")), true);
  if (census) {
    add(w, "grouped pass", "crashes", n(census.crashes), sum("crashes"));
    add(w, "grouped pass", "ANRs", n(census.anrs), sum("anrs"));
    add(w, "census fields", "views", n(census.views), n(views?.views));
    for (const p of ["p50View", "p90View", "p95View"]) add(w, "census fields", p, n(census[p]), n(views?.[p]));
    if (errM) {
      add(w, "error metrics", "errors", n(census.errors), n(errM.errors));
      add(w, "error metrics", "crashes", n(census.crashes), n(errM.crashes));
      add(w, "error metrics", "ANRs", n(census.anrs), n(errM.anrs));
      if (ux) add(w, "error metrics", "user actions", n(ux.actions), n(errM.actions));
    }
  }
  const byCc = new Map();
  for (const r of grp) if (r.cc) byCc.set(r.cc, (byCc.get(r.cc) ?? 0) + (Number(r.hitReal) || 0));
  for (const g of geo.slice(0, 6)) add(w, "grouped pass", `country ${g.country}: affected`, n(g.realHit ?? g.hitSessions), byCc.get(g.country) ?? 0);
}
// web action error kinds (0.16.3): what each arm of WEB_ACT_ERR contributes
for (const L of lean) {
  const l = L.final.records[0] ?? {};
  if (!("webActExc" in l)) continue;
  console.log(`action error kinds · ${win(L.query)} · actions ${l.actions} · with error (judged) ${l.errActions}`
    + ` · exception ${l.webActExc} · 4xx ${l.webAct4xx} · 5xx ${l.webAct5xx} · status-0/other ${l.webActOther} · CSP ${l.webActCsp}`);
}
// one pulse scan (0.16.4): qPulse beside qPulseSeries + qPulseBreakdown
for (const M of pick(/summarize early = countIf\(_in\)/)) {
  const from = (M.query.match(/from: ?"([^"]+)"/) ?? [])[1];
  if (!from) continue; // the page's own live run, not a comparison
  const w = win(M.query);
  const same = (q) => (q.match(/from: ?"([^"]+)"/) ?? [])[1] === from;
  const ser = S.find((s) => same(s.query) && /requests = countIf\(characteristics\.classifier == "request"\),\s*by: \{ t = bin/.test(s.query) && !/_in/.test(s.query));
  const brk = S.find((s) => same(s.query) && /reqfail = countIf/.test(s.query));
  const m = M.final.records, drawn = m.filter((r) => Number(r.early) > 0);
  const sum = (rs, k) => rs.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  if (ser) {
    const rs = ser.final.records;
    add(w, "one pulse scan", "bins drawn", rs.length, drawn.length);
    for (const k of ["sessions", "errors", "actions", "requests"]) add(w, "one pulse scan", `Σ ${k} per bin`, sum(rs, k), sum(drawn, k));
    const byT = new Map(drawn.map((r) => [String(r.t), r]));
    let worst = 0;
    for (const r of rs) for (const k of ["sessions", "errors", "actions", "requests"]) worst = Math.max(worst, Math.abs((Number(r[k]) || 0) - (Number(byT.get(String(r.t))?.[k]) || 0)));
    add(w, "one pulse scan", "largest difference on one bar", 0, worst);
  }
  if (brk) {
    add(w, "one pulse scan", "requests (card total)", n(brk.final.records[0]?.requests), sum(m, "reqAll"));
    add(w, "one pulse scan", "failed calls (card total)", n(brk.final.records[0]?.reqfail), sum(m, "failAll"));
  }
}
// sessions + TTFB from the metric store, aligned windows
for (const E of pick(/data record\(k = "", b = "", sessions = 0\)/)) {
  const w = win(E.query.replace(/^data record[^|]*\| filter false \| append \[ /, ""));
  const ev = E.final.records;
  const tot = ev.find((r) => r.k === "total");
  const mT = first(/countDistinct\(dt\.frontend\.session\.active\.estimated_count, scalar: true\), from: "[^"]+", to: "[^"]+", filter: \{ frontend\.name == "[^"]+" \}$/, w)?.[0];
  add(w, "sessions from metric", "total", n(tot?.sessions), n(mT?.sessions));
  const mU = pick(/estimated_count, scalar: true\).*by: \{ dt\.rum\.user_type \}/, w)[0]?.final.records ?? [];
  for (const r of ev.filter((x) => x.k === "user type")) add(w, "sessions from metric", `user type ${r.b}`, n(r.sessions), n(mU.find((m) => m["dt.rum.user_type"] === r.b)?.sessions));
  const mC = pick(/estimated_count, scalar: true\).*by: \{ geo\.country\.iso_code \}/, w)[0]?.final.records ?? [];
  for (const r of ev.filter((x) => x.k === "country").slice(0, 6)) add(w, "sessions from metric", `country ${r.b}`, n(r.sessions), n(mC.find((m) => m["geo.country.iso_code"] === r.b)?.sessions));
}
const judge = (r) => {
  if (r.cur === null || r.cand === null || Number.isNaN(r.cur) || Number.isNaN(r.cand)) return ["—", "NO DATA"];
  if (r.share) { const pts = (r.cand - r.cur) * 100; return [`${pts >= 0 ? "+" : ""}${pts.toFixed(2)} pts`, Math.abs(pts) <= 0.5 ? "matches" : Math.abs(pts) <= 1.5 ? "close" : "DOES NOT MATCH"]; }
  const pc = r.cur ? (r.cand / r.cur - 1) * 100 : (r.cand ? Infinity : 0);
  return [`${pc >= 0 ? "+" : ""}${pc.toFixed(2)}%`, Math.abs(pc) <= 1 ? "matches" : Math.abs(pc) <= 3 ? "close" : "DOES NOT MATCH"];
};
const fmt = (r, v) => v === null || Number.isNaN(v) ? "—" : r.share ? (v * 100).toFixed(2) + "%" : Math.round(v).toLocaleString("en-US");
let lastW = "";
for (const r of rows) {
  if (r.w !== lastW) { console.log(`\n## window ${r.w}`); lastW = r.w; }
  const [d, v] = judge(r);
  console.log(`${v.padEnd(15)} ${r.group.padEnd(21)} ${r.measure.padEnd(34)} ${fmt(r, r.cur).padStart(12)} ${fmt(r, r.cand).padStart(12)}  ${d}`);
}
const shadowGb = sc.statements.filter((s) => /fieldsAdd _crash = _real|data record\(k = ""|realSessions = countDistinct\(if\(not|view_summary"\s*\| summarize views = count|ttfbMs = percentile\(toDouble\(ttfb\.value\), 75\), by: \{ cc/.test(s.query))
  .reduce((a, s) => a + (s.final?.scannedBytes ?? 0), 0) / 1e9;
console.log(`\nshadow queries read ${shadowGb.toFixed(1)} GB in this capture`);
