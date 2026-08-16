// Data layer — every query here was validated against tenant bwm98081
// before it became code.
import { queryExecutionClient } from "@dynatrace-sdk/client-query";
import { APDEX_T_NS, APDEX_4T_NS } from "./apdex";

/**
 * The window every query runs over.
 *
 * Two DQL time expressions rather than one duration, because the platform's
 * own timeframe selector offers both relative windows ("last 6 hours") and
 * absolute ranges, and an absolute range collapsed into "the last N hours"
 * would silently move the user's window. `from`/`to` go into the query as
 * given; `minutes` is the measured span every derived figure needs (bin
 * width, per-minute rates, forecast horizon).
 */
export interface Timeframe {
  /** DQL expression: `now()-2h`, or a quoted ISO timestamp. */
  from: string;
  to: string;
  /** What to call it on screen. */
  label: string;
  /** Span in minutes. */
  minutes: number;
}

const UNIT_MIN: Record<string, number> = { m: 1, h: 60, d: 1440, w: 10080 };

/** A rolling window from a duration — what the app opens on. */
export function relTf(dur: string): Timeframe {
  const m = /^(\d+)([mhdw])$/.exec(dur);
  const minutes = m ? Number(m[1]) * UNIT_MIN[m[2]] : 120;
  return { from: `now()-${dur}`, to: "now()", label: `last ${dur}`, minutes };
}

/** Minutes as the shortest DQL duration that says them exactly. */
export function durStr(minutes: number): string {
  const m = Math.max(1, Math.round(minutes));
  if (m % 1440 === 0) return `${m / 1440}d`;
  if (m % 60 === 0) return `${m / 60}h`;
  return `${m}m`;
}

/**
 * Reads the platform selector's answer.
 *
 * The selector speaks the platform's own time grammar, not DQL's: it emits
 * `-30m`, `now`, `@d` (start of today) and `-1d@d` (start of yesterday) for
 * its presets, and ISO timestamps for a custom range. Those go into the URL
 * verbatim so the control round-trips exactly what the user picked, and this
 * is the one place they become DQL: a rolling window stays rolling
 * (`now()-30m`), while a day boundary or a custom range resolves to an
 * absolute timestamp, which DQL accepts quoted (verified on the tenant).
 */
export function tfFrom(from: string, to: string): Timeframe {
  // Both grammars the control has been seen to emit: its own (`-24h`) and the
  // DQL-shaped one (`now()-24h`). Reading only one of them let the URL change
  // while the numbers stayed on the old window — a silent lie on screen.
  const REL = /^(?:now\(\)\s*)?-\s*(\d+)([mhdw])$/i;
  const startOfDay = (offsetDays: number): Date => {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    d.setHours(0, 0, 0, 0);
    return d;
  };
  /** A platform time value → an absolute Date, when it means one. */
  const asDate = (v: string): Date | null => {
    const t = v.trim();
    if (/^now\(?\)?$/i.test(t)) return new Date();
    if (/^@d$/i.test(t)) return startOfDay(0);
    const day = /^-(\d+)d@d$/i.exec(t);
    if (day) return startOfDay(-Number(day[1]));
    const rel = REL.exec(t);
    if (rel) return new Date(Date.now() - Number(rel[1]) * UNIT_MIN[rel[2].toLowerCase()] * 6e4);
    const d = new Date(t);
    return Number.isFinite(d.getTime()) ? d : null;
  };
  /** The DQL form: rolling stays rolling, everything else is a timestamp. */
  const asDql = (v: string): string => {
    const t = v.trim();
    if (/^now\(?\)?$/i.test(t)) return "now()";
    const rel = REL.exec(t);
    if (rel) return `now()-${rel[1]}${rel[2].toLowerCase()}`;
    const d = asDate(t);
    return d ? `"${d.toISOString()}"` : "now()-2h";
  };

  const a = asDate(from), b = asDate(to);
  const minutes = a && b ? Math.max(1, Math.round((b.getTime() - a.getTime()) / 6e4)) : 120;
  const rolling = REL.test(from.trim()) && /^now\(?\)?$/i.test(to.trim());
  // A day-boundary range reads "00:00 → 00:00" without its dates, which says
  // nothing — so the date joins the label whenever the window is not inside
  // one calendar day.
  const hm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const md = (d: Date) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const sameDay = a && b && a.toDateString() === b.toDateString();
  const label = rolling ? `last ${durStr(minutes)}`
    : a && b ? (sameDay ? `${md(a)} ${hm(a)} → ${hm(b)}`
      : `${md(a)} ${hm(a)} → ${md(b)} ${hm(b)}`)
    : `last ${durStr(minutes)}`;
  return { from: asDql(from), to: asDql(to), minutes, label };
}

/**
 * Bin width for a chart over this window: about 34 points, snapped to a round
 * duration. Derived, not tabled, because the window is now anything the user
 * picks rather than one of four presets.
 */
export function binFor(minutes: number): string {
  const target = minutes / 34;
  const CHOICES = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440];
  return durStr(CHOICES.find((c) => c >= target) ?? 1440);
}

/** Runs DQL, polling until the result is ready. */
export async function runDql<T = Record<string, unknown>>(
  query: string,
  maxResultRecords = 200,
): Promise<T[]> {
  let res = await queryExecutionClient.queryExecute({
    body: { query, requestTimeoutMilliseconds: 30000, maxResultRecords },
  });
  while (res.state === "RUNNING" || res.state === "NOT_STARTED") {
    await new Promise((r) => setTimeout(r, 400));
    res = await queryExecutionClient.queryPoll({ requestToken: res.requestToken! });
  }
  if (res.state !== "SUCCEEDED") throw new Error(`DQL ${res.state}`);
  return (res.result?.records ?? []) as T[];
}

/* ─────────────── RUM ─────────────── */

/** Volume per application (first level of the flow). */
/**
 * Narrows every RUM query to a single session.
 *
 * Built for validation: with one session on screen the mined path can be read
 * against the raw events one to one, which is the only way to tell whether the
 * normalisation, the ordering and the stage rules are right rather than merely
 * plausible. It is a filter, not a mode — every figure keeps its usual meaning,
 * it just describes one session instead of thousands.
 */
export const onlySession = (id?: string | null) =>
  id ? `\n| filter dt.rum.session.id == "${String(id).replace(/["\\]/g, "")}"` : "";

export const qApps = (tf: Timeframe, session?: string | null) => `
fetch user.events, from: ${tf.from}, to: ${tf.to}${onlySession(session)}
| summarize sessions = countDistinct(dt.rum.session.id),
    views = countIf(characteristics.classifier == "view_summary"),
    errors = countIf(characteristics.classifier == "error"),
    crashes = countIf(characteristics.classifier == "error" and error.type == "crash"),
    anrs = countIf(characteristics.classifier == "error" and error.type == "anr"),
    p50View = percentile(if(characteristics.classifier == "view_summary", toLong(duration)), 50),
    p90View = percentile(if(characteristics.classifier == "view_summary", toLong(duration)), 90),
    p95View = percentile(if(characteristics.classifier == "view_summary", toLong(duration)), 95),
    p50Load = percentile(if(characteristics.classifier == "user_action"
      and (user_action.type == "hard_navigation" or user_action.type == "navigation"),
      toLong(duration)), 50),
    p50Xhr = percentile(if(characteristics.classifier == "user_action"
      and user_action.type == "xhr", toLong(duration)), 50),
    resPerAct = avg(if(characteristics.classifier == "user_action",
      toLong(user_action.resources.count))),
    entity = takeAny(dt.rum.application.entity),
  by: { appId = dt.rum.application.id }
| filter isNotNull(appId) and appId != "" and not(startsWith(appId, "APPLICATION-"))
| sort sessions desc | limit 50`;

/** Application names from the entity inventory. */
/**
 * Names for every kind of RUM application, not just web. `dt.rum.application.id`
 * carries mobile apps too (a UUID there, an 8-byte hex for web), so the lookup
 * has to cover the mobile and custom entity types or those apps show up as
 * "Application 4f2a…" with no name.
 */
export const qAppNames = () => `
fetch dt.entity.application
| fields id, name = entity.name
| append [ fetch dt.entity.mobile_application | fields id, name = entity.name ]
| append [ fetch dt.entity.custom_application | fields id, name = entity.name ]
| limit 400`;

/** Detected views per application (journeys). */
export const qViews = (tf: Timeframe, session?: string | null) => `
fetch user.events, from: ${tf.from}, to: ${tf.to}${onlySession(session)}
| filter characteristics.classifier == "view_summary" and isNotNull(${VIEW_NAME})
// Normalised before the aggregation, for the same reason the journeys are: the
// limit is applied after grouping, so one uncollapsed id splits a real view
// into hundreds of rows of one and pushes the real ones off the end. Measured
// on this tenant: 1,042 raw names collapse to 9. A "limit 120" over 1,042
// fragments was returning mostly noise.
${norm(VIEW_NAME, "v")}
| summarize views = count(), sessions = countDistinct(dt.rum.session.id),
    p50 = percentile(toLong(duration), 50),
  by: { appId = dt.rum.application.id, view = v }
| sort sessions desc | limit 120`;

/** Navigation sequences — path mining, one ordered path per session. */
export const qSequences = (tf: Timeframe, session?: string | null) => `
fetch user.events, from: ${tf.from}, to: ${tf.to}${onlySession(session)}
// UNION of navigation and view_summary, because coverage inverts between
// environments: on one tenant navigation covered 100% of sessions and
// view_summary 76%; on another, 72 sessions carried ONLY view_summary. Both
// agents (browser and mobile) emit both — the union is faithful to each, and
// the adjacent-duplicate collapse in mergeJourneys absorbs the overlap (a
// summary closes the very view its navigation opened).
| filter (characteristics.classifier == "navigation"
    or characteristics.classifier == "view_summary")
  and isNotNull(${VIEW_NAME})
// Identifiers are collapsed HERE, before the aggregation, because the limit
// below is applied after it: leaving one order UUID uncollapsed fragments a
// 900-session journey into 900 rows of one, and the biggest journeys fall off
// the end. Each pattern is anchored on structure a real word cannot have — the
// hyphen groups of a UUID, or an upper-case run containing a digit — so
// "/cart/checkout" and "/api/v2/orders" pass through untouched.
| fieldsAdd v = replacePattern(${VIEW_NAME},
    "'/' ALNUM{8} '-' ALNUM{4} '-' ALNUM{4} '-' ALNUM{4} '-' ALNUM{12}", "/*")
| fieldsAdd v = replacePattern(v, "'/' [A-Z0-9]{6,}", "/*")
| fieldsAdd v = replacePattern(v, "'/' INT", "/*")
// Hard cap on depth. The patterns above recognise ids by shape, and any shape
// rule can be dodged by an id that does not look like one. Truncating past the
// third segment bounds the cardinality no matter what the ids look like, which
// is what keeps the diagram readable. Screen names with no "/" are untouched.
| fieldsAdd seg = splitString(v, "/")
| fieldsAdd v = if(arraySize(seg) > 3, concat("/", seg[1], "/", seg[2], "/*"), else: v)
| fieldsRemove seg
| sort start_time asc
| summarize path = collectArray(v), by: { appId = dt.rum.application.id, session = dt.rum.session.id }
| summarize sessions = count(), by: { appId, journey = path }
| sort sessions desc | limit 200`;

