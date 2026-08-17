// ROUTE MATRIX — the truth table of "which app do we suggest first".
//
// Runs investigationPaths for every element kind × state (healthy, users
// impacted, Davis problem, problem+impact, anomaly) and prints who leads each
// persona. This is how the suggestions were revalidated when the reader asked
// for no-doubt ordering; run it after any change to utils/links.ts:
//
//   node_modules/.bin/esbuild tools/route-matrix.ts --bundle --platform=node //     --format=cjs --external:react --outfile=/tmp/route-matrix.cjs //   && node /tmp/route-matrix.cjs 2>/dev/null
//
// ("Missing … web runtime" stderr noise is expected outside the AppShell.)
import { investigationPaths } from "../ui/app/utils/links";

const tf = { from: "now()-2h", to: "now()", label: "last 2h", minutes: 120 } as any;
const APPS = {
  services: { appId: "dynatrace.services", name: "Services", classic: false },
  hosts: { appId: "dynatrace.infraops", name: "Infrastructure", classic: false },
  processes: { appId: "dynatrace.infraops", name: "Infrastructure", classic: false },
  kubernetes: { appId: "dynatrace.kubernetes", name: "Kubernetes", classic: false },
  logs: { appId: "dynatrace.logs", name: "Logs", classic: false },
  traces: { appId: "dynatrace.distributedtracing", name: "Distributed Tracing", classic: false },
  problems: { appId: "dynatrace.davis.problems", name: "Problems", classic: false },
  rum: { appId: "dynatrace.experience.vitals", name: "Experience Vitals", classic: false },
  mobile: { appId: "dynatrace.experience.vitals", name: "Experience Vitals", classic: false },
  databases: { appId: "dynatrace.database.overview", name: "Databases", classic: false },
} as any;

const IDS: Record<string, string[]> = {
  service: ["SERVICE-1"], pod: ["K8S_POD-1", "CLOUD_APPLICATION_INSTANCE-1"],
  node: ["K8S_NODE-1", "KUBERNETES_NODE-1"], host: ["HOST-1"],
  process: ["PROCESS_GROUP_INSTANCE-1"], webApp: ["APPLICATION-1"],
  mobileApp: ["MOBILE_APPLICATION-1"], origin: [], domain3p: [], domain1p: [], store: [], element: [],
};
const PROB = { display_id: "P-1", name: "CPU saturation", category: "RESOURCE_CONTENTION", eventId: "e1" } as any;
const STATES: Array<[string, any]> = [
  ["healthy", {}],
  ["impacted", { impacted: { hit: 500, sessions: 600, hitReal: 500, hitRobot: 0, hitSynth: 0, ex: { sid: "s1", start: "t", errs: 3, inst: "i1" } } }],
  ["problem", { problem: PROB, problems: 1 }],
  ["prob+imp", { problem: PROB, problems: 1, impacted: { hit: 500, sessions: 600, hitReal: 500, hitRobot: 0, hitSynth: 0 } }],
  ["anomaly", { signals: 2 }],
];
const kinds = ["service","pod","node","host","process","webApp","mobileApp","origin","domain3p","domain1p","store"];
for (const kind of kinds) {
  for (const [st, extra] of STATES) {
    const name = kind === "origin" ? "Browsers" : kind === "store" ? "db1" : "elem";
    const routes = investigationPaths({
      ids: IDS[kind] ?? [], name, tf, kind: kind as any,
      rumAppId: "app1", scopedAppName: "MyApp", scopedEntity: "APPLICATION-1",
      errors: 900, sessions: kind === "origin" ? 600 : undefined,
      crashes: kind === "mobileApp" ? 14 : undefined,
      domain: (kind.startsWith("domain") || kind === "store") ? "x.example.com" : undefined,
      domainHasSpans: true, assist: true, apps: APPS, facts: { lines: [] },
      ...extra,
    } as any);
    const row = routes.map((r) => `${r.persona[0].toUpperCase()}: ${r.steps.map((s) => s.app).join(" → ")}`).join("  |  ");
    console.log(`${kind.padEnd(9)} ${st.padEnd(9)} ${row}`);
  }
  console.log();
}
