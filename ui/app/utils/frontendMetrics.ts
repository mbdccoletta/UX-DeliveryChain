// THE OVERVIEW FROM THE PLATFORM'S OWN NUMBERS (0.17.0).
//
// Marcelo, 2026-10-24: "deixar o app preparado para produção, coerente,
// consumo de lics irrisório". Measured on a bank's production application
// (6M sessions an hour) every Overview open read ≈470 GiB, almost all of it
// exact counts over raw user.events: the pulse (145), the census (145), the
// lean experience pass (78). Exact counts over raw events can never be cheap
// at that size.
//
// Dynatrace's own Frontends app does not count events either: it reads the
// dt.frontend.* metrics. So the headline numbers come from there too —
// sessions, real people's sessions, errors by type and by who raised them,
// requests and the calls that failed, user actions, and the experience
// weights by level — for ≈0 GiB, and coherent with the platform by
// construction. Sessions are the platform's estimate, like everywhere in
// Dynatrace; the screen marks them estimated.
//
// The key is the FRONTEND node, not a name: every dt.frontend.* metric
// carries dt.smartscape.frontend, and Smartscape maps it to the RUM
// application id the URL holds. Names drift between the stores (the node
// "EasyTrade_1" is the metric's "EasyTrade"); ids do not. The metric's own
// frontend.name is then the name Users & Sessions filters on.
//
// Every read is one metric — a multi-metric timeseries joins on dimensions
// and one missing series empties the whole answer (dql-syntax-gotchas).
import { binFor, eventSeriesEnd, runDql, type Timeframe } from "./dql";