/**
 * The SESSIONS behind a mined path — same pipeline as qSequences, stopped one
 * aggregation earlier.
 *
 * The custom-path picker isolates journeys; this answers "show me those
 * sessions": per-session ordered views through the identical normalisation
 * (VIEW_NAME, the id-collapsing patterns, the depth cap), plus the session id
 * and its first event time — exactly the pair the verified
 * session-details-from-event intent requires. Matching against the picks
 * happens client-side with the same rules the diagram used, so the list and
 * the ribbon can never disagree about who belongs.
 *
 * Fetched on demand (the button), never with the page: it scans the window
 * per click, and only the click has asked for it.
 */
export const qPathSessions = (tf: Timeframe, rumAppId: string) => `
fetch user.events, from: ${tf.from}, to: ${tf.to}
| filter dt.rum.application.id == "${rumAppId.replace(/["\\]/g, "")}"
| filter (characteristics.classifier == "navigation"
    or characteristics.classifier == "view_summary")
  and isNotNull(${VIEW_NAME})
| fieldsAdd v = replacePattern(${VIEW_NAME},
    "'/' ALNUM{8} '-' ALNUM{4} '-' ALNUM{4} '-' ALNUM{4} '-' ALNUM{12}", "/*")
| fieldsAdd v = replacePattern(v, "'/' [A-Z0-9]{6,}", "/*")
| fieldsAdd v = replacePattern(v, "'/' INT", "/*")
| fieldsAdd seg = splitString(v, "/")
| fieldsAdd v = if(arraySize(seg) > 3, concat("/", seg[1], "/", seg[2], "/*"), else: v)
| fieldsRemove seg
| sort start_time asc
| summarize path = collectArray(v), start = min(start_time),
  by: { sid = dt.rum.session.id }
| limit 2000`;

/**
 * The cohort analytics: ONE dimension × the per-session measures, cohort
 * beside everyone else — recomputed for whatever the reader picks.
 *
 * The earlier version chose eight dimensions and a 1.3× lift threshold on
 * the reader's behalf; the reader wants to choose. So the query takes the
 * dimension as a parameter, and returns for every bucket both sides of the
 * comparison plus the measures an analyst pivots on: sessions, error-hit
 * rate, crash rate, median duration, median views per session. The panel
 * does the arithmetic (share, lift, delta) live in the browser, so a change
 * of dimension is one query and a change of measure is none.
 *
 * Dimensions on offer are the ones measured POPULATED on this tenant (24h,
 * two applications, session-level coverage): country 98–100%, OS, browser,
 * device type/manufacturer, screen width, app version, connection type, ISP,
 * user type, agent version, orientation, navigation type. Coverage is
 * measured again per query — a null bucket is simply absent.
 */
export const COHORT_DIMS: Array<{ id: string; label: string; expr: string }> = [
  { id: "country",   label: "Country",         expr: "geo.country.iso_code" },
  { id: "os",        label: "OS",              expr: "os.name" },
  { id: "osv",       label: "OS version",      expr: "os.version" },
  { id: "browser",   label: "Browser",         expr: "browser.name" },
  { id: "browserv",  label: "Browser version", expr: "browser.version" },
  { id: "devtype",   label: "Device type",     expr: "device.type" },
  { id: "manuf",     label: "Manufacturer",    expr: "device.manufacturer" },
  { id: "screen",    label: "Screen width",    expr: "toString(device.screen.width)" },
  { id: "appv",      label: "App version",     expr: "app.short_version" },
  { id: "conn",      label: "Connection",      expr: "network.connection.type" },
  { id: "isp",       label: "ISP",             expr: "client.isp" },
  { id: "utype",     label: "User type",       expr: "dt.rum.user_type" },
  { id: "agentv",    label: "Agent version",   expr: "dt.rum.agent.version" },
  { id: "orient",    label: "Orientation",     expr: "device.orientation" },
  { id: "navtype",   label: "Navigation type", expr: "navigation.type" },
  { id: "entry",     label: "Entry view",      expr: "" },   // first view, special-cased
];

