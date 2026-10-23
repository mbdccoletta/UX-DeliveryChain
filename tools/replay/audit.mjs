#!/usr/bin/env node
// Audit a replay scenario: data integrity, load performance, cost — and a
// performance model calibrated on the capture itself.
//
//   node tools/replay/audit.mjs <scenario-name>
//
// Everything here is read from the scenario (see extract.mjs); no tenant is
// queried. The checks are the ones that found real defects on a production
// estate — each says what it guards against.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const name = process.argv[2];
if (!name) { console.error("usage: audit.mjs <scenario-name>"); process.exit(2); }
const here = dirname(fileURLToPath(import.meta.url));
const sc = JSON.parse(readFileSync(join(here, "scenarios", `${name}.json`), "utf8"));
const S = sc.statements;

/* ── which builder sent each statement ──────────────────────────────────── */
// First match wins; the page is where the reader sees the answer.
const FAMILIES = [
  ["infographic facts",   "journeys", /hashSha256\(toString\(dt\.rum\.session\.id\)\)[\s\S]*reached = max/],
  ["frontend names",      "app",      /fetch user\.sessions, from: now\(\)-\d+m \| expand ent/],
  ["impact (store)",      "overview", /fetch user\.sessions.*hitReal/],
  ["session series",      "overview", /fetch user\.sessions.*bin\(start_time/],
  ["census",              "app",      /summarize sessions = countDistinct\(dt\.rum\.session\.id\), views = countIf/],
  ["impact (events)",     "overview", /exSid = takeFirst/],
  ["ux per session",      "overview", /errsThird = countIf/],
  ["origins",             "overview", /agent = takeAny\(dt\.rum\.agent\.type\)/],
  ["experience score",    "overview", /ratedActs = countIf|ratedActs = count\(\)/],
  ["country profile",     "overview", /inC = max\(if\(geo\.country\.iso_code/],
  ["states",              "overview", /by: \{ region = geo\.region\.iso_code, name = geo\.region\.name \}/],
  ["cities",              "overview", /by: \{ city = geo\.city\.name \}/],
  ["screens of a place",  "overview", /by: \{ view = vn \}/],
  ["geo",                 "overview", /by: \{ country = geo\.country\.iso_code \}/],
  ["request totals",      "overview", /reqfail = countIf/],
  ["event series",        "overview", /by: \{ t = bin\(start_time/],
  ["card detail",         "overview", /p95 = percentile/],
  ["trace ids",           "chain",    /isNotNull\(trace\.id\)/],
  ["span presence probe", "chain",    /^fetch spans/],
  ["domains",             "chain",    /url\.domain|Requests UNION failed calls/],
  ["davis problems",      "app",      /fetch dt\.davis\.problems/],
  ["open signals",        "app",      /fetch dt\.davis\.events.*affected_entity_ids/],
  ["davis rollup",        "app",      /fetch dt\.davis\.events/],
  ["topology",            "app",      /^smartscape/],
  ["metric store",        "overview", /^timeseries/],
  ["board: previous",     "board",    /from: now\(\)-1h-60m|from:now\(\) - 1h - 60m/],
  ["board: cube",         "board",    /_bucket = if\(not\(_isErr\)/],
  ["forecast series",     "board",    /makeTimeseries/],
  ["infographic paths",   "journeys", /path = collectArray/],
  ["journeys",            "journeys", /view_summary|navigation|user_action/],
];
const familyOf = (q) => (FAMILIES.find(([, , re]) => re.test(q)) ?? ["other", "other"]);
for (const s of S) { const [f, p] = familyOf(s.query); s.family = f; s.page = p; }

const gb = (b) => (b ?? 0) / 1e9;
const sec = (ms) => (ms / 1000).toFixed(1);
const limitOf = (q) => { const m = q.match(/\| limit (\d+)\s*$/) ?? q.match(/\| limit (\d+)/g)?.slice(-1)[0]?.match(/(\d+)/); return m ? Number(m[1]) : null; };
const out = [];
const say = (...l) => out.push(l.join(""));

say(`# Scenario "${sc.name}" — ${S.length} statements, ${sec(sc.durationMs)} s captured`);

/* ── 1. INTEGRITY ───────────────────────────────────────────────────────── */
say("\n## Integrity");
let issues = 0;
// 1a. silent truncation: the rows came back exactly at a ceiling
for (const s of S) {
  if (!s.final) continue;
  const n = s.final.records.length;
  const caps = [s.maxResultRecords, limitOf(s.query)].filter((x) => x);
  const hit = caps.find((c) => n >= c);
  // a single aggregate row at a ceiling of 1 is the whole answer
  const aggregate = hit === 1;
  // biggest-first then cut is a ranking by design — unless the page SUMS
  // the rows (then the total is low), which the families below do
  const sorted = /\| sort [^|]*desc\s*\|\s*limit/.test(s.query) || /\| sort [^|]*desc\s*\| limit/.test(s.query);
  const summed = /request totals|country profile|topology|open signals/.test(s.family);
  if (hit && !aggregate) {
    if (sorted && !summed) say(`- top-${hit}    ${s.family}: ranking cut by design (biggest first)`);
    else { issues++; say(`- TRUNCATED  ${s.family}: ${n} rows = ceiling ${hit} — rows past it are missing, and anything summed over them is low`); }
  }
  if (s.maxResultRecords && limitOf(s.query) && s.maxResultRecords < limitOf(s.query)) {
    issues++; say(`- CAP MISMATCH  ${s.family}: query allows ${limitOf(s.query)}, the client cuts at ${s.maxResultRecords}`);
  }
}
// 1b. preview bias on per-session shares: a preview of a per-session count
//     holds sessions with only part of their events, so "hit" reads LOW
const ratioOf = (rows) => {
  const r = rows?.[0]; if (!r) return null;
  const n = Number(r.realSessions ?? r.sessions), h = Number(r.hitReal ?? r.hit ?? r.hitSessions);
  return n > 0 && Number.isFinite(h) ? h / n : null;
};
for (const s of S) {
  if (!s.final || !/ux per session|impact/.test(s.family)) continue;
  const fin = ratioOf(s.final.records);
  const pre = s.timeline.filter((t) => t.records).map((t) => ratioOf(t.records)).filter((x) => x !== null);
  if (fin !== null && pre.length) {
    const worst = pre.reduce((a, x) => (Math.abs(x - fin) > Math.abs(a - fin) ? x : a), pre[0]);
    say(`- PREVIEW BIAS  ${s.family}: previews ${pre.map((x) => (x * 100).toFixed(0) + "%").join(" → ")} · final ${(fin * 100).toFixed(0)}% `
      + `(worst off by ${Math.abs(worst - fin) * 100 > 0 ? (Math.abs(worst - fin) * 100).toFixed(0) : 0} pts) — nothing may judge on a preview of this`);
  }
}
// 1c. the same family twice in one tour — two numbers for one fact, or a waste
const seen = new Map();
for (const s of S) {
  if (s.family === "other" || s.family === "topology" || s.family === "metric store") continue;
  const k = s.family + "|" + s.query.length;
  if (seen.has(k)) { issues++; say(`- DUPLICATE  ${s.family} ran twice (at ${sec(seen.get(k).startMs)} s and ${sec(s.startMs)} s), ${gb(s.final?.scannedBytes).toFixed(0)} GB again`); }
  else seen.set(k, s);
}
// 1d. per-session counts that do not agree across scans (impact vs ux)
const imp = S.find((s) => s.family === "impact (events)" && s.final);
const ux = S.find((s) => s.family === "ux per session" && s.final);
if (imp && ux && Math.abs(imp.startMs - ux.startMs) < 5000) {
  const a = imp.final.records[0], b = ux.final.records.find((r) => r.sessions !== null);
  if (a && b && Number(a.sessions) !== Number(b.sessions)) {
    issues++; say(`- DISAGREE  sessions: impact ${a.sessions} vs ux ${b.sessions} for the same window`);
  }
}
if (!issues) say("- no truncation, duplicate or disagreement found");

/* ── 2. PERFORMANCE ─────────────────────────────────────────────────────── */
say("\n## Load timeline (s from start)");
const rows = S.map((s) => ({ s, end: s.final?.atMs ?? null,
  first: s.timeline.find((t) => t.rows > 0)?.atMs ?? null }));
for (const { s, end, first } of rows.sort((a, b) => a.s.startMs - b.s.startMs)) {
  say(`  ${sec(s.startMs).padStart(5)}  ${s.page.padEnd(8)} ${s.family.padEnd(20)} first ${first === null ? "  —  " : sec(first).padStart(5)}`
    + `  final ${end === null ? "STILL RUNNING" : sec(end).padStart(5)}  ${gb(s.final?.scannedBytes ?? s.timeline.at(-1)?.scannedBytes).toFixed(1).padStart(6)} GB`
    + `${s.error ? "  ERROR " + s.error : ""}`);
}
const at = (fam) => S.filter((s) => s.family === fam).map((s) => s.final?.atMs ?? Infinity);
const gate = (fams) => Math.max(...fams.flatMap(at).filter((x) => x !== undefined));
say("\n## Critical paths");
const verdictMs = gate(["census", "ux per session", "experience score", "davis problems", "open signals"]);
say(`- verdict (census + per-session impact + score + Davis):  ${Number.isFinite(verdictMs) ? sec(verdictMs) + " s" : "not reached in capture"}`);
const geoMs = gate(["geo"]);
say(`- map colours (geo final):                                 ${Number.isFinite(geoMs) ? sec(geoMs) + " s" : "—"}`);
const boardMs = gate(["board: cube", "board: previous"]);
say(`- Business Control cards final:                           ${Number.isFinite(boardMs) ? sec(boardMs) + " s" : "not reached in capture"}`);
// what was competing with the verdict's slowest scan
const slow = S.filter((s) => /ux per session/.test(s.family) && s.final)[0];
if (slow) {
  const overlap = S.filter((s) => s !== slow && s.startMs < slow.final.atMs && (s.final?.atMs ?? Infinity) > slow.startMs
    && gb(s.final?.scannedBytes) > 10);
  say(`- running alongside the verdict's per-session scan: ${overlap.length} heavy scans, `
    + `${overlap.reduce((a, s) => a + gb(s.final?.scannedBytes), 0).toFixed(0)} GB — ${overlap.map((s) => s.family).join(", ")}`);
}

/* ── 3. COST ────────────────────────────────────────────────────────────── */
say("\n## Bytes read, by page");
const byPage = new Map();
for (const s of S) byPage.set(s.page, (byPage.get(s.page) ?? 0) + gb(s.final?.scannedBytes ?? s.timeline.at(-1)?.scannedBytes));
for (const [p, v] of [...byPage].sort((a, b) => b[1] - a[1])) say(`- ${p.padEnd(9)} ${v.toFixed(0).padStart(6)} GB`);
say(`- total     ${[...byPage.values()].reduce((a, v) => a + v, 0).toFixed(0).padStart(6)} GB`);
const wasted = S.filter((s) => s.final && s.final.records.length === 0 && gb(s.final.scannedBytes) > 5);
for (const s of wasted) say(`- WASTE  ${s.family}: ${gb(s.final.scannedBytes).toFixed(0)} GB read for zero rows`);

/* ── 4. MODEL ───────────────────────────────────────────────────────────── */
// Grail time per GB, by the SHAPE of the statement — the lever a query change
// actually pulls. Calibrated on this capture; concurrency is folded in, so it
// models "on this estate, under this page's load".
say("\n## Performance model (calibrated on this capture)");
const shapeOf = (q) => /^smartscape|^timeseries/.test(q) ? null
  : /by: \{ (appId = dt\.rum\.application\.id, )?sid = dt\.rum\.session\.id \}/.test(q) ? "per-session (two stage)"
  : /summarize[^|]*by:/.test(q) ? "grouped" : /summarize/.test(q) ? "ungrouped" : "row fetch";
const shapes = new Map();
for (const s of S) {
  const sh = shapeOf(s.query); if (!sh || !s.final?.execMs || gb(s.final.scannedBytes) < 1) continue;
  const v = shapes.get(sh) ?? []; v.push(s.final.execMs / gb(s.final.scannedBytes)); shapes.set(sh, v);
}
const med = (a) => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
for (const [sh, v] of shapes) say(`- ${sh.padEnd(24)} ≈ ${(med(v) / 1000).toFixed(2)} s per 10 GB… per GB ${(med(v)).toFixed(0)} ms  (n=${v.length})`.replace(" s per 10 GB… per GB", " s/GB ·"));
say("  Use: estimated seconds ≈ GB the statement reads × the shape's s/GB. A change that moves a statement");
say("  from per-session to ungrouped, or cuts the GB it reads (classifier filter, shorter window), is priced here first.");

console.log(out.join("\n"));