const q = (s: string) => s.replace(/["\\]/g, "");

export interface FrontendNode {
  /** FRONTEND-… — the key the metrics carry. */
  id: string;
  /** APPLICATION-… / MOBILE_APPLICATION-… */
  entity: string;
  rumId: string;
  kind?: string;
}

let nodesP: Promise<FrontendNode[]> | null = null;
/** Every FRONTEND node, once per page — Smartscape, no Grail bytes. */
export function frontendNodes(): Promise<FrontendNode[]> {
  if (!nodesP) {
    nodesP = runDql<Record<string, unknown>>(`
smartscapeNodes "FRONTEND"
| fields id, entity = id_classic, rumId = lower(dt.rum.instrumentation.id), kind = frontend.type
| filter isNotNull(rumId)`, 5000)
      .then((rows) => rows.map((r) => ({ id: String(r.id), entity: String(r.entity ?? ""),
        rumId: String(r.rumId ?? ""), kind: r.kind ? String(r.kind) : undefined })))
      .catch(() => { nodesP = null; return [] as FrontendNode[]; });
  }
  return nodesP;
}

export async function frontendNodeOf(rumAppId: string): Promise<FrontendNode | null> {
  const id = rumAppId.toLowerCase();
  return (await frontendNodes()).find((n) => n.rumId === id) ?? null;
}

const scope = (fid?: string, extra = "") => {
  const parts = [fid ? `dt.smartscape.frontend == toSmartscapeId("${q(fid)}")` : "", extra].filter(Boolean);
  return parts.length ? `,\n  filter: { ${parts.join(" and ")} }` : "";
};

/** One scalar metric over the window, optionally grouped. */
export const qFmScalar = (tf: Timeframe, agg: string, fid?: string, by?: string, extra = "") =>
  `timeseries v = ${agg},
  from: ${tf.from}, to: ${tf.to}${scope(fid, extra)}${by ? `,\n  by: { ${by} }` : ""}`;

/** One metric's series, binned like the chart, ending where the live
 *  stream is settled. */
export const qFmSeries = (tf: Timeframe, agg: string, fid: string) =>
  `timeseries v = ${agg},
  from: ${tf.from}, to: ${eventSeriesEnd(tf)}, interval: ${binFor(tf.minutes)}${scope(fid)}`;

const SESS = "countDistinct(dt.frontend.session.active.estimated_count, scalar: true)";
const REAL = `dt.rum.user_type == "real_user"`;

type Row = Record<string, unknown>;
const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const read = (query: string, max = 1000) => runDql<Row>(query, max);

/**
 * THE CENSUS, from the metric store: one row per application in the shape
 * qApps returns, so every reader of the census keeps working. Scoped to one
 * application, or the whole estate for the picker. Null when the metric
 * store has nothing for it (no FRONTEND node, or no published series) — the
 * caller then keeps the event census.
 */
export async function metricCensus(tf: Timeframe, rumAppId?: string | null): Promise<Row[] | null> {
  const nodes = await frontendNodes();
  if (!nodes.length) return null;
  const node = rumAppId ? nodes.find((x) => x.rumId === rumAppId.toLowerCase()) : null;
  if (rumAppId && !node) return null;
  const fid = node?.id;
  const BY = "dt.smartscape.frontend";
  const [sess, real, errs] = await Promise.all([
    read(qFmScalar(tf, SESS, fid, BY)),
    read(qFmScalar(tf, SESS, fid, BY, REAL)),
    read(qFmScalar(tf, "sum(dt.frontend.error.count, scalar: true)", fid, `${BY}, error.type`)),
  ]);
  /* A KNOWN FRONTEND WITH NO SESSIONS IS AN ANSWER (0.17.33): "none in this
     window". Returning null sent the caller to the event census, and from
     there — scoped census empty — to the estate-wide one: ≈221 GiB per pick
     of an idle application, measured five times in six minutes. */
  if (!sess.length) return node ? [] : null;
  const byNode = new Map(nodes.map((x) => [x.id, x]));
  const rows = new Map<string, Row>();
  for (const r of sess) {
    const fe = byNode.get(String(r[BY] ?? ""));
    if (!fe) continue;
    rows.set(fe.id, { appId: fe.rumId, entity: fe.entity, sessions: n(r.v),
      realSessions: 0, views: 0, errors: 0, crashes: 0, anrs: 0,
      p50View: 0, p90View: 0, p95View: 0, p50Load: 0, p50Xhr: 0, resPerAct: 0 });
  }
  for (const r of real) {
    const row = rows.get(String(r[BY] ?? ""));
    if (row) row.realSessions = n(r.v);
  }
  for (const r of errs) {
    const row = rows.get(String(r[BY] ?? ""));
    if (!row) continue;
    row.errors = n(row.errors) + n(r.v);
    if (r["error.type"] === "crash") row.crashes = n(row.crashes) + n(r.v);
    if (r["error.type"] === "anr") row.anrs = n(row.anrs) + n(r.v);
  }
  const out = [...rows.values()].filter((r) => n(r.sessions) > 0);
  return out.length ? out : null;
}

export interface FrontendMetrics {
  node: FrontendNode;
  /** The name the sessions store and Users & Sessions filter on. */
  feName: string;
  sessions: number;
  realSessions: number;
  errors: number;
  realErrors: number;
  errorsThird: number;
  crashes: number;
  anrs: number;
  requests: number;
  /** Requests answered 4xx or 5xx. */
  reqFail: number;
  actions: number;
  /** Experience weights of real people's user actions, by level — the
   *  platform's own rating, exactly as its Frontends app sums it. */
  satisfied: number;
  tolerating: number;
  frustrated: number;
  /** p50 of a hard navigation, in ms. */
  p50LoadMs: number;
  series: Array<{ t: string; sessions: number; errors: number; actions: number; requests: number }>;
}

const memo = new Map<string, Promise<FrontendMetrics | null>>();

/** Everything the Overview's first paint shows, from metrics. Null when the
 *  application has no FRONTEND node or the store has no sessions for it. */
export function frontendMetrics(tf: Timeframe, rumAppId: string, gen = 0): Promise<FrontendMetrics | null> {
  const key = `${tf.from}|${tf.to}|${rumAppId}|${gen}`;
  let p = memo.get(key);
  if (!p) {
    p = loadFrontendMetrics(tf, rumAppId).catch(() => null);
    memo.set(key, p);
  }
  return p;
}

async function loadFrontendMetrics(tf: Timeframe, rumAppId: string): Promise<FrontendMetrics | null> {
  const node = await frontendNodeOf(rumAppId);
  if (!node) return null;
  const f = node.id;
  const [names, real, errs, reqs, acts, exp, dur, sSer, eSer, rSer, aSer] = await Promise.all([
    read(qFmScalar(tf, SESS, f, "frontend.name")),
    read(qFmScalar(tf, SESS, f, undefined, REAL)),
    read(qFmScalar(tf, "sum(dt.frontend.error.count, scalar: true)", f,
      "error.type, url.provider, dt.rum.user_type")),
    read(qFmScalar(tf, "sum(dt.frontend.request.count, scalar: true)", f,
      "http.response.status_code_class")),
    read(qFmScalar(tf, "sum(dt.frontend.user_action.count, scalar: true)", f)),
    read(qFmScalar(tf, "sum(dt.frontend.experience.weight, scalar: true)", f,
      "experience.level", REAL)),
    read(qFmScalar(tf, "percentile(dt.frontend.user_action.duration, 50, scalar: true)", f,
      "user_action.type")),
    read(qFmSeries(tf, "countDistinct(dt.frontend.session.active.estimated_count)", f), 1),
    read(qFmSeries(tf, "sum(dt.frontend.error.count)", f), 1),
    read(qFmSeries(tf, "sum(dt.frontend.request.count)", f), 1),
    read(qFmSeries(tf, "sum(dt.frontend.user_action.count)", f), 1),
  ]);
  // the busiest name wins when a frontend was renamed inside the window
  const top = [...names].sort((a, b) => n(b.v) - n(a.v))[0];
  if (!top || !(n(top.v) > 0)) return null;
  const sessions = names.reduce((a, r) => a + n(r.v), 0);

  let errors = 0, realErrors = 0, errorsThird = 0, crashes = 0, anrs = 0;
  for (const r of errs) {
    const v = n(r.v);
    errors += v;
    if (r["dt.rum.user_type"] === "real_user") realErrors += v;
    if (r["url.provider"] === "third_party") errorsThird += v;
    if (r["error.type"] === "crash") crashes += v;
    if (r["error.type"] === "anr") anrs += v;
  }
  let requests = 0, reqFail = 0;
  for (const r of reqs) {
    const v = n(r.v);
    requests += v;
    if (r["http.response.status_code_class"] === "4xx" || r["http.response.status_code_class"] === "5xx") reqFail += v;
  }
  const lvl = (k: string) => n(exp.find((r) => r["experience.level"] === k)?.v);
  const load = dur.find((r) => r["user_action.type"] === "hard_navigation")
    ?? dur.find((r) => r["user_action.type"] === "app_start");

  /* The four series share the window and the bin; the i-th value belongs to
     start + i·interval. Joined by timestamp, a missing series is zeros. */
  const arr = (rows: Row[]) => {
    const r = rows[0] as { v?: Array<number | null>; timeframe?: { start?: string }; interval?: string } | undefined;
    return { v: r?.v ?? [], start: Date.parse(String(r?.timeframe?.start ?? "")),
      iv: Number(r?.interval ?? 0) / 1e6 };
  };
  const S = arr(sSer), E = arr(eSer), R = arr(rSer), A = arr(aSer);
  const base = [S, E, R, A].find((x) => Number.isFinite(x.start) && x.iv > 0);
  const series: FrontendMetrics["series"] = [];
  if (base) {
    const at = (x: typeof S, t: number) => (Number.isFinite(x.start) && x.iv > 0
      ? n(x.v[Math.round((t - x.start) / x.iv)]) : 0);
    const len = Math.max(S.v.length, E.v.length, R.v.length, A.v.length);
    for (let i = 0; i < len; i++) {
      const t = base.start + i * base.iv;
      series.push({ t: new Date(t).toISOString(), sessions: at(S, t), errors: at(E, t),
        requests: at(R, t), actions: at(A, t) });
    }
  }

  return {
    node, feName: String(top["frontend.name"] ?? ""),
    sessions, realSessions: n(real[0]?.v),
    errors, realErrors, errorsThird, crashes, anrs,
    requests, reqFail, actions: n(acts[0]?.v),
    satisfied: lvl("satisfied"), tolerating: lvl("tolerating"), frustrated: lvl("frustrated"),
    p50LoadMs: n(load?.v),
    series,
  };
}