export const qCohortPivot = (
  tf: Timeframe, rumAppId: string, cohortIds: string[], dimExpr: string,
) => {
  const app = rumAppId.replace(/["\\]/g, "");
  const ids = cohortIds.slice(0, 500).map((i) => `"${i.replace(/["\\]/g, "")}"`).join(",");
  // "entry view" is the first view of the session — the sort/takeFirst pair
  const dimAgg = dimExpr
    ? `v = takeAny(${dimExpr})`
    : `v = takeFirst(coalesce(view.name, view.detected_name))`;
  return `
fetch user.events, from: ${tf.from}, to: ${tf.to}
| filter dt.rum.application.id == "${app}"${dimExpr ? "" : `
| filter characteristics.classifier == "navigation" or characteristics.classifier == "view_summary"
| sort start_time asc`}
| summarize ${dimAgg}, inCohort = takeAny(in(dt.rum.session.id, {${ids}})),
    errs = countIf(characteristics.classifier == "error"),
    crash = countIf(error.type == "crash" or error.type == "anr"),
    views = countIf(characteristics.classifier == "view_summary"),
    dur = max(toLong(duration)),
  by: { sid = dt.rum.session.id }
| filter isNotNull(v)
| summarize sessions = count(), hit = countIf(errs > 0), fatal = countIf(crash > 0),
    p50dur = percentile(dur, 50), p50views = percentile(views, 50),
  by: { bucket = toString(v), inCohort }
| sort sessions desc
| limit 300`;
};

/**
 * Every session CHARACTERISTIC the platform records, for the infographic.
 *
 * "All available" was measured, not assumed: the field inventory of
 * user.events was read off both a web and a mobile application on guu84124
 * and reduced to the categorical, session-describing fields — who the user
 * is, on what, from where. The rest of the schema (performance.*,
 * web_vitals.*, interaction.*, error.*) is measurement, not
 * characteristic, and already enters the poster as outcome.
 *
 * Every dimension is queried for every application; one that this
 * application does not record returns no bucket and the poster simply does
 * not draw it. Web-only fields (browser, DPR, protocol, navigation type,
 * page domain) and mobile-only ones (manufacturer, model, rooted, app
 * version, bundle, connection) coexist here for that reason.
 */
export const INFO_DIMS: Array<{ id: string; label: string; expr: string }> = [
  { id: "country",  label: "country",          expr: "geo.country.iso_code" },
  { id: "isp",      label: "isp / carrier",    expr: "client.isp" },
  { id: "os",       label: "os",               expr: "os.name" },
  { id: "osv",      label: "os version",       expr: "os.version" },
  { id: "browser",  label: "browser",          expr: "browser.name" },
  { id: "browserv", label: "browser version",  expr: "browser.version" },
  { id: "devtype",  label: "device type",      expr: "device.type" },
  { id: "manuf",    label: "manufacturer",     expr: "device.manufacturer" },
  { id: "model",    label: "device model",     expr: "device.model.identifier" },
  { id: "rooted",   label: "rooted device",    expr: "toString(device.is_rooted)" },
  { id: "screen",   label: "screen",
    expr: "concat(toString(device.screen.width), \"×\", toString(device.screen.height))" },
  { id: "dpr",      label: "pixel ratio",      expr: "toString(browser.window.device_pixel_ratio)" },
  { id: "orient",   label: "orientation",      expr: "device.orientation" },
  { id: "conn",     label: "connection",       expr: "network.connection.type" },
  { id: "proto",    label: "network protocol", expr: "network.protocol.name" },
  { id: "utype",    label: "user type",        expr: "dt.rum.user_type" },
  { id: "appv",     label: "app version",      expr: "app.short_version" },
  { id: "bundle",   label: "app bundle",       expr: "app.bundle" },
  { id: "agentv",   label: "agent version",    expr: "dt.rum.agent.version" },
  { id: "navtype",  label: "navigation type",  expr: "navigation.type" },
  { id: "pagedom",  label: "page domain",      expr: "page.url.domain" },
];

/**
 * The infographic's data in ONE per-session scan.
 *
 * The append-of-summaries approach hit the platform's expression limit at ~22
 * dimensions; this reads every session once — its attributes, whether it
 * reached an outcome, its outcome measures — and the browser buckets each
 * dimension and both cohorts itself. One fetch, a dozen expressions, no id
 * list, and switching dimension or measure in the poster costs nothing.
 */
/**
 * WHERE THE DIFFICULTY LIVES — inside the backend or outside it — per
 * application, both windows, one query. Two kinds of evidence:
 *
 * TIME (leg "slow", from view_summary): every view's wait decomposed by the
 * agent itself — dns+connection = the user's NETWORK, ttfb waiting = the
 * SERVER thinking, largest-paint minus first-byte = DOWNLOAD & RENDER on the
 * user's device. Sums, so the share of total waiting is readable directly.
 *
 * ERRORS (leg "err"): each error's origin from its own record — request 5xx
 * is the backend's fault; status 0/none never reached it (connection);
 * crash/anr is the device; exception is frontend code; csp a third party or
 * the user's own browser policy. Sessions counted per bucket.
 */
export const qDifficulty = (tf: Timeframe) => {
  const span = `${tf.minutes}m`;
  // UNITS, measured on the tenant: ttfb.* come in MILLISECONDS (floats —
  // truncating them to long zeroes sub-ms waits), web_vitals.* and duration
  // in NANOSECONDS. Everything is normalised to ns here.
  const slow = (label: string, from: string, to: string) => `
| append [ fetch user.events, from: ${from}, to: ${to}
  | filter characteristics.classifier == "view_summary"
  | fieldsAdd _net = (coalesce(toDouble(ttfb.dns_duration), 0.0) + coalesce(toDouble(ttfb.connection_duration), 0.0)) * 1000000
  | fieldsAdd _srv = coalesce(toDouble(ttfb.waiting_duration), 0.0) * 1000000
  | fieldsAdd _lcp = coalesce(toDouble(web_vitals.largest_contentful_paint), 0.0)
  | fieldsAdd _ttfb = coalesce(toDouble(ttfb.value), 0.0) * 1000000
  | fieldsAdd _rend = if(_lcp > _ttfb, _lcp - _ttfb, else: 0.0)
  | summarize views = count(), meas = countIf(isNotNull(ttfb.value)),
      net = sum(_net), srv = sum(_srv), rend = sum(_rend),
    by: { appId = dt.rum.application.id, period = "${label}", kind = "slow", bucket = "" } ]`;
  const err = (label: string, from: string, to: string) => `
| append [ fetch user.events, from: ${from}, to: ${to}
  | filter characteristics.classifier == "error"
  | fieldsAdd bucket = if(error.type == "crash" or error.type == "anr", "device",
      else: if(error.type == "csp", "third_party",
      else: if(error.type == "exception", "frontend",
      else: if(error.type == "request" and http.response.status_code >= 500, "backend",
      else: if(error.type == "request" and (http.response.status_code == 0
          or isNull(http.response.status_code)), "connection",
      else: if(error.type == "request", "request_4xx", else: "other"))))))
  | summarize sessions = countDistinct(dt.rum.session.id),
    by: { appId = dt.rum.application.id, period = "${label}", kind = "err", bucket } ]`;
  return `
data record(appId = "", period = "", kind = "", bucket = "", views = 0, meas = 0,
  net = 0.0, srv = 0.0, rend = 0.0, sessions = 0)
| filter false${slow("cur", tf.from, tf.to)}${slow("prev", `${tf.from}-${span}`, tf.from)}${err("cur", tf.from, tf.to)}${err("prev", `${tf.from}-${span}`, tf.from)}
| limit 400`;
};

/**
 * WHAT "NO PAGE TELEMETRY" IS — the sessions the path mining never saw,
 * unpacked. Measured before designed: 94% of them carry exactly ONE stray
 * event (~70 ms) of the "other" classifier WITH a page path — the session was
 * on a real page, its navigation just fell outside the window (window-edge
 * sessions and lone beacons); a few are request-only API traffic; some are
 * robots. Two legs: the composition, and the pages those stray beacons name
 * (per-session collectDistinct expanded back out — verified on the tenant).
 */
export const qNoTelemetry = (tf: Timeframe, rumAppId: string) => {
  const app = rumAppId.replace(/["\\]/g, "");
  const base = `fetch user.events, from: ${tf.from}, to: ${tf.to}
  | filter dt.rum.application.id == "${app}"
  | summarize navs = countIf(characteristics.classifier == "navigation"
        or characteristics.classifier == "view_summary"),
      reqs = countIf(characteristics.classifier == "request"),
      n = count(), pages = collectDistinct(page.url.path),
      isReal = takeAny(dt.rum.user_type == "real_user"),
      dur = max(toLong(duration)),
    by: { sid = dt.rum.session.id }
  | filter navs == 0`;
  return `
data record(kind = "", bucket = "", sessions = 0, real = 0, robots = 0,
  oneEvent = 0, reqOnly = 0, p50dur = 0)
| filter false
| append [ ${base}
  | summarize sessions = count(), real = countIf(isReal), robots = countIf(not(isReal)),
      oneEvent = countIf(n == 1), reqOnly = countIf(reqs > 0),
      p50dur = percentile(dur, 50),
    by: { kind = "mix", bucket = "" } ]
| append [ ${base}
  | expand pg = pages
  | filter isNotNull(pg)
  | summarize sessions = count(), by: { kind = "page", bucket = pg }
  | sort sessions desc | limit 8 ]
| limit 20`;
};

/** The outcome-keyword match, per event, over _vn (the lowercased view name). */
const DONE_DQL = ["checkout", "payment", "purchase", "confirm", "success",
  "complete", "booked", "receipt", "thank"].map((w) => `contains(_vn, "${w}")`).join(" or ");

/**
 * The series Davis forecasts for Business Control — sessions or conversions
 * per interval, over a history six times the window, so the projection of the
 * NEXT window rests on enough past. Returned as a string because the Davis
 * analyzer takes the query itself (verified: records are rejected, the query
 * string returns OK/VALID with lower/point/upper bands).
 */
export const qBizSeries = (
  tf: Timeframe, metric: "sessions" | "conversions", rumAppId?: string | null,
) => {
  const span = Math.max(tf.minutes, 30);
  const history = `now()-${span * 6}m`;
  const interval = Math.max(5, Math.round(span / 8));
  const appFilter = rumAppId
    ? `\n| filter dt.rum.application.id == "${rumAppId.replace(/["\\]/g, "")}"` : "";
  const agg = metric === "sessions" ? "sessions = count()" : "conversions = sum(reached)";
  return `fetch user.events, from: ${history}${appFilter}
| fieldsAdd _vn = lower(coalesce(view.name, view.detected_name, ""))
| fieldsAdd _done = if(${DONE_DQL}, 1, else: 0)
| summarize reached = max(_done), t = takeMin(start_time), by: { sid = dt.rum.session.id }
| makeTimeseries ${agg}, time: t, interval: ${interval}m`;
};

/**
 * Business Control's breakdown, one query: per-app conversion split by
 * error-touch (what failure costs), and conversion per segment bucket for the
 * dimensions a business reader acts on. Every leg lands in the same shape
 * { d, bucket, appId, sessions, conv, realN, realConv }, per application so
 * the board's scope filter cuts it client-side.
 */
export const qBizBreakdown = (tf: Timeframe) => {
  const dims: Array<[string, string]> = [
    ["country", "geo.country.iso_code"],
    ["os", "os.name"],
    ["browser", "browser.name"],
    ["device type", "device.type"],
    ["user type", "dt.rum.user_type"],
  ];
  const leg = (name: string, expr: string) => `
| append [ fetch user.events, from: ${tf.from}, to: ${tf.to}
  | fieldsAdd _vn = lower(coalesce(view.name, view.detected_name, ""))
  | fieldsAdd _done = if(${DONE_DQL}, 1, else: 0)
  | summarize v = takeAny(${expr}), reached = max(_done),
      errs = countIf(characteristics.classifier == "error"),
      real = takeAny(not(dt.rum.user_type == "robot") and not(dt.rum.user_type == "synthetic")),
    by: { sid = dt.rum.session.id, appId = dt.rum.application.id }
  | filter isNotNull(v)
  | summarize sessions = count(), conv = countIf(reached == 1),
      realN = countIf(real), realConv = countIf(real and reached == 1),
      realHit = countIf(real and errs > 0),
    by: { d = "${name}", bucket = toString(v), appId }
  | sort sessions desc | limit 40 ]`;
  // the error-cost leg: bucket = whether the session met an error
  const errLeg = `
| append [ fetch user.events, from: ${tf.from}, to: ${tf.to}
  | fieldsAdd _vn = lower(coalesce(view.name, view.detected_name, ""))
  | fieldsAdd _done = if(${DONE_DQL}, 1, else: 0)
  | summarize reached = max(_done),
      errs = countIf(characteristics.classifier == "error"),
      real = takeAny(not(dt.rum.user_type == "robot") and not(dt.rum.user_type == "synthetic")),
    by: { sid = dt.rum.session.id, appId = dt.rum.application.id }
  | summarize sessions = count(), conv = countIf(reached == 1),
      realN = countIf(real), realConv = countIf(real and reached == 1),
      realHit = countIf(real and errs > 0),
    by: { d = "__err", bucket = if(errs > 0, "hit", else: "clean"), appId } ]`;
  return `
data record(d = "", bucket = "", appId = "", sessions = 0, conv = 0, realN = 0, realConv = 0, realHit = 0)
| filter false${errLeg}${dims.map(([n, e]) => leg(n, e)).join("")}
| limit 500`;
};

export const qCohortSessions = (tf: Timeframe, rumAppId: string) => {
  const app = rumAppId.replace(/["\\]/g, "");
  const DONE = ["checkout", "payment", "purchase", "confirm", "success",
    "complete", "booked", "receipt", "thank"].map((w) => `contains(_vn, "${w}")`).join(" or ");
  const field = (id: string, expr: string) => `${id} = takeAny(${expr})`;
  const cols = INFO_DIMS.filter((d) => d.expr).map((d) => field(d.id, d.expr)).join(",\n      ");
  return `
fetch user.events, from: ${tf.from}, to: ${tf.to}
| filter dt.rum.application.id == "${app}"
| fieldsAdd _vn = lower(coalesce(view.name, view.detected_name, ""))
| fieldsAdd _done = if(${DONE}, 1, else: 0)
| summarize
      ${cols},
      entry = takeFirst(if(characteristics.classifier == "navigation"
        or characteristics.classifier == "view_summary", coalesce(view.name, view.detected_name), else: null)),
      reached = max(_done),
      errs = countIf(characteristics.classifier == "error"),
      crash = countIf(error.type == "crash" or error.type == "anr"),
      views = countIf(characteristics.classifier == "view_summary"),
      dur = max(toLong(duration)),
      isReal = takeAny(not(dt.rum.user_type == "robot") and not(dt.rum.user_type == "synthetic")),
    by: { sid = dt.rum.session.id }
| fields sid, reached, errs, crash, views, dur, isReal, entry,
    ${INFO_DIMS.filter((d) => d.expr).map((d) => d.id).join(", ")}
| limit 5000`;
};


/**
 * Business Control — the KPIs of both fronts, this window beside the one
 * before it of the same length, per application and for the estate.
 *
 * A control panel needs the trend, not a sentence about it. So one query
 * measures the same eight per-session facts twice: `cur` over the window on
 * screen and `prev` over the window immediately before it, both derived from
 * the same DQL expressions the screen already uses (real user = not robot,
 * not synthetic; hit = a session with an error; fatal = crash or anr; engaged
 * = more than one view; abandoned = an action ended by page_hide; the Apdex
 * bands over user actions). The panel does the deltas.
 *
 * `prev` is expressed as `now()-2×span` → `now()-span` for rolling windows —
 * the only shape a "before" can take without knowing the calendar; for an
 * absolute range the caller passes its own start and the same span. Rows
 * carry the RUM app id so per-application tiles and the estate tile come
 * from one scan.
 */
export const qBizKpis = (tf: Timeframe) => {
  const span = `${Math.max(1, Math.round(tf.minutes))}m`;
  // a session "converted" if any of its views names an outcome — the same
  // keyword set reachesOutcome() uses, expressed for DQL as contains-any
  const DONE_MATCH = ["checkout", "payment", "purchase", "confirm", "success",
    "complete", "booked", "receipt", "thank"]
    .map((w) => `contains(vn, "${w}")`).join(" or ");
  const both = (label: string, from: string, to: string) => `
| append [ fetch user.events, from: ${from}, to: ${to}
  | fieldsAdd real = not(dt.rum.user_type == "robot") and not(dt.rum.user_type == "synthetic")
  | fieldsAdd vn = lower(coalesce(view.name, view.detected_name, ""))
  | fieldsAdd done1 = if(${DONE_MATCH}, 1, else: 0)
  | summarize isReal = takeAny(real), conv = max(done1),
      errs = countIf(characteristics.classifier == "error"),
      fatal = countIf(error.type == "crash" or error.type == "anr"),
      views = countIf(characteristics.classifier == "view_summary"),
      acts = countIf(characteristics.classifier == "user_action"),
      aband = countIf(characteristics.classifier == "user_action" and user_action.complete_reason == "page_hide"),
      sat = countIf(characteristics.classifier == "user_action" and toLong(duration) <= ${APDEX_T_NS}),
      tol = countIf(characteristics.classifier == "user_action" and toLong(duration) > ${APDEX_T_NS} and toLong(duration) <= ${APDEX_4T_NS}),
      fru = countIf(characteristics.classifier == "user_action" and toLong(duration) > ${APDEX_4T_NS}),
    by: { appId = dt.rum.application.id, sid = dt.rum.session.id }
  | filter isNotNull(appId) and appId != ""
  | summarize sessions = count(), realSessions = countIf(isReal),
      converted = countIf(conv == 1), convertedReal = countIf(isReal and conv == 1),
      hitReal = countIf(isReal and errs > 0), fatalSessions = countIf(fatal > 0),
      engaged = countIf(views > 1), actions = sum(acts), abandoned = sum(aband),
      satisfied = sum(sat), tolerating = sum(tol), frustrated = sum(fru),
    by: { appId, period = "${label}" } ]`;
  return `
data record(appId = "", period = "", sessions = 0, realSessions = 0, converted = 0,
  convertedReal = 0, hitReal = 0, fatalSessions = 0,
  engaged = 0, actions = 0, abandoned = 0, satisfied = 0, tolerating = 0, frustrated = 0)
| filter false${both("cur", tf.from, tf.to)}${both("prev", `${tf.from}-${span}`, tf.from)}
| limit 200`;
};

/**
 * Collapses the identifier-looking parts of a view name, so two sessions that
 * differ only by a product id or an order UUID count as the same journey.
 *
 * Runs client-side because it needs word boundaries, which DPL patterns do not
 * have. Works on a web path (`/product/OLJCESPC7Z`) and on a mobile screen name
 * (`ProductDetail/OLJCESPC7Z`) the same way, since both arrive in
 * view.detected_name.
 */
/**
 * Words that mark the end of a valuable flow, and the intent that precedes it.
 * Matched anywhere in a view name, so they hit a web path (`/cart/checkout`)
 * and a mobile screen (`CheckoutActivity`) alike. A heuristic, not a contract:
 * callers must handle the case where an application uses none of these words.
 */
export const DONE = /checkout|payment|purchase|confirm|success|thank|complete|receipt|booked/i;
export const INTENT = /cart|basket|bag|order|booking|reserv|signup|register|subscribe|apply|quote/i;

/** True when this journey reaches a recognisable final step. */
export const reachesOutcome = (journey: string[]) => journey.some((v) => DONE.test(v));

export function normalizeView(name: string): string {
  return name
    // UUID
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "*")
    // long hex blob
    .replace(/\b[0-9a-f]{16,}\b/gi, "*")
    // a whole segment that mixes letters and digits is an id, not a word
    .replace(/(^|[/.])(?=[^/.]*\d)(?=[^/.]*[a-z])[a-z0-9_-]{6,}(?=$|[/.])/gi, "$1*")
    // bare numbers (DQL already did most of these)
    .replace(/(^|[/.])\d+(?=$|[/.])/g, "$1*");
}

/** The id-collapsing passes, shared by every query that groups by view name. */
/**
 * The view's display name, wherever the agent put it.
 *
 * Measured on guu84124, Astroshop Android, 2h: `view.detected_name` is null
 * on ALL 332 mobile navigation events — the real names ("Home", "Product
 * detail", "Cart", "Checkout") live in `view.name` — while the few mobile
 * rows that DO carry detected_name carry the Activity class
 * (com.opentelemetry.astroshop.MainActivity), which is the junk this app was
 * showing as the only mobile journey. Web carries both, equal on ~96% of
 * rows, and where they differ `view.name` is the platform's own display
 * name — the same value the Users & Sessions viewer prints and the Error
 * Inspector's "View Name" facet matches, so name-first also keeps the
 * drill-downs aligned. Every journey query keyed on detected_name alone was
 * silently dropping the mobile estate into "No page telemetry".
 */
const VIEW_NAME = "coalesce(view.name, view.detected_name)";

const norm = (src: string, out = "v") => `
| fieldsAdd ${out} = replacePattern(${src},
    "'/' ALNUM{8} '-' ALNUM{4} '-' ALNUM{4} '-' ALNUM{4} '-' ALNUM{12}", "/*")
| fieldsAdd ${out} = replacePattern(${out}, "'/' [A-Z0-9]{6,}", "/*")
| fieldsAdd ${out} = replacePattern(${out}, "'/' INT", "/*")`;

/**
 * Every move between two views, with the health of the move itself.
 *
 * A user action already carries where it came from and where it went, so the
 * edge is stated by the data instead of inferred from timestamps — and it
 * carries what the user experienced making that move: how long it took, and
 * whether it ended in the tab being closed or the action timing out.
 * Web only: user_action is not emitted by OneAgent for Mobile.
 */
export const qTransitions = (tf: Timeframe, session?: string | null) => `
fetch user.events, from: ${tf.from}, to: ${tf.to}${onlySession(session)}
| filter characteristics.classifier == "user_action" and isNotNull(view.source.detected_name)
${norm("view.source.detected_name", "s")}
${norm(VIEW_NAME, "d")}
| filter s != d
| summarize sessions = countDistinct(dt.rum.session.id), actions = count(),
    p50 = percentile(toLong(duration), 50), p90 = percentile(toLong(duration), 90),
    abandoned = countIf(user_action.complete_reason == "page_hide"),
    timeouts = countIf(user_action.complete_reason == "timeout"),
    slowInp = countIf(inp.status == "reported"),
  by: { appId = dt.rum.application.id, src = s, dst = d }
| sort sessions desc | limit 200`;

/**
 * The element the user was on when the action failed.
 *
 * Layout shift is attributed to the element that moved, so when abandonment and
 * a shifting element land on the same view this names the thing to fix. The
 * element's own text is masked by the privacy settings — the tag and the xpath
 * are what the platform exposes.
 */
export const qFriction = (tf: Timeframe, session?: string | null) => `
fetch user.events, from: ${tf.from}, to: ${tf.to}${onlySession(session)}
| filter characteristics.classifier == "user_action"
| filter user_action.complete_reason == "page_hide"
     or user_action.complete_reason == "timeout" or cls.value > 0.1
${norm(VIEW_NAME)}
| summarize actions = count(),
    abandoned = countIf(user_action.complete_reason == "page_hide"),
    timeouts = countIf(user_action.complete_reason == "timeout"),
    cls = avg(cls.value),
  by: { appId = dt.rum.application.id, view = v,
        tag = cls.ui_element.tag_name,
        xpath = arrayToString(cls.ui_element.xpath, delimiter: " > ") }
| filter abandoned > 0 or timeouts > 0
| sort abandoned + timeouts desc | limit 30`;

/** Device profiles (delivery chain layer 01). */
/**
 * Who consumed the application: every session attributed to its device and
 * origin.
 *
 * Attribution happens PER SESSION first, then rows are grouped. The old shape
 * grouped raw `view_summary` events, so a session that never emitted one — a
 * session still open, cut by the window edge, or request-only — was invisible
 * here while still being counted in the layer's own total. Measured on
 * Astroshop over 24h: 8,911 sessions shown against 11,910 real, a quarter of
 * the audience missing from the layer that exists to show the audience.
 */
export const qDevices = (tf: Timeframe, session?: string | null) => `
fetch user.events, from: ${tf.from}, to: ${tf.to}${onlySession(session)}
| summarize res = takeAny(concat(device.screen.width, "×", device.screen.height)),
    dpr = takeAny(toString(browser.window.device_pixel_ratio)),
    orient = takeAny(device.orientation),
    agent = takeAny(dt.rum.agent.type), utype = takeAny(dt.rum.user_type),
    views = countIf(characteristics.classifier == "view_summary"),
  by: { appId = dt.rum.application.id, sid = dt.rum.session.id }
| summarize sessions = count(), views = sum(views),
  by: { appId, res, dpr, orient, agent, utype }
| sort sessions desc | limit 20`;

/** Contacted domains (layer 02). */
export const qDomains = (tf: Timeframe) => `
fetch user.events, from: ${tf.from}, to: ${tf.to}
| filter characteristics.classifier == "request" and isNotNull(url.domain)
| summarize reqs = count(), p50 = percentile(toLong(duration), 50),
    err = countIf(toLong(http.response.status_code) >= 400),
    bytes = sum(toLong(performance.transfer_size)),
  by: { appId = dt.rum.application.id, domain = url.domain, provider = url.provider,
        utype = dt.rum.user_type, agent = dt.rum.agent.type }
| sort reqs desc | limit 160`;

/**
 * Users hit by errors, and the one session worth opening.
 *
 * "Users" is measured as sessions: this environment's RUM carries no user
 * identity — `dt.rum.browser.sid` is null on every event measured — so distinct
 * sessions is the honest count and the label must say sessions. The split by
 * real / robot / synthetic matters here because a demo tenant's impact is
 * mostly load generators, and 954 impacted robots is a different statement
 * from 954 impacted people.
 *
 * The second summarize keeps ONE exemplar — the session with the most errors,
 * via sort + takeFirst — with everything the session intents require:
 * `start_time` and `dt.rum.instance.id` (see SESSION_GEN3 / SESSION_CLASSIC
 * in intents.ts for the pairs and their verification).
 */
export const qImpacted = (tf: Timeframe, rumAppId: string) => `
fetch user.events, from: ${tf.from}, to: ${tf.to}
| filter dt.rum.application.id == "${rumAppId.replace(/["\\]/g, "")}"
| summarize errs = countIf(characteristics.classifier == "error"),
    st = min(start_time), inst = takeAny(dt.rum.instance.id),
    utype = takeAny(dt.rum.user_type),
    synth = countIf(isNotNull(dt.synthetic.monitor.id)),
  by: { sid = dt.rum.session.id }
| sort errs desc
| summarize sessions = count(), hit = countIf(errs > 0),
    // same "real" rule as qUxByApp — see the note there
    realSessions = countIf(not(utype == "robot") and not(utype == "synthetic") and synth == 0),
    hitReal = countIf(errs > 0 and not(utype == "robot")
      and not(utype == "synthetic") and synth == 0),
    hitRobot = countIf(errs > 0 and utype == "robot"),
    hitSynth = countIf(errs > 0 and (utype == "synthetic" or synth > 0)),
    exSid = takeFirst(sid), exStart = takeFirst(st),
    exInst = takeFirst(inst), exErrs = takeFirst(errs)`;

/**
 * The same impact measure, for every application at once — the overview's one
 * scan. Per-session first so "a session with errors" is counted once however
 * many errors it took, then per application. Same field caveats as qImpacted.
 */
export const qUxByApp = (tf: Timeframe) => `
fetch user.events, from: ${tf.from}, to: ${tf.to}
| summarize errs = countIf(characteristics.classifier == "error"),
    // Whose code failed. A third party's beacon dying degrades the page; the
    // application's own API returning 404 breaks the feature the user came
    // for — measured here, every error reaching easytrade's real users is the
    // second kind: 404s on its own /credit-card-order-service endpoints.
    // Third party is claimed only when the data SAYS so; unattributed counts
    // as our own, so nothing hides behind a null.
    errsThird = countIf(characteristics.classifier == "error"
      and (isNotNull(http.request.provider) or exception.file.provider == "third_party")),
    // Errors that reached a person, split the same way.
    views = countIf(characteristics.classifier == "view_summary"),
    acts = countIf(characteristics.classifier == "user_action"),
    aband = countIf(user_action.complete_reason == "page_hide"),
    // Apdex bands, counted on USER ACTIONS — the unit Dynatrace rates. An
    // action with no duration falls in none of the three, so it never inflates
    // the score by being treated as satisfied; see utils/apdex.ts for T.
    sat = countIf(characteristics.classifier == "user_action"
      and toLong(duration) <= ${APDEX_T_NS}),
    tol = countIf(characteristics.classifier == "user_action"
      and toLong(duration) > ${APDEX_T_NS} and toLong(duration) <= ${APDEX_4T_NS}),
    fru = countIf(characteristics.classifier == "user_action"
      and toLong(duration) > ${APDEX_4T_NS}),
    navs = countIf(characteristics.classifier == "navigation"),
    reqs = countIf(characteristics.classifier == "request"),
    utype = takeAny(dt.rum.user_type),
    synth = countIf(isNotNull(dt.synthetic.monitor.id)),
  by: { appId = dt.rum.application.id, sid = dt.rum.session.id }
| filter isNotNull(appId) and appId != "" and not(startsWith(appId, "APPLICATION-"))
| summarize sessions = count(), hit = countIf(errs > 0),
    // "Real" is anything not positively identified as a robot or a monitor —
    // an unlabelled session counts as a person, so an unknown never buys the
    // application a quieter verdict than it deserves.
    realSessions = countIf(not(utype == "robot") and not(utype == "synthetic") and synth == 0),
    hitReal = countIf(errs > 0 and not(utype == "robot")
      and not(utype == "synthetic") and synth == 0),
    hitRobot = countIf(errs > 0 and utype == "robot"),
    hitSynth = countIf(errs > 0 and (utype == "synthetic" or synth > 0)),
    engaged = countIf(views >= 2),
    actions = sum(acts), abandoned = sum(aband),
    errors = sum(errs), errorsThird = sum(errsThird),
    // errors carried by sessions belonging to real people
    realErrors = sum(if(not(utype == "robot") and not(utype == "synthetic")
      and synth == 0, errs, else: 0)),
    satisfied = sum(sat), tolerating = sum(tol), frustrated = sum(fru),
    fragments = countIf(navs == 0 and views == 0 and acts == 0 and reqs == 0),
  by: { appId }`;

/** Sessions and errors over time, for the landing page's trend chart. */
export const qPulseSeries = (tf: Timeframe, rumAppId: string) => `
fetch user.events, from: ${tf.from}, to: ${tf.to}
| filter dt.rum.application.id == "${rumAppId.replace(/["\\]/g, "")}"
| summarize sessions = countDistinct(dt.rum.session.id),
    errors = countIf(characteristics.classifier == "error"),
    actions = countIf(characteristics.classifier == "user_action"),
    requests = countIf(characteristics.classifier == "request"),
  by: { t = bin(start_time, ${binFor(tf.minutes)}) }
| sort t asc`;

/**
 * Every breakdown of the classic app overview, in ONE scan: grouped by the
 * full dimension tuple (a session carries one OS, one device, one version,
 * one country, so the tuple cardinality stays small) and rolled up per
 * dimension client-side. App starts ride along for the KPI band.
 */
export const qPulseBreakdown = (tf: Timeframe, rumAppId: string) => `
fetch user.events, from: ${tf.from}, to: ${tf.to}
| filter dt.rum.application.id == "${rumAppId.replace(/["\\]/g, "")}"
| summarize sessions = countDistinct(dt.rum.session.id),
    errors = countIf(characteristics.classifier == "error"),
    starts = countIf(characteristics.classifier == "app_start"),
    actions = countIf(characteristics.classifier == "user_action"),
    requests = countIf(characteristics.classifier == "request"),
    reqfail = countIf(characteristics.classifier == "request"
      and toLong(http.response.status_code) >= 400),
    exceptions = countIf(error.type == "exception"),
  by: { os = os.name, osv = os.version, man = device.manufacturer,
        model = device.model.identifier, ver = app.short_version,
        cc = geo.country.iso_code, ut = dt.rum.user_type }
| limit 500`;

/** Most requested paths (layers 04/05). */
export const qPaths = (tf: Timeframe) => `
fetch user.events, from: ${tf.from}, to: ${tf.to}
| filter characteristics.classifier == "request" and isNotNull(url.path)
| summarize reqs = count(), p50 = percentile(toLong(duration), 50),
    p90 = percentile(toLong(duration), 90),
  by: { appId = dt.rum.application.id, path = url.path,
        method = http.request.method, status = http.response.status_code }
| filter isNotNull(appId)
| sort reqs desc | limit 80`;

/** Browser and transport protocol (layers 01/02). */
export const qTransport = (tf: Timeframe) => `
fetch user.events, from: ${tf.from}, to: ${tf.to}
| filter characteristics.classifier == "request"
| summarize reqs = count(), ttfb = percentile(toLong(web_vitals.time_to_first_byte), 50),
  by: { browser = browser.name, protocol = performance.next_hop_protocol, provider = url.provider }
| sort reqs desc | limit 15`;

/* ─────────────── Smartscape ─────────────── */

/** Service-to-service call graph — the backbone of the delivery chain. */
export const qServiceCalls = () => `
smartscapeEdges "calls"
| filter source_type == "SERVICE" and target_type == "SERVICE"
| lookup [smartscapeNodes "SERVICE" | fields id, name], sourceField: source_id, lookupField: id, prefix: "s_"
| lookup [smartscapeNodes "SERVICE" | fields id, name], sourceField: target_id, lookupField: id, prefix: "t_"
| fields srcId = source_id, src = s_name, dstId = target_id, dst = t_name
| limit 400`;

/** Pod-to-node placement (layers 06/07). */
export const qRuntime = () => `
smartscapeEdges "runs_on"
| filter source_type == "K8S_POD" and target_type == "K8S_NODE"
// id_classic is the bridge between the two id spaces. Smartscape calls a pod
// K8S_POD-…; every classic app calls the same pod
// CLOUD_APPLICATION_INSTANCE-… and 404s on the Smartscape form. Carrying both
// is what lets a route open the pod instead of an error page.
| lookup [smartscapeNodes "K8S_POD" | fields id, name, id_classic], sourceField: source_id, lookupField: id, prefix: "p_"
| lookup [smartscapeNodes "K8S_NODE" | fields id, name, id_classic], sourceField: target_id, lookupField: id, prefix: "n_"
| fields podId = source_id, pod = p_name, podClassic = p_id_classic,
    nodeId = target_id, node = n_name, nodeClassic = n_id_classic
| limit 1000`;

/** Frontends registered in Smartscape. */
export const qFrontends = () => `smartscapeNodes "FRONTEND" | fields id, name | limit 100`;

/** Node count per type — used in the topology summary. */
export const qTopologyCounts = () => `
smartscapeNodes "*" | summarize nodes = count(), by: { type }
| filter in(type, {"SERVICE", "K8S_POD", "K8S_NODE", "K8S_CLUSTER", "K8S_NAMESPACE", "FRONTEND", "HOST"})
| sort nodes desc`;

/* ─────────────── Davis, alerts and extensions ─────────────── */

/** Active problems detected by the AI. */
export const qProblems = () => `
fetch dt.davis.problems, from: now()-24h
| filter event.status == "ACTIVE"
// Davis marks re-raised problems as duplicates of an original. Every example
// in the platform's own guidance drops them, and counting one incident twice
// would overstate the blast radius a route is meant to size. Measured on this
// tenant it currently changes nothing — 5 active problems, 5 distinct ids,
// none flagged — so this is a guard against a case that has not happened yet.
| filter not(dt.davis.is_duplicate)
| fields eventId = event.id, display_id, name = event.name, category = event.category,
    affected = affected_entity_types, entityIds = affected_entity_ids, start = event.start
| limit 50`;

/**
 * The backend an application actually reaches.
 *
 * Until now the chain's lower layers were environment-wide: switching
 * application changed the RUM layer and nothing else, which reads as a broken
 * filter. The link exists but is indirect — spans carry no application id (0 of
 * 1.6M measured), while RUM events carry `trace.id` (37.7k of 59.7k). So the
 * path is application → trace → span → service.
 *
 * Ten-minute window, fixed, and 300 traces sampled: membership in a topology is
 * not a fast-moving fact. Measured, 10m returns the same 12 services as 30m for
 * 0.36 GB against 1.06 GB — three times the spend for an identical answer. The
 * span side dominates either way, since a join reads the whole window whatever
 * the other side is filtered to.
 */
export const qAppServices = (rumAppId: string) => `
fetch user.events, from: now()-10m
| filter dt.rum.application.id == "${rumAppId.replace(/["\\]/g, "")}" and isNotNull(trace.id)
| summarize n = count(), by: { trace.id }
| limit 300
| join [ fetch spans, from: now()-10m | filter isNotNull(dt.entity.service)
         | summarize m = count(), by: { trace.id, svc = dt.entity.service } ],
    on: { trace.id }, fields: { svc }
| filter isNotNull(svc)
| summarize traces = countDistinctExact(trace.id), by: { svc }
// The name rides along from Smartscape (free): leaf services — the ones that
// only RECEIVE calls — appear in no call edge, so resolving their names from
// the calls table was silently dropping them from the chain.
| fieldsAdd sid = toSmartscapeId(svc)
| join [ smartscapeNodes "SERVICE" | fields id, nm = name ],
    on: { left[sid] == right[id] }, fields: { nm }
| fields svc, traces, name = nm
| sort traces desc
| limit 60`;

/**
 * Bridge #2, for classic RUM. A OneAgent-instrumented application carries
 * trace ids that are PurePaths — they exist in the classic engine and NOT in
 * Grail's spans table, so the trace join above finds nothing (measured: 88k
 * events with trace.id, zero span matches). The classic entity model still
 * knows the truth: `calls[dt.entity.service]` is the same relationship the
 * Service Flow screen draws. No volume comes with it, only membership.
 */
export const qAppServicesTopo = (rumAppId: string) => `
fetch dt.entity.application
| filter id == "APPLICATION-${rumAppId.replace(/["\\]/g, "").toUpperCase()}"
| expand svc = calls[dt.entity.service]
| join [ fetch dt.entity.service | fields id, nm = entity.name ],
    on: { left[svc] == right[id] }, fields: { nm }
| summarize name = takeAny(nm), by: { svc }
| fieldsAdd traces = 0
| limit 60`;

/** The mobile twin of the classic bridge — same relationship, other entity. */
export const qAppServicesTopoMobile = (entityId: string) => `
fetch dt.entity.mobile_application
| filter id == "${entityId.replace(/["\\]/g, "")}"
| expand svc = calls[dt.entity.service]
| join [ fetch dt.entity.service | fields id, nm = entity.name ],
    on: { left[svc] == right[id] }, fields: { nm }
| summarize name = takeAny(nm), by: { svc }
| fieldsAdd traces = 0
| limit 60`;

/**
 * What those services run on — pods, hosts, containers and processes.
 *
 * Smartscape, so this costs nothing: "runs_on" from a SERVICE resolves to all
 * four at once. That is what lets the runtime and infrastructure layers narrow
 * to the selected application without a second paid query.
 */
export const qServiceRuntime = (serviceIds: string[]) => `
smartscapeEdges "runs_on"
| filter ${serviceIds.slice(0, 60)
  // `in (…)` rejects function calls, so membership is spelled out
  .map((s) => `source_id == toSmartscapeId("${s.replace(/["\\]/g, "")}")`).join(" or ")}
| fieldsAdd target = target_id
| join [ smartscapeNodes "*" | fields id, nm = name, tp = type ],
    on: { left[target] == right[id] }, fields: { nm, tp }
| fields src = source_id, id = target, name = nm, type = tp
| limit 800`;

/**
 * The selected component's own vitals — latency percentiles, throughput and
 * failures — fetched on click, never up front: paying for 86 services to
 * answer a question about one is the mistake this app keeps refusing to make.
 * Fixed 30-minute window, said on the drawer's face, for the same cost reason
 * as the trace step.
 */
export const qSvcMetrics = (id: string) => `
fetch spans, from: now()-30m
| filter dt.entity.service == "${id.replace(/["\\]/g, "")}"
| summarize p50 = percentile(toLong(duration), 50), p90 = percentile(toLong(duration), 90),
    p95 = percentile(toLong(duration), 95), thr = count(),
    fails = countIf(request.is_failed == true)
