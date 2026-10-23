// Renders every DQL builder in ui/app/utils/dql.ts to one file each, exactly as
// Grail receives it, so `verify.sh` can parse them all without running any.
//
// Builders whose arguments cannot be guessed get realistic samples below; a
// builder that renders nothing is reported, never silently skipped.
import { writeFileSync } from "node:fs";

const m = await import(process.argv[2]);
const dir = process.argv[3];
const tf = { from: "now()-1h", to: "now()", minutes: 60, label: "last 1h" };
const app = "00000000-0000-0000-0000-000000000000";
const svc = ["SERVICE-0123456789ABCDEF", "SERVICE-FEDCBA9876543210"];

const SAMPLES = {
  qAppTraceIds: [app],
  qFrontendNames: [60],
  qMetricForecastExpr: ["errors", "Sample frontend", "now()-2h", "now()-3m", "2m"],
  qAppServices: [["4bf92f3577b34da6a3ce929d0e0e4736"]],
  qCloudPlacement: [["HOST-0123456789ABCDEF"]],
  qCohortPivot: [tf, app, ["s1", "s2"], "os.name"],
  qDbEntities: [[{ addr: "db01.example.local", ns: "core" }, { addr: "10.0.0.5" }]],
  qDbEntity: ["db01.example.local", "core"],
  qDomMetrics: [app, "api.example.com", tf],
  qGeoWho: [tf, app, "BR", 0.0015],
  qGeoRegions: [tf, app, "BR"],
  qGeoCities: [tf, app, "BR", "SP"],
  qGeoCountry: [tf, app, "BR"],
  qGeoRegion: [tf, app, "BR", "SP"],
  qBizSeries: [tf, "sessions", app, {}],
  // sampled, so the parser sees the session-sample filter
  qCohortSessions: [tf, app, {}, 0.0015],
  qPathSessions: [tf, app, 0.0015],
  qLambdaPlacement: [["AWS_LAMBDA_FUNCTION-0123456789ABCDEF"]],
  qServiceDataStores: [svc],
  qServiceRuntime: [svc],
  qServicesGen2Calls: [svc],
};
const GENERIC = [[tf, app], [tf, null, app], [tf], [], [app, tf], [tf, app, {}], [tf, {}, app], [60], [tf, [app]]];
// a query may open with comment lines before its first command
const looksDql = (s) => typeof s === "string"
  && /^\s*(?:\/\/[^\n]*\n\s*)*(fetch|timeseries|data|smartscape)/.test(s);

let n = 0;
const missed = [];
for (const [name, fn] of Object.entries(m)) {
  if (!/^q[A-Z]/.test(name) || typeof fn !== "function") continue;
  const tries = SAMPLES[name] ? [SAMPLES[name]] : GENERIC;
  const q = tries.map((a) => { try { return fn(...a); } catch { return null; } }).find(looksDql);
  if (q) { writeFileSync(`${dir}/${name}.dql`, q); n++; } else missed.push(name);
}
console.log(`rendered ${n}`);
if (missed.length) { console.log(`NOT RENDERED (add a sample): ${missed.join(", ")}`); process.exitCode = 1; }
