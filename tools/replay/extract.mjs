#!/usr/bin/env node
// HAR → replay scenario.
//
// A capture of the app on a production estate holds every DQL statement the
// app sent, every preview Grail answered on the way, the final rows, the
// bytes read and the time Grail spent. This turns it into a scenario file
// the audit (and a replay mode) can run against — no tenant involved.
//
//   node tools/replay/extract.mjs <capture.har> <scenario-name>
//
// The scenario is written to tools/replay/scenarios/<name>.json, which is
// git-ignored: it carries the customer's own data (screen names, countries,
// counts). Pass --anonymize to replace application ids and names with stable
// placeholders when a scenario has to leave this machine.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [, , harPath, name, ...flags] = process.argv;
if (!harPath || !name) {
  console.error("usage: extract.mjs <capture.har> <scenario-name> [--anonymize]");
  process.exit(2);
}
const anonymize = flags.includes("--anonymize");
const here = dirname(fileURLToPath(import.meta.url));
const har = JSON.parse(readFileSync(harPath, "utf8"));
const entries = har.log.entries;
const ts = (e) => Date.parse(e.startedDateTime);
const t0 = Math.min(...entries.map(ts));

/** The query as the app wrote it, with the application id lifted out — so a
 *  scenario recorded on one application replays for the builder's text. */
const appIds = new Set();
const normalize = (q) => q
  .replace(/dt\.rum\.application\.id == "([^"]+)"/g, (_, id) => { appIds.add(id); return 'dt.rum.application.id == "<APP>"'; })
  .replace(/\s+/g, " ").trim();

const body = (e) => {
  try { return JSON.parse(e.response?.content?.text ?? ""); } catch { return null; }
};

const statements = new Map();   // requestToken → statement
const order = [];
for (const e of entries) {
  const url = e.request.url;
  if (url.includes("query:execute")) {
    let req = {};
    try { req = JSON.parse(e.request.postData?.text ?? "{}"); } catch { /* not json */ }
    const res = body(e) ?? {};
    const tok = res.requestToken ?? `inline-${order.length}`;
    const grail = res.result?.metadata?.grail ?? {};
    const st = {
      id: order.length,
      query: normalize(req.query ?? ""),
      maxResultRecords: req.maxResultRecords ?? null,
      startMs: ts(e) - t0,
      timeline: [],
      final: null,
    };
    // an execute can answer whole (small queries) or with a first preview
    if (res.result?.records) {
      st.timeline.push({ atMs: ts(e) - t0 + e.time, state: res.state,
        rows: res.result.records.length, scannedBytes: grail.scannedBytes ?? 0 });
      if (res.state === "SUCCEEDED") st.final = { atMs: ts(e) - t0 + e.time,
        records: res.result.records, scannedBytes: grail.scannedBytes ?? 0,
        execMs: grail.executionTimeMilliseconds ?? null };
    }
    statements.set(tok, st);
    order.push(st);
  } else if (url.includes("query:poll")) {
    const tok = decodeURIComponent((url.match(/request-token=([^&]+)/) ?? [])[1] ?? "");
    const st = statements.get(tok);
    const res = body(e);
    if (!st || !res) continue;
    const grail = res.result?.metadata?.grail ?? {};
    const atMs = ts(e) - t0 + e.time;
    if (res.result?.records) {
      st.timeline.push({ atMs, state: res.state, rows: res.result.records.length,
        scannedBytes: grail.scannedBytes ?? 0,
        // keep each preview's rows: a preview's VALUES are what the bias
        // checks compare with the final
        records: res.state === "SUCCEEDED" ? undefined : res.result.records });
    }
    if (res.state === "SUCCEEDED") {
      st.final = { atMs, records: res.result?.records ?? [],
        scannedBytes: grail.scannedBytes ?? 0, execMs: grail.executionTimeMilliseconds ?? null };
    }
    if (res.error) st.error = String(res.error.message ?? res.error);
  }
}

let scenario = { name, capturedAt: entries[0]?.startedDateTime, durationMs: Math.max(...entries.map((e) => ts(e) - t0 + e.time)),
  appIds: [...appIds], statements: order };

if (anonymize) {
  // stable placeholders: the same id or name always maps to the same token
  const map = new Map();
  let n = 0;
  const tok = (v) => { if (!map.has(v)) map.set(v, `anon-${++n}`); return map.get(v); };
  const text = JSON.stringify(scenario)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b[0-9a-f]{16}\b/g, tok);
  scenario = JSON.parse(text);
}

const out = join(here, "scenarios", `${name}.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(scenario));
const finals = order.filter((s) => s.final).length;
console.log(`${out}\n${order.length} statements · ${finals} with a final · ${(JSON.stringify(scenario).length / 1e6).toFixed(1)} MB`);