| limit 1`;

export const qAppMetrics = (rumAppId: string) => `
fetch user.events, from: now()-30m
| filter dt.rum.application.id == "${rumAppId.replace(/["\\]/g, "")}"
| summarize
    p50 = percentile(if(characteristics.classifier == "view_summary", toLong(duration)), 50),
    p90 = percentile(if(characteristics.classifier == "view_summary", toLong(duration)), 90),
    p95 = percentile(if(characteristics.classifier == "view_summary", toLong(duration)), 95),
    thr = countIf(characteristics.classifier == "view_summary"),
    fails = countIf(characteristics.classifier == "error")
| limit 1`;

export const qDomMetrics = (rumAppId: string, domain: string) => `
fetch user.events, from: now()-30m
| filter dt.rum.application.id == "${rumAppId.replace(/["\\]/g, "")}"
    and characteristics.classifier == "request"
    and url.domain == "${domain.replace(/["\\]/g, "")}"
| summarize p50 = percentile(toLong(duration), 50), p90 = percentile(toLong(duration), 90),
    p95 = percentile(toLong(duration), 95), thr = count(),
    fails = countIf(toLong(http.response.status_code) >= 400)
| limit 1`;

/** Events per provider — separates Davis AI, custom alerts and extensions. */
export const qEventProviders = () => `
fetch dt.davis.events, from: now()-24h
| summarize events = count(), by: { type = event.type, provider = event.provider }
| sort events desc | limit 40`;

/** Every signal bound to the entity it actually affects — this is what lets
 *  alerts and extension events show up only under the related element. */
export const qSignalsByEntity = () => `
fetch dt.davis.events, from: now()-24h
/* OPEN signals only — the same event.status filter qProblems already uses.
 * Without it a baselining anomaly that closed twenty hours ago kept painting
 * its component amber, wearing a badge and counting on the Overview button:
 * the chain describes the CURRENT state, and a closed signal is history. */
| filter event.status == "ACTIVE"
| filter isNotNull(affected_entity_ids)
| expand entityId = affected_entity_ids
| summarize events = count(),
  by: { name = event.name, provider = event.provider, status = event.status,
        etype = event.type, entityId }
| sort events desc | limit 300`;

/** Custom alerts and extension ingests, by name. */
export const qCustomAlerts = () => `
fetch dt.davis.events, from: now()-24h
| filter event.provider == "METRIC_EVENTS" or event.provider == "EVENTS_REST_API_INGEST"
| summarize events = count(), by: { name = event.name, provider = event.provider, status = event.status }
| sort events desc | limit 40`;

/* ─────────────── helpers ─────────────── */

export const num = (v: unknown): number => (v == null ? 0 : Number(v));
export const fmtN = (n: number) => n.toLocaleString("en-US");
export const fmtK = (n: number) =>
  n >= 1000 ? (n / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 }) + "k" : fmtN(n);
/** ns → human-readable duration. */
export const fmtMs = (ns: number) => {
  const ms = ns / 1e6;
  if (ms >= 60000) return (ms / 60000).toLocaleString("en-US", { maximumFractionDigits: 1 }) + "min";
  if (ms >= 1000) return (ms / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 }) + "s";
  return Math.round(ms) + "ms";
};
/** View performance score: p50 ≤1s → 100 · ≥8s → 0. */
export const perfScore = (ns: number) =>
  Math.round(Math.min(100, Math.max(0, ((8000 - ns / 1e6) / 7000) * 100)));

/* ── card detail panels ─────────────────────────────────────────────────────
 * One query per card, run only when that card is opened. Each returns rows in
 * the same shape the panel draws: a name, a volume that sizes the bar, and the
 * numbers the card promises — p50/p90/p95 and failures.
 */

/**
 * User experience: the views users actually spend time in.
 *
 * Errors are counted alongside the actions, from the SAME scan, because the
 * row's drill-down depends on them: five of this application's eight busiest
 * views have none at all, and a click that opened an error page for those was
 * a click into an empty screen. The panel now knows before it offers.
 */
export const qDetailExperience = (tf: Timeframe, rumAppId: string) => `
fetch user.events, from: ${tf.from}, to: ${tf.to}
| filter dt.rum.application.id == "${rumAppId.replace(/["\\]/g, "")}"
    and (characteristics.classifier == "user_action"
      or characteristics.classifier == "error")
| summarize vol = countIf(characteristics.classifier == "user_action"),
    errors = countIf(characteristics.classifier == "error"),
    sessions = countDistinct(dt.rum.session.id),
    p50 = percentile(if(characteristics.classifier == "user_action", toLong(duration)), 50),
    p90 = percentile(if(characteristics.classifier == "user_action", toLong(duration)), 90),
    p95 = percentile(if(characteristics.classifier == "user_action", toLong(duration)), 95),
    sat = countIf(characteristics.classifier == "user_action"
      and toLong(duration) <= ${APDEX_T_NS}),
    tol = countIf(characteristics.classifier == "user_action"
      and toLong(duration) > ${APDEX_T_NS} and toLong(duration) <= ${APDEX_4T_NS}),
    fru = countIf(characteristics.classifier == "user_action"
      and toLong(duration) > ${APDEX_4T_NS}),
  by: { name = ${VIEW_NAME} }
| filter isNotNull(name) and name != "" and vol > 0
| sort vol desc | limit 8`;

/**
 * Errors: what is failing, once per KIND of failure.
 *
 * `error.name` carries the id of whatever the request was for, so one broken
 * endpoint arrived as hundreds of separate rows — 596 of them saying the same
 * thing about /orders/{id}/status/latest. replacePattern collapses the id and
 * the finding is stated once, with its true weight behind it. The pattern is
 * DPL, not a regex, and the replacement is POSITIONAL: with: is rejected.
 *
 * AN ERROR IS NOT ALWAYS NAMED. Measured on this tenant: all 25 errors of one
 * application carry a null error.name — HTTP 500s with no message and no url.
 * An earlier isNotNull(name) filter dropped every one of them, so the card
 * read "27 errors" while this panel read "nothing recorded". Nothing is
 * dropped now: what cannot be named by its own name is named by what it does
 * carry, which for those rows is "HTTP 500 · request".
 */
export const qDetailErrors = (tf: Timeframe, rumAppId: string) => `
fetch user.events, from: ${tf.from}, to: ${tf.to}
| filter dt.rum.application.id == "${rumAppId.replace(/["\\]/g, "")}"
    and characteristics.classifier == "error"
| fieldsAdd name = coalesce(
    replacePattern(error.name, "'/' INT '/'", "/{id}/"),
    exception.message,
    concat("HTTP ", toString(http.response.status_code), " · ", error.type),
    concat("unnamed ", error.type),
    "unnamed error")
| summarize vol = count(), sessions = countDistinct(dt.rum.session.id),
    real = countIf(not(dt.rum.user_type == "robot")
      and not(dt.rum.user_type == "synthetic")),
    third = countIf(isNotNull(http.request.provider)
      or exception.file.provider == "third_party"),
    // BOTH, and they are not interchangeable: these 404s are
    // error.type "request" with error.source "fetch". Sending the source
    // value inside the type property filtered the Error Inspector to
    // nothing — the property was right and the value was wrong.
    type = takeAny(error.type), src = takeAny(error.source),
    // records that carry a real error.name — the Error Explorer lists errors
    // BY name, so a row we had to name ourselves has nothing for it to show
    named = countIf(isNotNull(error.name)),
  by: { name }
| sort vol desc | limit 8`;

/**
 * Web requests per domain.
 *
 * Failures come from the ERROR events, not from status codes: measured on this
 * tenant, `request` records carry only 200 and 201 — every failed call is
 * filed as an error with source "fetch". Counting 4xx/5xx off the request
 * records returned 0 failures against 598 real ones.
 */
export const qDetailRequests = (tf: Timeframe, rumAppId: string) => `
fetch user.events, from: ${tf.from}, to: ${tf.to}
| filter dt.rum.application.id == "${rumAppId.replace(/["\\]/g, "")}"
    and (characteristics.classifier == "request"
      or (characteristics.classifier == "error" and error.source == "fetch"))
| summarize vol = countIf(characteristics.classifier == "request"),
    failures = countIf(characteristics.classifier == "error"),
    sessions = countDistinct(dt.rum.session.id),
    p50 = percentile(if(characteristics.classifier == "request", toLong(duration)), 50),
    p90 = percentile(if(characteristics.classifier == "request", toLong(duration)), 90),
    p95 = percentile(if(characteristics.classifier == "request", toLong(duration)), 95),
  by: { name = url.domain }
| filter isNotNull(name) and name != ""
| sort vol desc | limit 8`;

/**
 * Response time and failures for a set of services, in one metric-store read.
 *
 * The chain's per-node vitals scan spans, which is a Grail read per service;
 * this answers for every service at once from the metric store, where the
 * service forecasts already come from.
 *
 * UNIT: `dt.service.request.response_time` is in MICROseconds. Everything else
 * in this app formats nanoseconds, so the values are scaled here rather than
 * at each call site — verified against the same service measured both ways:
 * metric store 18,675 (µs) against spans 16,343,139 (ns), the same ~17ms.
 */
export const qServiceVitals = (tf: Timeframe, ids: string[]) => `
timeseries p50 = percentile(dt.service.request.response_time, 50),
    p90 = percentile(dt.service.request.response_time, 90),
    p95 = percentile(dt.service.request.response_time, 95),
    calls = sum(dt.service.request.count),
    fails = sum(dt.service.request.failure_count),
  from: ${tf.from}, to: ${tf.to}, interval: ${durStr(tf.minutes)},
  by: { dt.entity.service, dt.service.name },
  filter: { ${ids.slice(0, 40)
    .map((i) => `dt.entity.service == "${i.replace(/["\\]/g, "")}"`).join(" or ")} }
| fieldsAdd p50 = arrayFirst(p50) * 1000, p90 = arrayFirst(p90) * 1000,
    p95 = arrayFirst(p95) * 1000,
    calls = arrayFirst(calls), fails = arrayFirst(fails)
// the name is carried out of the SAME field the Services Explorer filters on,
// so the drill-down cannot be filtering by a name that field does not hold
| fields id = dt.entity.service, name = dt.service.name, p50, p90, p95, calls, fails
| limit 40`;

/**
 * The provider behind a host: instance, then zone.
 *
 * Validated against Smartscape Gen3 on this tenant before it became code:
 *
 *   HOST-34B959AE58123C71 (ip-172-31-10-60, 15 services)
 *     runs_on → AWS_EC2_INSTANCE-B1CFB55F52DF66F6
 *       runs_on → AWS_AVAILABILITY_ZONE  (use1-az4)
 *   HOST-696AF78FBB4E6F8B (gke-…)
 *     runs_on → GCP_COMPUTE_…_INSTANCE
 *       uses  → GCP_ZONE  (us-central1-b)
 *
 * TWO edge kinds on the second hop, not one: AWS places an instance with
 * runs_on, GCP with uses. Following only runs_on would have mapped every AWS
 * host and silently lost all of GCP — the same shape of mistake as reading
 * only K8S_POD placements.
 *
 * INSTANCE TYPES ARE NAMED EXACTLY, never matched by prefix. The first version
 * asked for anything containing AZURE_MICROSOFT_COMPUTE, which also matches
 * AZURE_MICROSOFT_COMPUTE_DISKS — three of them here — so a disk would have
 * been drawn as the machine a service runs on.
 *
 * COVERAGE, honestly: AWS and GCP are verified end to end against this tenant.
 * Azure is listed from its entity types and has NOT been observed carrying a
 * host, so it is written but unproven. Azure models VMs inside scale sets and
 * reaches a location rather than a zone, so its second hop may need its own
 * handling when a tenant with Azure hosts turns up.
 */
export const qCloudPlacement = (hostIds: string[]) => `
smartscapeEdges "runs_on"
| filter ${hostIds.slice(0, 40)
  .map((h) => `source_id == toSmartscapeId("${h.replace(/["\\]/g, "")}")`).join(" or ")}
| join [ smartscapeNodes "*" | fields id, tp = type, nm = name ],
    on: { left[target_id] == right[id] }, fields: { tp, nm }
| filter tp == "AWS_EC2_INSTANCE"
    or tp == "GCP_COMPUTE_GOOGLEAPIS_COM_INSTANCE"
    or tp == "AZURE_MICROSOFT_COMPUTE_VIRTUALMACHINES"
    or tp == "AZURE_MICROSOFT_COMPUTE_VIRTUALMACHINESCALESETS_VIRTUALMACHINES"
| fields host = source_id, instanceId = target_id, instanceType = tp, instanceName = nm
| join [ smartscapeEdges "*"
         | join [ smartscapeNodes "*" | fields id, zt = type, zn = name ],
             on: { left[target_id] == right[id] }, fields: { zt, zn }
         | filter contains(zt, "ZONE")
         | fields src = source_id, zoneId = target_id, zoneType = zt, zoneName = zn ],
    on: { left[instanceId] == right[src] },
    fields: { zoneId, zoneType, zoneName }
| limit 60`;

/**
 * The Databases app's entity behind a store address, when one exists.
 *
 * A store card is discovered from spans and carries an ADDRESS, while the
 * Gen3 Databases app (dynatrace.database.overview — read off this tenant's
 * registry) is keyed on DB_INSTANCE_* / DB_DATABASE_* smartscape ids. The
 * bridge is the name, and it was measured before it became a rule:
 *
 *   store ns  "TradeManagement"  == DB_DATABASE_MSSQL "TradeManagement"
 *   store     "easytrade-db"     ~  DB_INSTANCE_MSSQL "MSSQLSERVER@easytrade-db-0"
 *   rds hosts appear as          "host:5432" for a store address "host"
 *
 * So: exact name, or "@address" inside an instance name (the host half of
 * INSTANCE@HOST), or "address:" as its prefix. valkey/redis have no DB_*
 * node at all — the hook returns nothing and the route offers nothing,
 * rather than a filtered-looking page of everything.
 */
export const qDbEntity = (address: string, ns?: string) => {
  const a = address.replace(/["\\]/g, "");
  const n = (ns ?? "").replace(/["\\]/g, "");
  return `
smartscapeNodes "*"
| filter startsWith(type, "DB_INSTANCE_") or startsWith(type, "DB_DATABASE_")
| filter name == "${a}"${n ? ` or name == "${n}"` : ""}
    or contains(name, "@${a}") or startsWith(name, "${a}:")
| fields id, type, name
| limit 4`;
};

/**
 * The provider behind a serverless placement.
 *
 * A lambda-backed service produces no HOST, so the Cloud layer — born only
 * from hosts — never existed for it, and the chain ended at Run while the
 * platform knew better. Measured on guu84124: the AWS_LAMBDA_FUNCTION node
 * itself carries cloud.provider "aws", aws.region "us-east-1" and
 * aws.account.id — the whole Provider card, as node properties, no edge
 * needed. A region is not an availability zone, and the card says region.
 */
export const qLambdaPlacement = (fnIds: string[]) => `
smartscapeNodes "AWS_LAMBDA_FUNCTION"
| filter in(id, {${fnIds.slice(0, 40)
  .map((f) => `"${f.replace(/["\\]/g, "")}"`).join(",")}})
| fields fn = id, name, region = aws.region, account = aws.account.id
| limit 40`;

/**
 * The data stores this application's services talk to.
 *
 * NOT from Smartscape, and that was measured rather than assumed. On this
 * tenant Smartscape holds 14 AWS_RDS_DBINSTANCE and 36 AWS_DYNAMODB_TABLE
 * nodes and exactly ZERO edges from a service to any of them — the only edge
 * touching a store at all is an event-source mapping. A chain built on that
 * would draw databases for nobody.
 *
 * Spans do hold it, for every store and every cloud alike: `db.system` is on
 * the calling span, so one query finds mssql on `easytrade-db`, redis on
 * `valkey-cart`, dynamodb on `dynamodb.us-east-1.amazonaws.com` and mongoose
 * with no address at all — self-hosted and managed by the same rule, with no
 * per-provider list to keep up to date.
 *
 * And it arrives measured. A store node here is not a decorative box: it
 * carries the calls, the p50 and the p90 of the traffic the service sends it,
 * which is the reason to draw it.
 *
 * `rated` exists because failure is NOT measured on these spans — across
 * 36,430 database spans in a ten-minute window, `span.status_code` and
 * `request.is_failed` are null on every one. Counting errors would print a
 * confident "0 errors" that means "nobody told us". `rated` lets the card say
 * which of the two it is.
 *
 * Ten minutes, not the screen's window: this is a discovery query over raw
 * spans and the window is what it costs (0.08 GB at 10m). Who calls what does
 * not change within an hour.
 */
export const qServiceDataStores = (serviceIds: string[]) => `
fetch spans, from: now()-10m, to: now()
| filter isNotNull(db.system)
| filter ${serviceIds.slice(0, 40)
  .map((s) => `dt.entity.service == "${s.replace(/["\\]/g, "")}"`).join(" or ")}
| fieldsAdd store = coalesce(server.address, db.namespace, db.system)
| summarize calls = count(),
    rated = countIf(isNotNull(span.status_code)),
    errors = countIf(span.status_code == "ERROR"),
    p50 = percentile(duration, 50), p90 = percentile(duration, 90),
  by: { svc = dt.entity.service, store, sys = db.system, ns = db.namespace }
| sort calls desc
| limit 40`;

/**
 * What the CLASSIC topology says these services call — used only for what
 * Smartscape does not know.
 *
 * Measured on guu84124, on the easyTravel mainframe application, and this is
 * the whole reason it exists: Smartscape Gen3 draws seven services and six
 * `calls` edges between them, and stops. The classic entity model, over the
 * SAME entity ids, adds one more — `MF easyTravelBusiness`, a
 * DATABASE_SERVICE that BookingService, JourneyService and
 * AuthenticationService all call. Gen3 has no node for it and no edge to it.
 * The platform's own service flow has been showing it all along.
 *
 * No new scope and no classic API: `dt.entity.service` is the classic model
 * surfaced in Grail, so `storage:entities:read` — which this app already
 * holds — is enough. It carries the relationships as fields (`calls`,
 * `called_by`, `runs_on`, `sends_to`), and the ids are the same ones
 * Smartscape uses, so the two models join without translation.
 *
 * What it deliberately does NOT reach: the mainframe's message path.
 * `IBM MQ Queue Listener → DTMD on CICS → DBCG` is a connected chain in the
 * classic model too, but nothing in this application calls the listener, and
 * the queues (`CSQ8.creditcardrequest`, `CSQ8.creditcardresponse`) carry
 * `sends_to`, `receives_from`, `propagates_to` and `propagated_from` all
 * null. That hop lives in the PurePath, not in the entity model. Drawing it
 * would mean inventing the edge that would justify drawing it.
 */
export const qServicesGen2Calls = (serviceIds: string[]) => `
fetch dt.entity.service, from: now()-2h
| filter in(id, {${serviceIds.slice(0, 60)
  .map((s) => `"${s.replace(/["\\]/g, "")}"`).join(",")}})
| fields src = id, tgt = calls[dt.entity.service]
| filter isNotNull(tgt)
| expand tgt
| join [ fetch dt.entity.service, from: now()-2h
         | fields id, nm = entity.name, st = serviceType, ro = runs_on,
                  ext = isExternalService ],
    on: { left[tgt] == right[id] }, fields: { nm, st, ro, ext }
/* An EXTERNAL WEB service is the same code seen from its caller.
 *
 * The classic model describes one running process at more than one
 * granularity, and the walk finds every level. Measured on guu84124:
 *
 *   MF JourneyService                             WEB_SERVICE   external=false
 *   MF /services/JourneyService/ on port 8091     WEB_SERVICE   external=TRUE
 *   MF easyTravel Customer Frontend               WEB_REQUEST   external=false
 *   MF com.dynatrace…frontend.jar …:8280          WEB_REQUEST   external=TRUE
 *
 * Each pair is one thing, once as the service and once as the endpoint a
 * caller dialled — and drawing both put a box named after a jar and a port
 * beside every real service.
 *
 * The external flag alone would not do: MF easyTravelBusiness is external
 * too, and it is exactly the component this whole fallback exists to find.
 * The difference is that it is not a WEB service — it is a database, and a
 * queue listener or a CICS region would be the same. An external web hop into
 * something monitored is already in the chain under its own name; into
 * something unmonitored it is a third-party address, which the Transport
 * layer already counts.
 *
 * NOT the process: five of this application's services share one
 * PROCESS_GROUP_INSTANCE, so "same process" would have collapsed the whole
 * business tier into one box. Tried, measured, discarded.
 */
| filter ext != true or not(in(st, { "WEB_SERVICE", "WEB_REQUEST_SERVICE" }))
| fields src, id = tgt, name = nm, kind = st, host = ro[dt.entity.host]
| limit 80`;

/**
 * A service's vitals from the METRIC STORE, for services that have no spans.
 *
 * The drawer reads spans, which is right for anything OneAgent traces into
 * Grail — and wrong for everything else. Measured on guu84124: `MF
 * easyTravelBusiness` has zero spans, so the tiles printed p50 0ms, p90 0ms,
 * throughput 0 for a service the metric store shows serving 17, 280 and 60
 * requests in consecutive minutes at 4.7ms, 0.3ms and 3.9ms. A confident zero
 * for a service that is plainly working.
 *
 * Same fallback rule as the topology: when the first source has nothing, ask
 * the second before concluding. This one is free — the metric store scans no
 * bytes — and it reports MICROseconds, scaled here to the nanoseconds the rest
 * of the app speaks.
 *
 * No percentile split: the store keeps an average, so p50/p90/p95 would be one
 * number printed three times. The caller shows the average as what it is.
 */
export const qSvcMetricsFallback = (id: string) => `
timeseries { rt = avg(dt.service.request.response_time),
             ct = sum(dt.service.request.count),
             fl = sum(dt.service.request.failure_count) },
  from: now()-30m,
  filter: { dt.entity.service == "${id.replace(/["\\]/g, "")}" }
| fieldsAdd avgNs = arrayAvg(rt) * 1000, calls = arraySum(ct), fails = arraySum(fl)
| fields avgNs, calls, fails
| limit 1`;

/**
 * Applications the inventory knows and RUM did not report on — with the
 * backend the CLASSIC model says each one calls.
 *
 * The selector is built from `user.events`, which is right for anything
 * sending RUM to Grail and silently wrong for everything else. Measured on
 * guu84124: `easyTravel Mobile (mainframe)` has ZERO events in seven days,
 * so it could never be listed — while the platform's own service flow drew
 * its whole backend, mainframe included. `easyTravel Mobile` has 375 events
 * in 24h and simply falls out of a two-hour window.
 *
 * `calls` is the gate, not a decoration: an application enters this list only
 * because the classic model can show a chain for it. One with no RUM AND no
 * backend has nothing to draw, and listing it would be offering an empty
 * screen — the defect this project keeps hunting, in a new place.
 */
export const qAppsGen2 = () => `
fetch dt.entity.application, from: now()-2h
| fields id, name = entity.name, seed = calls[dt.entity.service]
| append [ fetch dt.entity.mobile_application, from: now()-2h
           | fields id, name = entity.name, seed = calls[dt.entity.service] ]
| filter isNotNull(seed)
| limit 200`;

/**
 * The services one application calls, straight from the classic model.
 *
 * Used as the scope's seed when neither the trace join nor Smartscape found
 * anything — the third source, asked last. Verified on
 * MOBILE_APPLICATION-773D0C09E8E14B58: the seed is `MF EasyTravelWebserver:9079`,
 * and walking `calls` from there reaches MF EasytravelService,
 * ConfigurationService, BookingService, JourneyService, VerificationService,
 * AuthenticationService, CheckDestination and MF easyTravelBusiness — the
 * service flow's own picture, rebuilt from the entity model.
 */
export const qAppSeedGen2 = (entityId: string) => {
  const e = entityId.replace(/["\\]/g, "");
  return `
fetch dt.entity.application, from: now()-2h
| filter id == "${e}"
| fields id, seed = calls[dt.entity.service]
| append [ fetch dt.entity.mobile_application, from: now()-2h
           | filter id == "${e}"
           | fields id, seed = calls[dt.entity.service] ]
| filter isNotNull(seed)
| expand seed
| join [ fetch dt.entity.service, from: now()-2h | fields id, nm = entity.name ],
    on: { left[seed] == right[id] }, fields: { nm }
| fields svc = seed, name = nm
| limit 40`;
};

/**
 * Sessions per application and per origin — the Consume layer's own query.
 *
 * It used to read the device-profile rows, and those are a TOP-20 over the
 * whole environment: grouped by application AND resolution AND pixel ratio AND
 * orientation, twenty rows is a handful of the busiest applications. Measured
 * on guu84124 — 248 profile rows across 14 applications, and the top twenty
 * covered seven of them. easyTravel mainframe has 26 profile rows and 431
 * sessions, none of which reach the cut, so its Consume layer drew "No
 * coverage" while the Sessions app listed 281 of them with their browsers.
 *
 * A top-N is the right shape for a table that says "the busiest profiles" and
 * the wrong shape for "who consumes this application". So the breakdown the
 * layer needs gets its own query, grouped only by origin: at most four rows
 * per application, which no limit can truncate.
 *
 * `profiles` is carried so the cards keep what the profile rows used to
 * give them — how many distinct screens an origin brought.
 */
export const qOrigins = (tf: Timeframe, session?: string | null) => `
fetch user.events, from: ${tf.from}, to: ${tf.to}${onlySession(session)}
| summarize agent = takeAny(dt.rum.agent.type), utype = takeAny(dt.rum.user_type),
    res = takeAny(concat(device.screen.width, "×", device.screen.height)),
    views = countIf(characteristics.classifier == "view_summary"),
  by: { appId = dt.rum.application.id, sid = dt.rum.session.id }
| summarize sessions = count(), views = sum(views),
    profiles = countDistinct(res),
  by: { appId, agent, utype }
| filter isNotNull(appId) and appId != ""
| sort sessions desc
| limit 200`;
