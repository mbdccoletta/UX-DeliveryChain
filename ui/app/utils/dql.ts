// Data layer — every query here was validated against a live estate
// before it became code.
import { queryExecutionClient } from "@dynatrace-sdk/client-query";
import { FC_HIST_CAP_MIN, histWindow } from "./forecast";
import { CLICK_SCAN_BUDGET_GIB, isScanLimit, noteScan, noteScanStart, OPTIONAL_SCAN_BUDGET_GIB, pageBudgetMs } from "./cost";

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
 * absolute timestamp, which DQL accepts quoted (verified on a live estate).
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
export function binMinutesFor(minutes: number): number {
  const target = minutes / 34;
  const CHOICES = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440];
  return CHOICES.find((c) => c >= target) ?? 1440;
}

export function binFor(minutes: number): string {
  return durStr(binMinutesFor(minutes));
}

/** Runs DQL, polling until the result is ready. */
/* ONE QUERY, ONE SCAN — however many callers ask for it.
 *
 * Measured on a production load: four queries were executed TWICE within two
 * seconds of each other, including the two heaviest. Nothing in the app asks
 * for the same thing twice on purpose; it happens because a memo key firms up
 * late — a frontend name resolving, an application id landing in the url —
 * and the hook that depends on it re-asks a question already in flight. The
 * hooks cannot see each other, so the dedupe belongs here, where the question
 * itself is visible.
 *
 * Keyed on the query text and the row cap, which together ARE the question.
 * A second caller gets the first caller's promise and its previews; the scan
 * is counted, billed and polled once. The entry is dropped as soon as it
 * settles, so this is a dedupe of concurrent work, never a cache — a later
 * ask of the same question still re-measures, which is what every caller's
 * own memo is for.
 */
const inFlightDql = new Map<string, {
  p: Promise<unknown[]>;
  subs: Array<(rows: unknown[]) => void>;
  /* a joined caller is told what the scan cost too — runSized sizes a window
     from it, and a joiner that heard "0 bytes" would read the window whole */
  metas: Array<NonNullable<DqlOptions["onMeta"]>>;
  /* …and that it was cut short: a joiner whose own result is cached would
     otherwise store a truncated answer as whole */
  truncs: Array<() => void>;
}>();

/** THE HARD CEILING (0.17.42). No query this app sends may read more than
 *  this, whatever its window or fallback: the platform's own scan limit,
 *  sent with every execute. ≈25 GiB (the optional-read budget), in the GB the
 *  API counts. A query that hits it comes back partial and says so (the
 *  scan-limit notification feeds the partial-data banner). */
export const SCAN_LIMIT_GB = 27;

export interface DqlOptions {
  /** Override the ceiling for this query, in GB (rarely: never upwards). */
  scanLimitGb?: number;
  /**
   * Retained for call-site compatibility; it no longer changes behaviour.
   * There was, for a few versions, a mode that let a query SETTLE on a
   * preview that had come back identical on consecutive polls, cancelling
   * the scan behind it. It was removed on a data-integrity rule: a preview
   * is the answer over a PARTIAL scan — for a count, a floor — and stability
   * between two polls does not prove completeness. A figure that might be
   * low must never be the figure, however it is labelled. Every query now
   * runs to its final answer; previews only let the screen paint sooner.
   */
  settle?: boolean;
  /** What the query cost once it finished — Grail's own scanned bytes and
   *  execution time, and the wall time this client waited. Used by the
   *  comparison panel; nothing that decides a figure reads it. */
  onMeta?: (m: { scannedBytes: number; execMs: number; elapsedMs: number }) => void;
}

export function runDql<T = Record<string, unknown>>(
  query: string,
  maxResultRecords = 200,
  onTruncated?: () => void,
  onPartial?: (rows: T[]) => void,
  opts: DqlOptions = {},
): Promise<T[]> {
  const key = `${maxResultRecords}\u0000${query}`;
  const hit = inFlightDql.get(key);
  if (hit) {
    if (onPartial) hit.subs.push(onPartial as (rows: unknown[]) => void);
    if (opts.onMeta) hit.metas.push(opts.onMeta);
    if (onTruncated) hit.truncs.push(onTruncated);
    return hit.p as Promise<T[]>;
  }
  const subs: Array<(rows: unknown[]) => void> = [];
  if (onPartial) subs.push(onPartial as (rows: unknown[]) => void);
  const metas: Array<NonNullable<DqlOptions["onMeta"]>> = opts.onMeta ? [opts.onMeta] : [];
  const truncs: Array<() => void> = onTruncated ? [onTruncated] : [];
  const p = runDqlOnce<T>(query, maxResultRecords, () => {
    for (const f of truncs) { try { f(); } catch { /* never break a fetch */ } }
  }, (rows) => {
    for (const f of subs) { try { f(rows as unknown[]); } catch { /* a draw must never break a fetch */ } }
  }, { ...opts, onMeta: (m) => { for (const f of metas) { try { f(m); } catch { /* never break a fetch */ } } } })
    .finally(() => { inFlightDql.delete(key); });
  inFlightDql.set(key, { p: p as Promise<unknown[]>, subs, metas, truncs });
  return p;
}

async function runDqlOnce<T = Record<string, unknown>>(
  query: string,
  maxResultRecords = 200,
  /**
   * Called when THIS query came back from a partial scan.
   *
   * cost.ts keeps a page-wide counter for the banner, which is right for a
   * banner and wrong for anything that needs to know about its OWN data: it
   * is sticky, it includes every unrelated drill-down, and a cached payload
   * stamped from it inherits somebody else's truncation. A caller that stores
   * or caches a result needs the fact for that result, so it can ask for it.
   */
  onTruncated?: () => void,
  /**
   * Called with PARTIAL rows while the query is still running, whenever the
   * platform has a preview to give. May fire several times, always with the
   * best answer so far, and is always followed by the real return value.
   * Callers that take it must say on screen that the figure is not final.
   */
  onPartial?: (rows: T[]) => void,
  opts: DqlOptions = {},
): Promise<T[]> {
  noteScanStart();
  /* PREVIEW RESULTS: THE PLATFORM OFFERS THEM AND WE WERE NOT ASKING.
   *
   * Measured on a bank's production tenant: a scoped two-hour scan of one
   * large application takes 20 to 30 seconds, and the page had nothing to
   * show for the whole of it. `enablePreview` is documented as returning a
   * partial answer as part of the response whenever one is available inside
   * the request timeout — so the cost of not asking was a blank screen for
   * half a minute while the platform already had numbers in hand.
   *
   * It changes the contract: a caller can be handed a figure that is REAL
   * but not yet whole. Nothing is drawn as final on that basis — onPartial
   * is opt-in, and the hooks that take it mark what they show as still
   * measuring. A number that firms up in front of the reader is honest; a
   * partial number wearing a final number's clothes is the one thing this
   * app refuses to do. */
  /* THE EXECUTE RETURNS FAST SO THE DEADLINE BELOW CAN GOVERN. At 30s a
     query with no early preview could block the whole budget inside this one
     call. At four seconds it comes back RUNNING, and the loop — which owns
     the clock — takes over. */
  const started = Date.now();
  /* THE PAGE'S REMAINING BUDGET CAPS THIS QUERY. During the first load every
     query shares the page's ten seconds: a query that starts at t+6 has four
     left, not eight. Once the load's budget has elapsed, a query is a user
     interaction and gets the per-query bound on its own — a drill opened a
     minute later must not fail on sight. */
  const pageLeft = pageBudgetMs();
  const HARD_DEADLINE_MS = pageLeft == null ? 8000 : Math.max(1200, Math.min(8000, pageLeft - 500));
  let res = await queryExecutionClient.queryExecute({
    body: {
      query, requestTimeoutMilliseconds: Math.min(4000, HARD_DEADLINE_MS), maxResultRecords,
      enablePreview: true, defaultScanLimitGbytes: opts.scanLimitGb ?? SCAN_LIMIT_GB,
    } as never,
  });
  /* The execute itself can come back with a preview attached. */
  if (onPartial && res.state !== "SUCCEEDED") {
    const early = (res.result?.records ?? []) as T[];
    if (early.length) { try { onPartial(early); } catch { /* a draw must never break a fetch */ } }
  }
  /* THE TOKEN COMES FROM THE EXECUTE, AND ONLY FROM IT.
   *
   * This polled with `res.requestToken` — the token off the LATEST response.
   * The execute carries one; a poll response does not have to, and on a busy
   * estate it does not. So the first poll worked and the second sent
   * undefined, and the platform answered:
   *
   *   Constraint Violations. errorMessage: "request-token: Required request
   *   parameter 'request-token' for method parameter type String is not
   *   present"
   *
   * Every environment this app was built against answered inside the first
   * poll, so the loop never ran twice and the bug could not appear. A
   * production estate is the first place where a query takes long enough —
   * and there it kills whichever query is slowest, which reads as "that
   * query needs a scope" rather than as a defect in the runner.
   *
   * The token is captured once. The poll count is bounded too: an unbounded
   * wait on a query that never finishes is a page that never loads, which is
   * exactly what a large estate was showing. */
  const token = res.requestToken;
  /* THE POLL BACKS OFF, because the preview already answered.
   *
   * At a flat 400ms a thirty-second query costs seventy-five round trips, and
   * a production page load spent 391 of them — all on the same connection as
   * the queries still being issued, and each one about half a second of
   * latency in its own right. That cadence was buying responsiveness the app
   * no longer needs from polling: the preview puts numbers on screen in a few
   * seconds, so what is left to wait for is the FINAL figure, which nobody is
   * staring at a spinner for.
   * Quick at first, because most queries finish almost at once; slower after,
   * where the only cost of waiting is a number firming up a second later. */
  const waitFor = (i: number) => (i < 6 ? 400 : 800);
  const MAX_POLLS = 60;
  /* SETTLING ON A STABLE PREVIEW — the definitive answer to "still slow".
   *
   * Measured on a bank's production application: with previews, every
   * query had real rows on screen inside two seconds — and then polled for
   * another fifty while the figure did not move, because the final answer
   * of a per-session scan over millions of sessions is simply slow to
   * compute. Sixty-seven of a page's seventy seconds were the server
   * finishing work whose result the reader already had. And the platform
   * finishes — and bills — that scan whether or not anyone is still waiting.
   *
   * So a caller that opts in gets this rule: once a preview has come back
   * IDENTICAL on consecutive polls, and enough time has passed that the
   * sameness is not an accident of two polls landing on one checkpoint, the
   * preview is the answer. The scan is cancelled on the server, so the bytes
   * it would still have read are not read and not charged. The rows are
   * marked, so the screen can say "preview" rather than claiming a final.
   *
   * Opt-in only. The Overview takes it — it is a summary, and a summary that
   * is stable to the last poll is a summary. A drill-down does not: opening
   * a table is an explicit "measure this", and it measures to the end. */
  /* THE PAGE'S TEN SECONDS GOVERN THE CADENCE, NEVER THE ANSWER.
   *
   * Inside the budget the loop polls quickly, so a final that is ready lands
   * at once and a preview reaches the screen the moment Grail has one. Past
   * it, the loop is patient: whatever is still running will be a late final
   * replacing a marked preview, and nobody is staring at a spinner for it.
   * Nothing is cancelled on the clock. The only cancel is the runaway guard
   * at MAX_POLLS, for a query that will never answer. */
  for (let i = 0; res.state === "RUNNING" || res.state === "NOT_STARTED"; i++) {
    if (!token) { noteScan(0); throw new Error("DQL started with no request token"); }
    if (i >= MAX_POLLS) {
      try { await queryExecutionClient.queryCancel({ requestToken: token }); } catch { /* best effort */ }
      noteScan(0);
      throw new Error("DQL still running after two minutes — narrow the window or the scope");
    }
    const elapsed = Date.now() - started;
    const past = elapsed >= HARD_DEADLINE_MS;
    await new Promise((r) => setTimeout(r, past ? 1500 : Math.min(waitFor(i), Math.max(50, HARD_DEADLINE_MS - elapsed))));
    res = await queryExecutionClient.queryPoll({ requestToken: token });
    // a poll can carry a better preview than the last one — it paints, it decides nothing
    if (onPartial && res.state !== "SUCCEEDED") {
      const partial = (res.result?.records ?? []) as T[];
      if (partial.length) { try { onPartial(partial); } catch { /* never break the fetch */ } }
    }
  }
  if (res.state !== "SUCCEEDED") { noteScan(0); throw new Error(`DQL ${res.state}`); }
  /* What this query cost — and whether Grail finished it. A fetch stopped at
   * the 500 GB scan limit still returns SUCCEEDED; the only sign is a WARNING
   * in the metadata, and a number computed from half the data must never be
   * presented as a measurement. */
  const grail = (res.result as unknown as {
    metadata?: { grail?: { scannedBytes?: number;
      notifications?: Array<{ message?: string; severity?: string }> } } })
    ?.metadata?.grail;
  const notes = grail?.notifications ?? [];
  const cut = notes.some((n) => isScanLimit(n?.message));
  /* WHAT THIS QUERY READ, in four words, derived from the query itself so no
     call site has to be told. The source is most of the cost story, and
     whether it was scoped to one application is the rest. */
  const src = /fetch\s+([a-z0-9._]+)/i.exec(query)?.[1]
    ?? (/^\s*timeseries/i.test(query) ? "metrics"
      : /smartscape(Nodes|Edges)/i.test(query) ? "smartscape" : "query");
  const scoped = /dt\.rum\.application\.id\s*==/.test(query)
    || /frontend\.name/.test(query) || /dt\.entity\.service\s*==/.test(query);
  noteScan(Number(grail?.scannedBytes ?? 0), cut,
    `${src}${scoped ? " · one app" : " · estate"}`);
  try {
    opts.onMeta?.({ scannedBytes: Number(grail?.scannedBytes ?? 0),
      execMs: Number((grail as { executionTimeMilliseconds?: number } | undefined)?.executionTimeMilliseconds ?? 0),
      elapsedMs: Date.now() - started });
  } catch { /* a readout never breaks a fetch */ }
  if (cut) onTruncated?.();
  const rows = (res.result?.records ?? []) as T[];
  /* A WARNING PLUS AN EMPTY ANSWER IS NOT AN ANSWER.
   *
   * The platform reports some faults as notifications, not errors: the query
   * state comes back SUCCEEDED and the records come back empty. Measured on a
   * live estate — `in(trace.id, {"…"})` against a uid column answers
   *   "Using `in`, needle and haystack have to be of same type.
   *    The needle was a uid, but should be a string."
   * with zero rows and no error. The chain drew that as "no trace reaches a
   * service" for every application: a claim about the customer's topology
   * manufactured by a type mismatch.
   *
   * Zero rows on their own are a legitimate finding and stay one. Zero rows
   * WITH a warning are a defect, and this throws so the caller's error path
   * shows it instead of the screen inventing a fact. The scan-limit warning is
   * excluded: it already has its own, louder treatment. */
  const suspect = rows.length === 0 && notes.find((n) =>
    (n?.severity === "WARN" || n?.severity === "ERROR") && !isScanLimit(n?.message));
  if (suspect) {
    throw new Error(`DQL returned nothing and warned: ${suspect.message ?? "unspecified"}`);
  }
  return rows;
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

/**
 * Narrows a RUM scan to one application, when the caller knows which one.
 *
 * Empty string when it does not — the estate-wide form is still correct, and
 * is what the picker itself needs before an application has been chosen.
 */
export const scopeApp = (rumAppId?: string | null) =>
  rumAppId ? `\n| filter dt.rum.application.id == "${String(rumAppId).replace(/["\\]/g, "")}"` : "";

/**
 * SCOPED ONCE THERE IS A CHOICE.
 *
 * This is the estate's own census: every application, with the sessions,
 * views, errors and percentiles the window holds. The picker was built from
 * it, which is why it had to read everything — and measured on a bank's
 * production tenant, the estate-wide RUM scans were 918 GB of a 1.12 TB page.
 *
 * The picker is built from Smartscape now (a topology read: 0 bytes scanned,
 * measured), so this query no longer has to answer for applications nobody is
 * looking at. It stays estate-wide for the first load, when there is nothing
 * to scope to and the busiest application is what decides the default.
 */
/** EXACT WHERE THE PLATFORM ALLOWS IT. countDistinctExact has an element
 *  limit: on a production estate (~5M sessions an hour) the census failed
 *  with UDF_ELEMENT_LIMIT_WITH_ALTERNATIVE and the verdict waited forever.
 *  Under the limit the count is exact; over it the caller re-asks with the
 *  estimate at its highest precision (16: ~0.4% standard error) and the
 *  screen says the total is estimated. */
export const distinctFn = (exact: boolean) => (x: string) =>
  exact ? `countDistinctExact(${x})` : `countDistinct(${x}, precision: 16)`;
/** True when a query failed on the exact-count element limit. */
export const isExactLimit = (e: unknown) =>
  /UDF_ELEMENT_LIMIT/i.test(e instanceof Error ? e.message : String(e));

export const qApps = (tf: Timeframe, session?: string | null,
  rumAppId?: string | null,
  /** Scoped only: false re-asks with the precision-16 estimate after the
   *  exact count hit the platform's element limit (see distinctFn). */
  exact = true) => `
fetch user.events, from: ${tf.from}, to: ${tf.to}${onlySession(session)}${scopeApp(rumAppId)}
// EXACT ONCE SCOPED (0.16.0). Scoped to one application this is the
// verdict's denominator — sessions and real people's sessions — and a
// stochastic estimate is about 1% off at production scale. The estate-wide
// discovery pass only ranks applications, so it keeps the estimate.
| summarize sessions = ${rumAppId && exact ? "countDistinctExact" : "countDistinct"}(dt.rum.session.id${rumAppId && !exact ? ", precision: 16" : ""}),
    realSessions = ${rumAppId && exact ? "countDistinctExact" : "countDistinct"}(if(coalesce(dt.rum.user_type, "") != "robot"
      and coalesce(dt.rum.user_type, "") != "synthetic" and isNull(dt.synthetic.monitor.id),
      dt.rum.session.id, else: null)${rumAppId && !exact ? ", precision: 16" : ""}),
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
 * Names for every kind of RUM application, not just web.
 *
 * SMARTSCAPE, not the classic model: a Playground/dev estate answers
 * `fetch dt.entity.application` with UNKNOWN_DATA_OBJECT ("isn't a valid data
 * object") and every application on screen fell back to "Application 656efe54"
 * — the classic objects are being retired. One FRONTEND node type replaces all
 * three classic ones (application, mobile_application, custom_application) and
 * is strictly better here: it carries `id_classic` for the entity joins the
 * chain already does AND `dt.rum.instrumentation.id`, which IS
 * `dt.rum.application.id`. That makes the MOBILE join exact — the classic path
 * had to guess it from a UUID's first half.
 */
export const qAppNames = () => `
smartscapeNodes "FRONTEND"
// frontend.type ("web" | "mobile") is the platform's OWN classification —
// the picker used to infer it from a MOBILE_APPLICATION- id prefix and, when
// dt.rum.application.entity came back null (measured on a live estate), filed a
// native Android app under "Web".
| fields id = id_classic, name, rumId = dt.rum.instrumentation.id,
    kind = frontend.type
/* Sized for a real estate. At 400 — and a 200-row client cap on top of it —
   a production tenant's application came back unnamed and the picker showed
   "Application 1a2b3c4d". Smartscape scans no Grail bytes, so the only cost
   of a higher ceiling is the rows themselves. */
| limit 2000`;

/**
 * The sessions store's own name for each application.
 *
 * Users & Sessions' `Frontends` facet filters on `frontend.name` from
 * user.sessions — NOT the inventory name qAppNames reads. The two differ
 * ("Astroshop Android" the entity, "Astroshop_Android" the frontend), and a
 * Frontends chip carrying the inventory name is ACCEPTED and matches nothing:
 * the reader's drilldown came back "No results found" with every chip applied.
 * Fixed 24h window on purpose — the mapping is a property of the app, not of
 * the timeframe, and user.sessions is a small store (134k rows/24h measured
 * on a live estate, 2026-08-25).
 */
/**
 * THE NUMBER THE SESSIONS LIST WILL SHOW.
 *
 * The card counts sessions from `user.events` — every session with an event
 * in the window — and the hand-off opens Users & Sessions, which reads
 * `user.sessions`. Two stores, two populations: 426 against 180 on a live
 * estate, and a reader comparing them reads a defect, because explaining a
 * gap is not the same as not having one.
 *
 * So the card asks the OTHER store for its own figure and prints it beside
 * the first. Both numbers are then true, both are on screen, and the one the
 * button opens is stated before it is pressed. user.sessions is small —
 * 134k rows per 24h measured on a live estate — so this costs a fraction of
 * the RUM scans this page already pays for.
 *
 * Filtered on `frontend.name`, which is what the explorer's own Frontends
 * chip matches; the inventory name is a different string and matches nothing.
 */
/**
 * SESSIONS AS THE PLATFORM COUNTS THEM — the same store Users & Sessions
 * reads, so the number on the card is the number the button opens.
 *
 * This replaced a per-session scan of `user.events`, which counted every
 * session with any event in the window. That measure is not wrong, it is a
 * DIFFERENT population, and a reader comparing the card with the list it
 * opens found 439 against 184 and read the app as broken. Three documented
 * reasons the stores disagree, none of them fixable by a better query:
 *
 *   · `fetch user.sessions` returns sessions that STARTED in the window;
 *     the event scan counted every session ACTIVE in it
 *   · the aggregation service waits 30+ minutes of inactivity before it
 *     writes a session record, so the newest part of any window is not in
 *     this store yet
 *   · ZOMBIE SESSIONS — zero navigations and zero user interactions — are
 *     never written at all, by design. On an application whose RUM records
 *     requests and errors but almost no human actions, that is most of them.
 *
 * So the app counts what the platform will show. The cost of that choice is
 * stated where it is paid: the newest sessions are missing until they are
 * serialized, and machine-only sessions are missing permanently.
 *
 * The filter is on `frontend.name` rather than the entity id because that is
 * the field the explorer's own Frontends chip matches — verified against it
 * on a live estate, 192 here against 191 listed, the one a window boundary.
 *
 * `expand` fans a session out once per frontend it touched, so every count
 * here is countDistinct over the session id rather than count().
 */
export const qImpactedSessions = (tf: Timeframe, frontendName: string) => {
  const fe = frontendName.replace(/["\\]/g, "");
  // The same real-user rule the event scan used, written the same way: a
  // negative test, so a user_type this app has not met counts as a person
  // rather than silently emptying the denominator.
  const real = `coalesce(dt.rum.user_type, "") != "robot"
      and coalesce(dt.rum.user_type, "") != "synthetic"`;
  // null is not zero — a session with no error field must not be read as
  // "has errors" by a null-propagating comparison
  const err = `coalesce(error.count, 0) > 0`;
  return `
fetch user.sessions, from: ${tf.from}, to: ${tf.to}
| expand fe = frontend.name
| filter fe == "${fe}"
| sort coalesce(error.count, 0) desc
/* THE SAME READ, ALSO BY COUNTRY AND STATE (0.16.15). The session store
   carries geo.region.iso_code / geo.region.name (measured: "SP", "São
   Paulo"), so the sessions it already reads for the headline are summed once
   more per country and per state — no second scan, the same bytes. Key "t"
   is the headline, untouched: every session is counted exactly once under
   it, as before. "c|<cc>" and "r|<cc>|<code>|<name>" are the places, the
   sessions Users & Sessions lists for them. */
| fieldsAdd _k = array("t",
    concat("c|", coalesce(geo.country.iso_code, "")),
    concat("r|", coalesce(geo.country.iso_code, ""), "|", coalesce(geo.region.iso_code, ""),
      "|", coalesce(geo.region.name, "")))
| expand _k
/* COUNTED, NOT DISTINCT-COUNTED (0.17.23). A row of user.sessions IS one
   session, so six countDistinct over the session id were six hash sets
   estimating a number a plain count gives exactly — the slowest read left on
   the page (5–7 s on a bank's production). Exact and cheaper. */
| summarize sessions = count(),
    hit = countIf(${err}),
    realSessions = countIf(${real}),
    hitReal = countIf(${err} and ${real}),
    hitRobot = countIf(${err} and dt.rum.user_type == "robot"),
    hitSynth = countIf(${err} and dt.rum.user_type == "synthetic"),
    exSid = takeFirst(dt.rum.session.id), exStart = takeFirst(start_time),
    exInst = takeFirst(dt.rum.instance.id),
    exErrs = takeFirst(coalesce(error.count, 0)),
  by: { _k }
| sort sessions desc
| limit 500`;
};

/* THE SESSIONS FACET'S NAME PER ENTITY.
 *
 * `limit 100` was a demo-estate number: a production tenant has more
 * frontends than that, the quieter ones fell off the end, and an application
 * with no resolved name silently loses everything that depends on it — the
 * sessions hand-off opens unfiltered, and the impact scan, the trend and the
 * forecast all fall back from the session store to the event store. The
 * failure is invisible, which is the worst kind, so the ceiling is sized for
 * a real estate.
 *
 * THE WINDOW WAS A FLAT 24 HOURS, and it cost 128 GB of a production
 * tenant's 1.12 TB page — the single most expensive query on the screen,
 * for a lookup table of names. It follows the selected window now, with a
 * three-hour floor so a short selection still names the applications the
 * reader can choose. An application with no session in that window has no
 * sessions to hand off either, so the name it loses was not going to be
 * used. */
export const qFrontendNames = (minutes = 180) => `
fetch user.sessions, from: now()-${Math.max(180, Math.round(minutes))}m
| expand ent = dt.rum.application.entities
| expand fe = frontend.name
| summarize n = count(), by: {ent, fe}
| sort n desc
| limit 1000`;

/** Detected views per application (journeys). */
export const qViews = (tf: Timeframe, session?: string | null,
  rumAppId?: string | null) => `
fetch user.events, from: ${tf.from}, to: ${tf.to}${onlySession(session)}${scopeApp(rumAppId)}
| filter characteristics.classifier == "view_summary" and isNotNull(${VIEW_NAME})
// Normalised before the aggregation, for the same reason the journeys are: the
// limit is applied after grouping, so one uncollapsed id splits a real view
// into hundreds of rows of one and pushes the real ones off the end. Measured
// on a live estate: 1,042 raw names collapse to 9. A "limit 120" over 1,042
// fragments was returning mostly noise.
${norm(VIEW_NAME, "v")}
| summarize views = count(), sessions = countDistinct(dt.rum.session.id),
    p50 = percentile(toLong(duration), 50),
  by: { appId = dt.rum.application.id, view = v }
| sort sessions desc | limit 120`;

/** Navigation sequences — path mining, one ordered path per session. */
const VIEW_NAME = "coalesce(view.name, view.detected_name)";

/**
 * COLLAPSING IDENTIFIERS — one block, shared by every journey-mining query.
 *
 * It lived twice, byte for byte, in qSequences and qPathSessions; the mining
 * and the poster's membership test MUST see the same screen names or a picked
 * route matches nothing.
 *
 * Each rule is anchored on structure a real word cannot have: the hyphen
 * groups of a UUID, a pure-integer segment, or an alphanumeric run of six or
 * more carrying BOTH a digit and a letter. That last one replaced an
 * upper-case-only rule that let Astroshop's lowercase SKUs through and drew
 * six bands of the same route ("/ → /product/*vchsjnup → /cart → …" once per
 * SKU). Measured on both estates before shipping: every name it collapses is
 * a product id, and "/checkout", "/api/v2/orders" and
 * "/orange-booking-finish.jsf" pass through untouched.
 */
const COLLAPSE_IDS = `
| fieldsAdd v = replacePattern(${VIEW_NAME},
    "'/' ALNUM{8} '-' ALNUM{4} '-' ALNUM{4} '-' ALNUM{4} '-' ALNUM{12}", "/*")
// servlet session ids ride the PATH (";jsessionid=<hex>.route") and dodge
// every shape here — measured: hundreds of one-session rows, each burning a
// row of the limit before the client-side merge could collapse them
| fieldsAdd v = splitString(v, ";jsessionid")[0]
// The mixed-case id rule runs BEFORE the INT rule, not after: "'/' INT"
// collapses the LEADING DIGITS of a segment, so "/product/0puk6v6ev0"
// became "/product/*puk6v6ev0" — no longer alphanumeric, invisible to this
// rule, and still one band per SKU on the diagram (browser-verified).
// matchesRegex is a FULL match here, hence the surrounding [A-Za-z0-9]*.
| fieldsAdd _seg = splitString(v, "/")
| fieldsAdd _n = arraySize(_seg)
| fieldsAdd _last = arrayElement(_seg, _n - 1)
| fieldsAdd v = if(_n > 1 and stringLength(_last) >= 6
    and matchesRegex(_last, "[A-Za-z0-9]*[0-9][A-Za-z0-9]*")
    and matchesRegex(_last, "[A-Za-z0-9]*[A-Za-z][A-Za-z0-9]*"),
  concat(arrayToString(arraySlice(_seg, to: _n - 1), delimiter: "/"), "/*"), else: v)
// pure-integer segments ("/orders/12345") — shorter than the rule above needs
| fieldsAdd v = replacePattern(v, "'/' INT", "/*")
// Hard cap on depth. Any shape rule can be dodged by an id that does not look
// like one; truncating past the third segment bounds the cardinality whatever
// the ids look like. Screen names with no "/" are untouched.
| fieldsAdd _seg = splitString(v, "/")
| fieldsAdd v = if(arraySize(_seg) > 3, concat("/", _seg[1], "/", _seg[2], "/*"), else: v)
| fieldsRemove _seg, _n, _last`;

export const qSequences = (tf: Timeframe, session?: string | null,
  rumAppId?: string | null) => `
fetch user.events, from: ${tf.from}, to: ${tf.to}${onlySession(session)}${scopeApp(rumAppId)}
// UNION of navigation and view_summary, because coverage inverts between
// environments: on one estate navigation covered 100% of sessions and
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
// the end.${COLLAPSE_IDS}
| sort start_time asc
// PLATFORM RIDES ALONG. One RUM application id can carry two platforms —
// measured on a live estate, a single banking application reported both
// iOS view controllers and Android activities — and they do not share a
// journey shape, so they cannot share one completion depth. dt.rum.agent.type
// is the platform's own answer ("javascript" | "ios" | "android"); a session
// belongs to exactly one, so carrying it splits nothing that belonged together.
| summarize path = collectArray(v), plat = takeAny(dt.rum.agent.type),
    by: { appId = dt.rum.application.id, session = dt.rum.session.id }
| summarize sessions = count(), by: { appId, plat, journey = path }
// 1000, not 200: the budget is shared by every application, and at 200 the
// audit measured 866 vmware + 28 Astroshop sessions with full journeys
// falling off the end — then being counted as "No page telemetry"
| sort sessions desc | limit 1000`;

/**
 * A DETERMINISTIC SAMPLE OF SESSIONS — the same sessions in every query that
 * asks for the same rate.
 *
 * The infographic joins two per-session scans in the browser (the facts of
 * each session, and its path). Both used to return "the first 10,000" of
 * whatever Grail summarised — two ARBITRARY cuts of 5.4 million sessions on a
 * bank's application, which barely overlap, so a picked route matched almost
 * nothing; and both still summarised all 5.4 million first, which is why the
 * scan was still running at 85 s and the portrait failed.
 *
 * A session is kept when the first four hex digits of the SHA-256 of its id
 * fall under the rate — uniform, so the sample is representative; stable, so
 * both scans keep the SAME sessions and the join is exact inside the sample;
 * and applied BEFORE the summarize, so Grail summarises the sample, not the
 * estate. Bytes read are unchanged (a filter on a computed value cannot skip
 * storage); the work after the read is what shrinks. Counts drawn from a
 * sample are scaled by 1/rate and the screen says "≈ · sampled".
 */
export const SAMPLE_TARGET = 8000;
/** The rate is QUANTISED to the 1/65536 steps the filter can express, so the
 *  1/rate every count is scaled by is the fraction the filter actually kept. */
export const sampleRate = (sessions: number) =>
  sessions > SAMPLE_TARGET
    ? Math.max(1, Math.floor((SAMPLE_TARGET / sessions) * 65536)) / 65536 : 1;
/* THE COHORT'S TIME SLICE (0.17.15). The hash above keeps ~8,000 sessions
   of the window, but a filter on the session id cuts no Grail bytes: the
   cohort and path scans still read every event of the hour — measured on
   production 514 GiB for the current hour and 310 GiB for the one before,
   9–11 s each, to keep eight thousand sessions. Reading a SLICE of the
   window does cut the bytes, linearly. So on an application whose window
   would read more than the budget, the scans read the window's last minutes
   — settled minutes on a live window — sized to the budget, and the hash
   then picks ~8,000 sessions inside the slice. Counts are scaled by the
   product of both fractions, exactly as they were by the hash alone. A
   window with an absolute end keeps the whole window and the hash. */
export const COHORT_BYTES_PER_SESSION = 45e3;
/** The settled slice of a window that reads `estGiB` in full and must read
 *  at most the budget; null when the whole window fits (or its end is
 *  absolute, where "the last minutes" has no stable meaning). */
/** A DQL time value moved back by `min` minutes. Relative values chain
 *  ("now()-3m-5m"); an absolute one ("2026-…Z", quoted) is computed here, since
 *  a quoted timestamp minus a duration is not valid DQL. */
export function shiftBack(t: string, min: number): string {
  const v = t.trim();
  const iso = /^"(.+)"$/.exec(v);
  if (iso) {
    const ms = Date.parse(iso[1]);
    if (Number.isFinite(ms)) return `"${new Date(ms - min * 6e4).toISOString()}"`;
  }
  return `${v.replace(/^now(?!\()/i, "now()")}-${min}m`;
}
const isAbsolute = (t: string) => /^"[^"]+"$/.test(t.trim());
/** An absolute end inside the events' settling lag is pulled back to it:
 *  probing unsettled minutes under-estimates, and a slice of them undercounts. */
const settledAbs = (t: string): string => {
  const ms = Date.parse(t.trim().replace(/^"|"$/g, ""));
  return Number.isFinite(ms) && ms > Date.now() - EVENT_LAG_MIN * 6e4 ? `now()-${EVENT_LAG_MIN}m` : t.trim();
};

export function sliceFor(tf: Timeframe, estGiB: number): { tf: Timeframe; share: number } | null {
  const to = tf.to.trim();
  const relative = /^now\(?\)?(\s*-\s*\d+\s*[smhdw])*$/i.test(to);
  if (!(relative || isAbsolute(to)) || !(tf.minutes > 0)) return null;
  if (estGiB <= OPTIONAL_SCAN_BUDGET_GIB) return null;
  const sliceMin = Math.max(2, Math.floor(tf.minutes * (OPTIONAL_SCAN_BUDGET_GIB / estGiB)));
  if (sliceMin >= tf.minutes) return null;
  const live = /^now\(?\)?$/i.test(to);
  const end = live ? `now()-${EVENT_LAG_MIN}m` : relative ? to.replace(/^now(?!\()/i, "now()") : settledAbs(to);
  return { tf: { ...tf, from: shiftBack(end, sliceMin), to: end, minutes: sliceMin },
    share: sliceMin / tf.minutes };
}
export function cohortPlan(tf: Timeframe, sessions: number):
  { tf: Timeframe; hash: number; rate: number; sliceMin: number | null } {
  const s = sliceFor(tf, (sessions * COHORT_BYTES_PER_SESSION) / 2 ** 30);
  if (!s) return { tf, hash: sampleRate(sessions), rate: sampleRate(sessions), sliceMin: null };
  const hash = sampleRate(sessions * s.share);
  return { tf: s.tf, hash, rate: s.share * hash, sliceMin: s.tf.minutes };
}
/* THE SLICE IS MEASURED, NOT ESTIMATED (0.17.33). Sizing it from sessions
   failed on production by an order of magnitude: a mobile application emits
   far more events per session than a web one, the estimate said "fits" and
   the cohort read 141–163 GiB per window, 28–34 s. So the reads run first on
   a settled two-minute probe of the window; Grail reports what that cost
   (scannedBytes), which gives the bytes per minute of exactly these queries
   on exactly this application; the window is then read whole if it fits the
   budget, or as many settled minutes as fit. When even the probe is all that
   fits, its own answer is used. Worst case: the probe plus the budget. A
   window with an absolute end has no "last minutes" and keeps the session
   estimate (sliceFor). */
export async function runSized(
  tf: Timeframe,
  queries: Array<{ build: (t: Timeframe, share: number) => string; max: number }>,
  budgetGiB = OPTIONAL_SCAN_BUDGET_GIB,
  /** Minutes the probe reads. Two by default; one where the probe itself is
   *  a large share of the bill (Business Control, 0.17.40). */
  probeMin = 2,
): Promise<{ rows: Array<Record<string, unknown>[]>; tf: Timeframe; share: number;
  /** What these reads cost per minute of window, measured (0 when unknown). */
  gibPerMin: number;
  /** A read was cut by the scan ceiling: the answer is partial — callers
   *  must not memoise or cache it as whole. */
  truncated?: boolean }> {
  const to = tf.to.trim();
  const live = /^now\(?\)?$/i.test(to);
  /* an absolute window is sliced too (0.17.42): it read whole before, which
     on a custom range was the full ≈300 GiB the budget exists to prevent */
  const relative = /^now\(?\)?(\s*-\s*\d+\s*[smhdw])*$/i.test(to) || isAbsolute(to);
  let truncated = false;
  const runAll = async (t: Timeframe, share: number) => {
    let bytes = 0;
    /* a sized read gets twice the budget as its ceiling: the probe can
       under-read a window whose earlier minutes were busier, and a read cut
       at the budget itself would be partial for that reason alone */
    const rows = await Promise.all(queries.map((q) => runDql<Record<string, unknown>>(
      q.build(t, share), q.max, () => { truncated = true; }, undefined,
      { onMeta: (m) => { bytes += m.scannedBytes; },
        scanLimitGb: Math.ceil(budgetGiB * 2 * 1.074) })));
    return { rows, bytes };
  };
  const PROBE = Math.max(1, Math.round(probeMin));
  const whole = async () => {
    const r = await runAll(tf, 1);
    return { ...r, tf, share: 1, gibPerMin: r.bytes / 2 ** 30 / Math.max(1, tf.minutes), truncated };
  };
  if (!relative || !(tf.minutes > PROBE * 2)) return whole();
  const end = live ? `now()-${EVENT_LAG_MIN}m` : isAbsolute(to) ? settledAbs(to) : to.replace(/^now(?!\()/i, "now()");
  const at = (min: number): Timeframe => ({ ...tf, from: shiftBack(end, min), to: end, minutes: min });
  const probe = await runAll(at(PROBE), PROBE / tf.minutes);
  const perMin = probe.bytes / 2 ** 30 / PROBE;
  if (!(perMin > 0) || perMin * tf.minutes <= budgetGiB) return whole();
  const mins = Math.floor(budgetGiB / perMin);
  if (mins <= PROBE) return { rows: probe.rows, tf: at(PROBE), share: PROBE / tf.minutes, gibPerMin: perMin, truncated };
  const t = at(Math.min(mins, tf.minutes));
  const sliced = await runAll(t, t.minutes / tf.minutes);
  return { ...sliced, tf: t, share: t.minutes / tf.minutes, gibPerMin: perMin, truncated };
}

/* A SAMPLE SIZED BY WHAT THE READ ACTUALLY COSTS (0.17.41). Click-time
   breakdowns pick their Grail sampling ratio from the application's sessions
   × the bytes of ALL its events — but a read filtered on one event class
   (user actions) scans a fraction of that, so on a 4.5M-session application
   a state's Apdex came from a 1-in-100 sample, and a country of 422 sessions
   kept almost no rated action per state: every state "not rated". The first
   read reports what it scanned; times its ratio that is the whole read's
   cost. When a smaller ratio still fits the click budget, the read is asked
   once more at that ratio and its answer is used. Worst case: the first
   sample plus the budget. */
export async function runRefined(
  build: (ratio: number) => string, max: number, ratio: number,
  budgetGiB = CLICK_SCAN_BUDGET_GIB,
): Promise<{ rows: Record<string, unknown>[]; ratio: number }> {
  let bytes = 0;
  const rows = await runDql<Record<string, unknown>>(build(ratio), max, undefined, undefined,
    { onMeta: (m) => { bytes += m.scannedBytes; } });
  if (ratio <= 1 || !(bytes > 0)) return { rows, ratio };
  const fullGiB = (bytes / 2 ** 30) * ratio;
  const best = [1, 10, 100, 1000, 10000].find((r) => fullGiB / r <= budgetGiB) ?? ratio;
  if (best >= ratio) return { rows, ratio };
  return { rows: await runDql<Record<string, unknown>>(build(best), max), ratio: best };
}

/* A SIZED READ, REMEMBERED (0.17.42). The poster, the no-telemetry popup and
   Business Control's route cohort each paid the probe and the slice again on
   every reopen (≈23 GiB on a large application). Five minutes: long enough
   that reopening is free, short enough that a remembered cohort cannot drift
   from a freshly mined diagram. A failure is never remembered. */
const SIZED_TTL = 5 * 60_000;
const sizedMemo = new Map<string, { at: number; p: Promise<unknown> }>();
export function memoSized<T extends { truncated?: boolean }>(key: string, run: () => Promise<T>): Promise<T> {
  const hit = sizedMemo.get(key);
  if (hit && Date.now() - hit.at < SIZED_TTL) return hit.p as Promise<T>;
  const p = run()
    // a read cut by the ceiling is answered once, never remembered as whole
    .then((r) => { if (r.truncated) sizedMemo.delete(key); return r; })
    .catch((e) => { sizedMemo.delete(key); throw e; });
  sizedMemo.set(key, { at: Date.now(), p });
  return p;
}

/** The Journeys tab's four mining scans together, per session of the window
 *  (measured on production: ≈58 GiB for a ~6M-session hour). */
export const JOURNEY_BYTES_PER_SESSION = 12e3;

const sessionSample = (rate: number) => {
  if (rate >= 1) return "";
  const cut = Math.max(1, Math.round(rate * 65536)).toString(16).padStart(4, "0");
  // lower(): the comparison is on text, and hex letters must compare as hex
  return `\n| filter lower(substring(hashSha256(toString(dt.rum.session.id)), from: 0, to: 4)) < "${cut}"`;
};

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
export const qPathSessions = (tf: Timeframe, rumAppId: string, rate = 1) => `
fetch user.events, from: ${tf.from}, to: ${tf.to}
| filter dt.rum.application.id == "${rumAppId.replace(/["\\]/g, "")}"${sessionSample(rate)}
| filter (characteristics.classifier == "navigation"
    or characteristics.classifier == "view_summary")
  and isNotNull(${VIEW_NAME})
${COLLAPSE_IDS}
| sort start_time asc
| summarize path = collectArray(v), start = min(start_time),
  by: { sid = dt.rum.session.id }
/* 10000, not 2000. The sample decides which sessions the poster can see, and
   at 2000 of ~5000 it was an ARBITRARY 60% cut: a picked route whose sessions
   fell outside it produced an empty cohort — the poster read "0 sessions on
   this route" while the flow bar beside it read 310. Grail bills the records
   it SCANS, not the rows it returns, so a wider sample costs nothing; the
   sampling notice still fires if even this is hit. */
| limit 10000`;

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
 * Dimensions on offer are the ones measured POPULATED on a live estate (24h,
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
    errs = countIf(${USER_HIT}),
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
 * user.events was read off both a web and a mobile application on a live estate
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
/**
 * THE TECHNICAL READING of the same anatomy Business Control states in
 * business words — for the engineers who work the Delivery Chain and the
 * Journeys pages. Four legs, one scan each, all scoped to one application:
 *
 *   "app"   totals: the TTFB anatomy (cache · dns · connection · request ·
 *           waiting — measured: they sum to ttfb.value), the Core Web Vitals
 *           at p75 (the standard's own percentile, not p50) and long tasks.
 *   "view"  the same per view, so the engineer sees WHICH screen and why.
 *   "dur"   user-action and app-start durations — the technical story of an
 *           application that carries no vitals at all (measured on Astroshop
 *           Android: zero ttfb, zero LCP, zero foreground_time).
 *   "err"   error counts by their platform names, not business phrasing.
 *
 * UNITS, measured: ttfb.* arrive in float MILLISECONDS, web_vitals.* and
 * duration in NANOSECONDS. Everything here is normalised to milliseconds.
 */
export const qTechVitals = (tf: Timeframe, rumAppId: string) => {
  const app = rumAppId.replace(/["\\]/g, "");
  const vitals = `
  | summarize n = count(), meas = countIf(isNotNull(ttfb.value)),
      cacheMs = percentile(toDouble(ttfb.cache_duration), 75),
      dnsMs = percentile(toDouble(ttfb.dns_duration), 75),
      connMs = percentile(toDouble(ttfb.connection_duration), 75),
      reqMs = percentile(toDouble(ttfb.request_duration), 75),
      waitMs = percentile(toDouble(ttfb.waiting_duration), 75),
      ttfbMs = percentile(toDouble(ttfb.value), 75),
      lcpMs = percentile(toDouble(web_vitals.largest_contentful_paint) / 1000000, 75),
      fcpMs = percentile(toDouble(web_vitals.first_contentful_paint) / 1000000, 75),
      cls = percentile(toDouble(web_vitals.cumulative_layout_shift), 75),
      inpMs = percentile(toDouble(web_vitals.interaction_to_next_paint) / 1000000, 75),
      longMs = percentile(toDouble(long_task.all.avg_duration) / 1000000, 75),
      durMs = percentile(toLong(duration) / 1000000, 75)`;
  return `
data record(kind = "", bucket = "", n = 0, meas = 0, cacheMs = 0.0, dnsMs = 0.0,
  connMs = 0.0, reqMs = 0.0, waitMs = 0.0, ttfbMs = 0.0, lcpMs = 0.0, fcpMs = 0.0,
  cls = 0.0, inpMs = 0.0, longMs = 0.0, durMs = 0.0, sessions = 0)
| filter false
| append [ fetch user.events, from: ${tf.from}, to: ${tf.to}
  | filter dt.rum.application.id == "${app}" and characteristics.classifier == "view_summary"${vitals},
    by: { kind = "app", bucket = "" } ]
| append [ fetch user.events, from: ${tf.from}, to: ${tf.to}
  | filter dt.rum.application.id == "${app}" and characteristics.classifier == "view_summary"
  | fieldsAdd vn = ${VIEW_NAME}
  | filter isNotNull(vn) and vn != ""${vitals},
    by: { kind = "view", bucket = vn }
  | sort n desc | limit 8 ]
| append [ fetch user.events, from: ${tf.from}, to: ${tf.to}
  | filter dt.rum.application.id == "${app}"
      and in(characteristics.classifier, { "user_action", "app_start" })
  | summarize n = count(), durMs = percentile(toLong(duration) / 1000000, 75),
    by: { kind = "dur", bucket = characteristics.classifier } ]
| append [ fetch user.events, from: ${tf.from}, to: ${tf.to}
  | filter dt.rum.application.id == "${app}" and characteristics.classifier == "error"
  | fieldsAdd bucket = if(error.type == "crash", "crash",
      else: if(error.type == "anr", "anr",
      else: if(error.type == "csp", "csp",
      else: if(error.type == "exception", "exception",
      else: if(error.type == "request" and http.response.status_code >= 500, "http5xx",
      else: if(error.type == "request" and http.response.status_code >= 400, "http4xx",
      else: if(error.type == "request", "noresponse", else: "other")))))))
  | summarize n = count(), sessions = countDistinct(dt.rum.session.id), by: { kind = "err", bucket } ]
| limit 40`;
};


/**
 * WHAT "NO PAGE TELEMETRY" IS — the sessions the path mining never saw,
 * unpacked. Measured before designed: 94% of them carry exactly ONE stray
 * event (~70 ms) of the "other" classifier WITH a page path — the session was
 * on a real page, its navigation just fell outside the window (window-edge
 * sessions and lone beacons); a few are request-only API traffic; some are
 * robots. Two legs: the composition, and the pages those stray beacons name
 * (per-session collectDistinct expanded back out — verified on a live estate).
 */
/* DYNATRACE'S OWN AGENT IS NOT THE APPLICATION'S TRAFFIC (0.17.27). The RUM
   JavaScript agent's download is recorded as a request event — measured on
   the lab: ruxitagentjs_*.js from the application's own host and
   jstag/ruxitagent from js-cdn.dynatrace*, thousands in two hours. Counted,
   it made a session that only loaded the agent read as "API traffic", and
   it sat in the endpoint and domain lists as if the application called it.
   The beacons the agent sends are not request events and need no rule. */
export const DT_AGENT_REQUEST = `(contains(lower(coalesce(url.path, "")), "ruxitagent")
    or contains(lower(coalesce(url.path, "")), "/jstag/")
    or startsWith(lower(coalesce(url.domain, "")), "js-cdn.dynatrace"))`;

/** What the sessions without a recorded view are made of — read on a click,
 *  on the (sliced) window the caller sizes to the budget. One scan: the
 *  screens their other events name ride in the same summary. */
export const qNoTelemetry = (tf: Timeframe, rumAppId: string) => {
  const app = rumAppId.replace(/["\\]/g, "");
  return `
fetch user.events, from: ${tf.from}, to: ${tf.to}
| filter dt.rum.application.id == "${app}"
| fieldsAdd _agent = characteristics.classifier == "request" and ${DT_AGENT_REQUEST}
| summarize navs = countIf(characteristics.classifier == "navigation"
      or characteristics.classifier == "view_summary"),
    reqs = countIf(characteristics.classifier == "request" and not(_agent)),
    acts = countIf(characteristics.classifier == "user_action"
      or characteristics.classifier == "user_interaction"),
    n = countIf(not(_agent)),
    screen = takeAny(coalesce(view.name, view.detected_name, page.url.path)),
    isReal = takeAny(dt.rum.user_type == "real_user"),
    dur = max(toLong(duration)),
  by: { sid = dt.rum.session.id }
| filter navs == 0
/* one row for the mix, then the screens their other events name — the agent
   knew where these people were, it recorded no view there */
| fieldsAdd k = array(record(kind = "mix", bucket = ""),
    record(kind = "page", bucket = screen))
| expand k
| filter k[kind] == "mix" or isNotNull(k[bucket])
| summarize sessions = count(), real = countIf(isReal), robots = countIf(not(isReal)),
    oneEvent = countIf(n <= 1), reqOnly = countIf(reqs > 0 and acts == 0),
    withActs = countIf(acts > 0), named = countIf(isNotNull(screen)),
    p50dur = percentile(dur, 50),
  by: { kind = k[kind], bucket = k[bucket] }
| sort kind asc, sessions desc
| limit 20`;
};

/**
 * THE OUTCOME VOCABULARY — one list, measured against every application on
 * a live estate (audit 2026-08-16), shared by the DQL builders and the JS
 * regex so no two screens can disagree about what "converted" means.
 *
 * What the audit changed: "payment" is NOT completion — on the orange apps
 * the real completion is /orange-booking-finish.jsf and 894 sessions that
 * stopped at the payment view were being counted converted while 204 real
 * finishers were counted abandoned. "finish" joins the list, "payment" moves
 * to INTENT. The banking apps complete at /deposit, /withdraw and
 * /credit-card/order; easytravel-angular completes at a path ENDING in
 * "/book" — endsWith, because contains("book") would swallow every
 * "/orange-booking-…" page and convert the whole estate.
 */
export const OUTCOME_WORDS = ["checkout", "purchase", "confirm", "success",
  "complete", "booked", "receipt", "thank", "finish", "deposit", "withdraw",
  "credit-card/order"];
/**
 * CUSTOMER-DEFINED OUTCOMES — the intelligence rule, the reader's design:
 * a customer who has defined nothing teaches the app by picking views on the
 * Journeys page ("define conversion here"); the definition is stored per
 * application and REPLACES the keyword heuristic for that application, in
 * every query and screen at once. Apps without a definition keep the
 * measured keyword fallback (and its honest zero).
 */
export type OutcomeDefs = Record<string, string[]>;
/**
 * AN ERROR THAT AFFECTED A PERSON — the only kind allowed to change a
 * classification (verdict, map colour, experience score), by Marcelo's rule
 * of 2026-10-23. Two kinds, both read off Gen3 fields:
 *   - an error during the person's own action: on mobile the user_action
 *     event counts the errors of its lifespan (error.count) and whether it
 *     crashed (error.has_crash); on web, which carries no error.count, a
 *     JavaScript exception or an HTTP 4xx/5xx during the action (see
 *     WEB_ACT_ERR);
 *   - the app crashing or freezing (mobile crash / ANR), which ends or stalls
 *     the session whatever the person was doing.
 * Everything else — a background request failing, an analytics beacon, a
 * CSP report with no action around it — is still counted and shown as a
 * fact, but it cannot turn anything red. Measured on a bank's estate: 1 to
 * 31 error events per session across 29 applications, which under "any
 * error" made every application Critical and said nothing about people.
 */
/* CRASHES ARE A MOBILE FACT (Marcelo, 2026-10-23): a crash or freeze counts
   only for a mobile application. dt.rum.agent.type is the platform's own
   field — android / ios for the mobile agents, javascript for the web one
   (semantic dictionary, user events) — so the arm is guarded by it rather
   than by trusting that a web agent never reports a crash type. */
const MOBILE = `coalesce(dt.rum.agent.type, "") != "javascript"`;
/* "REAL" IS NULL-SAFE EVERYWHERE. The per-session rule has always counted
   an unlabelled session as a person (countIf(user_type == "robot") is 0 when
   the type is null). The per-event form not(user_type == "robot") is null on
   an unlabelled event, and a null condition drops the event — the opposite
   rule. Every event-level test is written coalesce(type, "") != "robot". */
/* WHAT COUNTS AS AN ERROR ON THE PERSON'S OWN ACTION — per agent, because
   the two agents do not carry the same fields (semantic dictionary, user
   actions). Mobile actions carry error.count (every error the action saw)
   and error.has_crash. Web actions carry NO error.count: they carry
   error.exception_count, error.http_4xx_count, error.http_5xx_count,
   error.http_other_count and error.csp_violation_count. Reading error.count
   on web found nothing — measured: a web app with 11,153 errors in 24 h and
   459 in an hour showed 0 sessions affected and 100% unaffected.
   On web the action is hurt by what RUM Classic's Apdex counts by default:
   a JavaScript exception, and a request that returned an HTTP error (4xx or
   5xx) during it. Left out: status-0 failures (blocked or cancelled
   requests — an ad-blocked analytics beacon is the busiest "error" on a
   real estate and nobody sees it) and CSP violations, which the Classic
   only counts when a rule says so. */
const WEB_ACT_ERR = `(coalesce(error.exception_count, 0) > 0
      or coalesce(error.http_4xx_count, 0) > 0
      or coalesce(error.http_5xx_count, 0) > 0)`;
const ACT_ERR_ANY = `(coalesce(error.count, 0) > 0
      or (coalesce(error.has_crash, false) == true and ${MOBILE})
      or (not(${MOBILE}) and ${WEB_ACT_ERR}))`;
export const USER_HIT = `((characteristics.classifier == "error"
    and (error.type == "crash" or error.type == "anr") and ${MOBILE})
  or (characteristics.classifier == "user_action"
    and ${ACT_ERR_ANY}))`;
/** A crash or freeze of the app — USER_HIT's second arm on its own. */
const CRASH = `(characteristics.classifier == "error"
    and (error.type == "crash" or error.type == "anr") and ${MOBILE})`;
/** The same test for a user action on its own — an action that carried an
 *  error of its own is rated frustrated in the experience score. */
/* NULL IS NOT FALSE. error.has_crash is null on an action that did not
   crash, and `x or null` is null, `not(null)` is null, and if(null, …) takes
   the else branch — so the satisfied and tolerating sums were ZERO for every
   clean action and the score read 0.00 in production. Every operand is
   coalesced to a real boolean before it is combined. */
const ACT_ERR = ACT_ERR_ANY;

const esc = (x: string) => x.replace(/["\\]/g, "");

/* A SERVICE IN EITHER MODEL (0.17.22). On a Gen3-only estate spans and the
   dt.service.* metrics carry dt.smartscape.service and leave
   dt.entity.service null — measured on the lab tenant: 102 of 102 spans,
   every service metric series. Every read keyed on a service now matches
   either id and reports whichever is present, so the service layer works on
   an estate with or without the classic entity model. */
export const SVC_ID = "coalesce(toString(dt.entity.service), toString(dt.smartscape.service))";
export const svcIs = (id: string) => {
  const v = id.replace(/["\\]/g, "");
  return `(dt.entity.service == "${v}" or dt.smartscape.service == toSmartscapeId("${v}"))`;
};
/** The DQL contains-any over a lowercased view-name variable (fallback). */
export const OUTCOME_SUFFIX = "/book";
const outcomeDql = (v: string) =>
  OUTCOME_WORDS.map((w) => `contains(${v}, "${w}")`).join(" or ")
  + ` or endsWith(${v}, "${OUTCOME_SUFFIX}")`;
/**
 * Outcome predicate for ONE known application: its custom view list when the
 * customer defined one, the keyword heuristic otherwise.
 */
export const outcomeDqlForApp = (v: string, appId: string, defs?: OutcomeDefs) => {
  const custom = defs?.[appId];
  return custom?.length
    ? `in(${v}, {${custom.map((n) => `"${esc(n.toLowerCase())}"`).join(", ")}})`
    : `(${outcomeDql(v)})`;
};
/**
 * Outcome predicate for ESTATE queries, where the row's app decides: each
 * customised application matches its own list, everyone else the fallback.
 */
export const outcomeDqlByApp = (v: string, appVar: string, defs?: OutcomeDefs) => {
  const entries = Object.entries(defs ?? {}).filter(([, l]) => l.length);
  if (!entries.length) return `(${outcomeDql(v)})`;
  const customIds = entries.map(([id]) => `"${esc(id)}"`).join(", ");
  const perApp = entries.map(([id, list]) =>
    `(${appVar} == "${esc(id)}" and in(${v}, {${list.map((n) => `"${esc(n.toLowerCase())}"`).join(", ")}}))`)
    .join(" or ");
  return `(${perApp} or (not(in(${appVar}, {${customIds}})) and (${outcomeDql(v)})))`;
};

/**
 * BUSINESS CONTROL'S ONE SCAN.
 *
 * The board used to read the same hour of user.events SEVEN times — KPIs
 * (two legs), breakdown (one), difficulty (four) — and every leg on a bank's
 * production estate was ~143 GB, because an application filter cuts rows,
 * not the bytes Grail has to read to find them. The KPI query ran 40 s and
 * had not finished; the breakdown was built from the first 20 000 of six
 * million sessions and said so in small print.
 *
 * Every figure those legs produced is ADDITIVE over sessions once each
 * session is reduced to one row: converted or not, real or not, hit or not,
 * which error buckets it met, how many views it had, how long its views
 * waited where. So the window is read once, reduced per session, and grouped
 * by the five dimensions the breakdown offers. The KPIs are the sum of the
 * rows; the breakdown is the sum per dimension value; the error-cost split is
 * the hit/clean columns; the difficulty section reads the error buckets and
 * the wait sums. One scan, and the breakdown is now a total rather than a
 * sample — the cap below is on GROUPS, and a few thousand is a large estate.
 *
 * The previous window needs no dimensions — the board compares totals — so
 * it is a second, dimension-free leg (qBizPrev) and not an append here: the
 * cube previews and lands on its own, and the comparison patches in.
 */
const bizSessionLeg = (tf: Timeframe, from: string, to: string, defs?: OutcomeDefs,
  rumAppId?: string | null) => {
  const appFilter = rumAppId
    ? `\n| filter dt.rum.application.id == "${esc(rumAppId)}"` : "";
  const done = rumAppId
    ? outcomeDqlForApp("_vn", rumAppId, defs)
    : outcomeDqlByApp("_vn", "dt.rum.application.id", defs);
  return `
fetch user.events, from: ${from}, to: ${to}${appFilter}
| fieldsAdd _vn = lower(coalesce(view.name, view.detected_name, ""))
| fieldsAdd _done = if(${done}, 1, else: 0)
| fieldsAdd _isErr = characteristics.classifier == "error"
// the error's origin, from its own record — the same eight buckets the
// difficulty section has always named
| fieldsAdd _bucket = if(not(_isErr), "",
    else: if(error.type == "crash" or error.type == "anr", "device",
    else: if(error.type == "csp",
      if(isNotNull(csp.blocked_uri.provider) and csp.blocked_uri.provider != "first_party",
        "third_party", else: "policy"),
    else: if(error.type == "exception", "frontend",
    else: if(error.type == "request" and http.response.status_code >= 500, "backend",
    else: if(error.type == "request" and (http.response.status_code == 0
        or isNull(http.response.status_code)), "connection",
    else: if(error.type == "request", "request_4xx", else: "other")))))))
// UNITS, measured on a live estate: ttfb.* in MILLISECONDS (floats),
// web_vitals.* and duration in NANOSECONDS. Normalised to ns.
| fieldsAdd _vs = characteristics.classifier == "view_summary"
| fieldsAdd _net = if(_vs, (coalesce(toDouble(ttfb.dns_duration), 0.0) + coalesce(toDouble(ttfb.connection_duration), 0.0)) * 1000000, else: 0.0)
| fieldsAdd _srv = if(_vs, coalesce(toDouble(ttfb.waiting_duration), 0.0) * 1000000, else: 0.0)
| fieldsAdd _lcp = coalesce(toDouble(web_vitals.largest_contentful_paint), 0.0)
| fieldsAdd _ttfb = coalesce(toDouble(ttfb.value), 0.0) * 1000000
| fieldsAdd _rend = if(_vs and _lcp > _ttfb, _lcp - _ttfb, else: 0.0)
| summarize
    // deterministic, like every other session verdict in this file
    real = min(if(coalesce(dt.rum.user_type, "") != "robot" and coalesce(dt.rum.user_type, "") != "synthetic", 1, else: 0)),
    conv = max(_done),
    // the session was HIT when an error affected the person (USER_HIT);
    // the origin buckets below still count every error, for "where it lives"
    errs = countIf(${USER_HIT}),
    fatal = countIf(error.type == "crash" or error.type == "anr"),
    // DISTINCT SCREENS over nav∪view_summary — the one engagement rule
    views = countDistinct(if((characteristics.classifier == "navigation"
      or characteristics.classifier == "view_summary") and _vn != "", _vn, else: null)),
    // ONLY WHAT THE BOARD READS. Every aggregation here is paid per session,
    // six million times an hour on a bank's estate, and the per-session pass
    // is where the time goes. The board reads "made to wait", which is one
    // flag: an action the PLATFORM rated below satisfied — experience.level
    // is set by OpenPipeline from the action's duration against the
    // environment's own thresholds, so no number of ours is involved.
    slowActs = countIf(characteristics.classifier == "user_action" and isNotNull(experience.level) and experience.level != "satisfied"),
    eDevice = countIf(_bucket == "device"), eThird = countIf(_bucket == "third_party"),
    ePolicy = countIf(_bucket == "policy"), eFrontend = countIf(_bucket == "frontend"),
    eBackend = countIf(_bucket == "backend"), eConnection = countIf(_bucket == "connection"),
    e4xx = countIf(_bucket == "request_4xx"), eOther = countIf(_bucket == "other"),
    vsViews = countIf(_vs), vsMeas = countIf(_vs and isNotNull(ttfb.value)),
    net = sum(_net), srv = sum(_srv), rend = sum(_rend),
    country = takeAny(geo.country.iso_code), os = takeAny(os.name),
    browser = takeAny(browser.name), deviceType = takeAny(device.type),
    userType = takeAny(dt.rum.user_type),
  by: { appId = dt.rum.application.id, sid = dt.rum.session.id }
| filter isNotNull(appId) and appId != "" and not(startsWith(appId, "APPLICATION-"))`;
};

/** The additive columns, summed over the per-session rows of a group. */
const bizSums = `
    sessions = count(), realSessions = sum(real),
    converted = sum(conv), convertedReal = countIf(real == 1 and conv == 1),
    hit = countIf(errs > 0), hitReal = countIf(real == 1 and errs > 0),
    hitConv = countIf(errs > 0 and conv == 1),
    realHitConv = countIf(real == 1 and errs > 0 and conv == 1),
    fatalSessions = countIf(fatal > 0),
    // customers made to WAIT — at least one action past the platform's own
    // satisfaction threshold T. A distinct harm from meeting an error.
    waitedReal = countIf(real == 1 and slowActs > 0),
    engaged = countIf(views > 1), realEngaged = countIf(real == 1 and views > 1),
    // sessions that met at least one error of each origin — what the old
    // difficulty leg counted as countDistinct(session) per bucket
    errDevice = countIf(eDevice > 0), errThird = countIf(eThird > 0),
    errPolicy = countIf(ePolicy > 0), errFrontend = countIf(eFrontend > 0),
    errBackend = countIf(eBackend > 0), errConnection = countIf(eConnection > 0),
    err4xx = countIf(e4xx > 0), errOther = countIf(eOther > 0),
    slowViews = sum(vsViews), slowMeas = sum(vsMeas),
    net = sum(net), srv = sum(srv), rend = sum(rend)`;

/** The group cap. It is on GROUPS — distinct combinations of the five
 *  dimensions — not on sessions; a large estate has a few thousand. */
export const BIZ_CUBE_CAP = 20000;

/** This window, reduced per session and grouped by the board's dimensions. */
export const qBizCube = (tf: Timeframe, defs?: OutcomeDefs, rumAppId?: string | null) =>
  `${bizSessionLeg(tf, tf.from, tf.to, defs, rumAppId)}
| summarize${bizSums},
  by: { appId, country, os, browser, deviceType, userType }
| limit ${BIZ_CUBE_CAP}`;

/** The window before it, totals only — the board compares, it does not
 *  segment the past. */
export const qBizPrev = (tf: Timeframe, defs?: OutcomeDefs, rumAppId?: string | null) => {
  const span = Math.max(1, Math.round(tf.minutes));
  return `${bizSessionLeg(tf, shiftBack(tf.from, span), tf.from, defs, rumAppId)}
| summarize${bizSums},
  by: { appId }
| limit 50`;
};
const DONE_DQL = outcomeDql("_vn");

/**
 * How Business Control's forecast is sized, by the analyzer's documented
 * requirements (forecasting-analyzer reference): at least 20 points, at least
 * 14 non-null of them in the LAST THIRD of the history, and a history at
 * least twice the horizon. The horizon is one window — the board says
 * "next <window>" — so the history is two windows, cut into 60 bins: 20 in
 * the last third, comfortably clear of 14. It was 20 bins in all (6-minute
 * bins over two hours), which left 7 in the last third and the board read
 * "not enough history to project" — a sizing error of this app's, not a
 * property of the data. Bins do not change what Grail scans.
 *
 * Past twelve hours a window cannot be projected honestly: two windows of
 * history would exceed FC_HIST_CAP_MIN, and a shorter horizon would be
 * labelled with the window's name. `ok` says so and the board states it.
 */
export const bizSeriesShape = (tf: Timeframe) => {
  const span = Math.max(Math.round(tf.minutes), 30);
  const histMin = span * 2;
  const interval = Math.max(1, Math.round(histMin / 60));
  return { span, histMin, interval, horizon: Math.max(1, Math.round(span / interval)),
    ok: histMin <= FC_HIST_CAP_MIN };
};

/**
 * The series Davis forecasts for Business Control — sessions or conversions
 * per interval, over a history six times the window, so the projection of the
 * NEXT window rests on enough past. Returned as a string because the Davis
 * analyzer takes the query itself (verified: records are rejected, the query
 * string returns OK/VALID with lower/point/upper bands).
 */
export const qBizSeries = (
  tf: Timeframe, metric: "sessions" | "conversions", rumAppId?: string | null,
  defs?: OutcomeDefs,
) => {
  /* THE SHAPE COMES FROM ONE PLACE — bizSeriesShape, below — so the series
   * the analyzer trains on and the horizon the board asks for can never be
   * sized by two different sums. */
  const { histMin, interval } = bizSeriesShape(tf);
  /* and it ends where the SELECTED window ends — on a historical selection
     this trained on the traffic of right now and the board then called the
     result "next". See histWindow. */
  const win = histWindow(tf, histMin);
  const appFilter = rumAppId
    ? `\n| filter dt.rum.application.id == "${rumAppId.replace(/["\\]/g, "")}"` : "";
  const agg = metric === "sessions" ? "sessions = count()" : "conversions = sum(reached)";
  return `fetch user.events, from: ${win.from}, to: ${win.to}${appFilter}
| fieldsAdd _vn = lower(coalesce(view.name, view.detected_name, ""))
| fieldsAdd _done = if(${rumAppId ? outcomeDqlForApp("_vn", rumAppId, defs) : outcomeDqlByApp("_vn", "dt.rum.application.id", defs)}, 1, else: 0)
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

export const qCohortSessions = (tf: Timeframe, rumAppId: string, defs?: OutcomeDefs,
  rate = 1) => {
  const app = rumAppId.replace(/["\\]/g, "");
  const DONE = outcomeDqlForApp("_vn", rumAppId, defs).replace(/^\(|\)$/g, "");
  const field = (id: string, expr: string) => `${id} = takeAny(${expr})`;
  const cols = INFO_DIMS.filter((d) => d.expr).map((d) => field(d.id, d.expr)).join(",\n      ");
  return `
fetch user.events, from: ${tf.from}, to: ${tf.to}
| filter dt.rum.application.id == "${app}"${sessionSample(rate)}
| fieldsAdd _vn = lower(coalesce(view.name, view.detected_name, ""))
| fieldsAdd _done = if(${DONE}, 1, else: 0)
/* NO SORT. A sort of every event in the window ran here so that takeFirst
   could name each session's ENTRY screen — a column nothing reads (the
   poster takes the entry from the mined path). On a bank's application it
   was 140 million events ordered before a single session was summarised. */
| summarize
      ${cols},
      reached = max(_done),
      // the session's WORST measured load — for a SPA that is simply the app
      // load, the only hard navigation it has (measured: 1,880 of 1,881
      // sessions carry exactly one); for a multi-page app it is the worst of
      // its ~5 timed views. Milliseconds: ttfb.* arrive in ms, vitals in ns.
      measured = countIf(isNotNull(ttfb.value)),
      ttfbMs = takeMax(toDouble(ttfb.value)),
      lcpMs = takeMax(toDouble(web_vitals.largest_contentful_paint) / 1000000),
      fcpMs = takeMax(toDouble(web_vitals.first_contentful_paint) / 1000000),
      errs = countIf(${USER_HIT}),
      // made to wait: an action the platform rated below satisfied (experience.level)
      waited = countIf(characteristics.classifier == "user_action"
        and isNotNull(experience.level) and experience.level != "satisfied"),
      crash = countIf(error.type == "crash" or error.type == "anr"),
      /* SCREENS, not view_summary EVENTS. Measured on a live estate: the median
       * session emits ONE view_summary while its mined journey shows TWO
       * distinct screens, and 2,514 of 6,029 sessions (42%) emit none at all —
       * so the poster could say "median views 1.0" for a cohort the stage
       * column called "Two views in". Counting distinct screen names over the
       * same events the journey is mined from makes the two agree, and stops
       * a soft-navigating app from reading as a one-screen app. */
      views = countDistinct(if(characteristics.classifier == "navigation"
        or characteristics.classifier == "view_summary", _vn, else: null)),
      dur = max(toLong(duration)),
      /* min, not takeAny — 157 measured sessions carry two user_type values
       * and takeAny flips the customer count between runs */
      isReal = min(if(coalesce(dt.rum.user_type, "") != "robot"
        and coalesce(dt.rum.user_type, "") != "synthetic", 1, else: 0)),
    by: { sid = dt.rum.session.id }
| fields sid, reached, errs, waited, crash, views, dur, isReal,
    measured, ttfbMs, lcpMs, fcpMs,
    ${INFO_DIMS.filter((d) => d.expr).map((d) => d.id).join(", ")}
| limit 10000`;
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
// DERIVED from OUTCOME_WORDS — two hand-kept literals claiming to be one
// vocabulary was itself an incoherence waiting to happen (auditor's nit)
export const DONE = new RegExp(
  [...OUTCOME_WORDS.map((w) => w.replace(/[/-]/g, "\\$&")), "\\/book$"].join("|"), "i");
export const INTENT =
  /cart|basket|bag|order|booking|reserv|signup|register|subscribe|apply|quote|payment/i;

/** True when this journey reaches a recognisable final step. */
export const reachesOutcome = (journey: string[]) => journey.some((v) => DONE.test(v));

/** The per-view outcome test for ONE application — custom list first. */
export const outcomeTestFor = (appId?: string | null, defs?: OutcomeDefs):
  ((v: string) => boolean) => {
  const custom = appId ? defs?.[appId] : undefined;
  if (custom?.length) {
    const set = new Set(custom.map((n) => n.toLowerCase()));
    return (v: string) => set.has(v.toLowerCase());
  }
  return (v: string) => DONE.test(v);
};

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
 * Measured on a live estate, Astroshop Android, 2h: `view.detected_name` is null
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
export const qTransitions = (tf: Timeframe, session?: string | null,
  rumAppId?: string | null) => `
fetch user.events, from: ${tf.from}, to: ${tf.to}${onlySession(session)}${scopeApp(rumAppId)}
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
export const qFriction = (tf: Timeframe, session?: string | null,
  rumAppId?: string | null) => `
fetch user.events, from: ${tf.from}, to: ${tf.to}${onlySession(session)}${scopeApp(rumAppId)}
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
export const qDevices = (tf: Timeframe, session?: string | null,
  rumAppId?: string | null) => `
fetch user.events, from: ${tf.from}, to: ${tf.to}${onlySession(session)}${scopeApp(rumAppId)}
| summarize res = takeAny(concat(device.screen.width, "×", device.screen.height)),
    dpr = takeAny(toString(browser.window.device_pixel_ratio)),
    orient = takeAny(device.orientation),
    agent = takeAny(dt.rum.agent.type),
    // deterministic: 157 measured sessions carry two user_type values, and
    // takeAny flipped their origin between runs (same fix as qImpacted)
    utype = if(countIf(dt.rum.user_type == "robot") > 0, "robot",
      else: if(countIf(dt.rum.user_type == "synthetic") > 0, "synthetic",
      else: takeAny(dt.rum.user_type))),
    views = countIf(characteristics.classifier == "view_summary"),
  by: { appId = dt.rum.application.id, sid = dt.rum.session.id }
| summarize sessions = count(), views = sum(views),
  by: { appId, res, dpr, orient, agent, utype }
| sort sessions desc | limit 20`;

/** Contacted domains (layer 02). */
/** Scoped like qOrigins, and for the same measured reason. */
export const qDomains = (tf: Timeframe, rumAppId?: string | null, ratio = 1) => {
  /* On a shifted/absolute window tfMid is null — emit a literal null so the
   * client keeps its "no forecast" contract. The old fallback "now()" turned
   * unknown into a hard 0 and every leg's second half reading as empty. */
  const mid = tfMid(tf);
  return `
fetch user.events, from: ${tf.from}, to: ${tf.to}${ratio > 1 ? `, samplingRatio: ${ratio}` : ""}${scopeApp(rumAppId)}
/* Requests UNION failed calls. Request records carry only 200/201 on both
 * measured estates (bwm: 445k requests, statuses {200, 0, null}) — every
 * failed call is filed as an error with source "fetch", so counting
 * status >= 400 here was a structural 0 wearing "clean". The error rows ride
 * the same scan; on gru they carry url.domain (99%), on bwm they do not —
 * those group under domain "" and the client reports them as unattributable
 * instead of pretending zero. */
| filter ((characteristics.classifier == "request" and isNotNull(url.domain))
    or (characteristics.classifier == "error" and error.source == "fetch"))
    and not(${DT_AGENT_REQUEST})
| fieldsAdd _req = if(characteristics.classifier == "request", 1, else: 0)
| summarize reqs = countIf(_req == 1),
    p50 = percentile(if(_req == 1, toLong(duration)), 50),
    // p90 rides along (free column) because the audit measured p50 = 0 on
    // 916k first-party requests — over half report zero duration, and a
    // bare "0ms" was truth wearing the clothes of nonsense
    p90 = percentile(if(_req == 1, toLong(duration)), 90),
    err = countIf(_req == 0),
    bytes = sum(if(_req == 1, toLong(performance.transfer_size))),
    late = ${mid ? `countIf(_req == 1 and start_time >= ${mid})` : "toLong(null)"},
  by: { appId = dt.rum.application.id, domain = coalesce(url.domain, ""),
        provider = url.provider, utype = dt.rum.user_type, agent = dt.rum.agent.type }
| sort reqs desc | limit 160`;
};

/**
 * Users hit by errors, and the one session worth opening.
 *
 * "Users" is measured as sessions: this environment's RUM carries no user
 * identity — `dt.rum.browser.sid` is null on every event measured — so distinct
 * sessions is the honest count and the label must say sessions. The split by
 * real / robot / synthetic matters here because a demo estate's impact is
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
    // deterministic, not takeAny: 157 sessions (measured) carry two
    // user_type values across their events and takeAny flipped a coin —
    // one robot-marked event now marks the session, every run the same
    robotEv = countIf(dt.rum.user_type == "robot"),
    synthEv = countIf(dt.rum.user_type == "synthetic"),
    synth = countIf(isNotNull(dt.synthetic.monitor.id)),
    uhit = countIf(${USER_HIT}),
  by: { sid = dt.rum.session.id }
| sort errs desc
| summarize sessions = count(), hit = countIf(uhit > 0),
    // same "real" rule as qUxByApp — see the note there
    realSessions = countIf(robotEv == 0 and synthEv == 0 and synth == 0),
    hitReal = countIf(uhit > 0 and robotEv == 0 and synthEv == 0 and synth == 0),
    hitRobot = countIf(uhit > 0 and robotEv > 0),
    hitSynth = countIf(uhit > 0 and (synthEv > 0 or synth > 0)),
    exSid = takeFirst(sid), exStart = takeFirst(st),
    exInst = takeFirst(inst), exErrs = takeFirst(errs)`;

/**
 * The same impact measure, for every application at once — the overview's one
 * scan. Per-session first so "a session with errors" is counted once however
 * many errors it took, then per application. Same field caveats as qImpacted.
 */

/**
 * ONE SCORE, PER PLACE — the hero is the sum of the map.
 *
 * The platform rates every user action itself (experience.level × weight —
 * see utils/apdex). The application's figure comes from qUxByApp, a
 * country's from qGeo, a state's from qGeoRegions: each reads the rating in
 * the scan it already pays for. It used to be a scan of its own, grouped by
 * country and state, and on a bank's estate that one scan was the last thing
 * on the page to land (24 s) and held the map back with it.
 */
/**
 * THE APPLICATION'S EXPERIENCE SCORE, ON ITS OWN AND LEAN.
 *
 * Two placements were measured on a bank's production application and both
 * were wrong: a scan grouped by country and state (24 s), then extra
 * aggregations inside the per-session impact scan, which made the VERDICT
 * wait 29.6 s instead of ~16 s — five sums paid for each of 5 million
 * sessions. The score needs neither grouping: it is a sum of the platform's
 * ratings over the user actions of real people, so it is one filtered,
 * ungrouped summarize — the classifier filter cuts what Grail reads (the
 * experience card's equivalent reads ~50 GB, not ~90) and it previews like
 * any additive count.
 */
export const qExperience = (tf: Timeframe, rumAppId: string) => `
fetch user.events, from: ${tf.from}, to: ${tf.to}
| filter dt.rum.application.id == "${esc(rumAppId)}"
| filter ((characteristics.classifier == "user_action" and isNotNull(experience.level))
    or ${CRASH})
  and coalesce(dt.rum.user_type, "") != "robot" and coalesce(dt.rum.user_type, "") != "synthetic"
  and isNull(dt.synthetic.monitor.id)
| fieldsAdd _w = coalesce(experience.weight, 1)
| fieldsAdd _act = characteristics.classifier == "user_action"
// RESPONSE TIME AGAINST THE ERRORS THAT HURT (Marcelo, 2026-10-23). Speed is
// the platform's own rating of each action (experience.level, from its
// duration); an action that carried an error of its own is frustrated
// whatever its speed; and every crash or freeze of the app is one more
// frustrated element — the errors that hurt are USER_HIT, the same two arms
// that judge the verdict. Background errors never enter.
| fieldsAdd _err = _act and ${ACT_ERR}
| summarize satisfied = sum(if(_act and not(_err) and experience.level == "satisfied", _w, else: 0)),
    tolerating = sum(if(_act and not(_err) and experience.level == "tolerating", _w, else: 0)),
    frustrated = sum(if(not(_act), 1, else: if(_err or experience.level == "frustrated", _w, else: 0))),
    ratedActs = countIf(_act),
    // of the frustrated: actions an error put there, and crashes / freezes
    errActions = countIf(_err),
    scoreCrashes = countIf(not(_act))`;

/** An error a third party owns — claimed only when the data SAYS so. */
const THIRD_PARTY = `(isNotNull(http.request.provider) or exception.file.provider == "third_party"
        or (error.type == "csp" and isNotNull(csp.blocked_uri.provider)
          and csp.blocked_uri.provider != "first_party"))`;

const PLACE_SCORE_FIELDS = `| fieldsAdd _xreal = coalesce(dt.rum.user_type, "") != "robot"
    and coalesce(dt.rum.user_type, "") != "synthetic" and isNull(dt.synthetic.monitor.id)
| fieldsAdd _xact = _xreal and characteristics.classifier == "user_action"
    and isNotNull(experience.level)
| fieldsAdd _xcrash = _xreal and ${CRASH}
| fieldsAdd _xw = coalesce(experience.weight, 1)`;
const PLACE_SCORE_SUMS = `sat = sum(if(_xact and not(${ACT_ERR}) and experience.level == "satisfied", _xw, else: 0)),
    tol = sum(if(_xact and not(${ACT_ERR}) and experience.level == "tolerating", _xw, else: 0)),
    fru = sum(if(_xcrash, 1, else: if(_xact and (${ACT_ERR} or experience.level == "frustrated"), _xw, else: 0)))`;

/**
 * `rumAppId` narrows this to ONE application.
 *
 * The estate-wide form is what the comparison line needs, and it is also what
 * silently loses an application on a real tenant: the answer is capped at a
 * hundred rows, a production estate has more frontends than that, and the row
 * that falls off the end is the one the reader is looking at. The symptom is
 * an Apdex printing "—" on an application with hundreds of thousands of user
 * actions, which reads as "not measurable" when it means "not returned".
 *
 * Scoped, the application cannot be crowded out by its neighbours — and the
 * scan is a fraction of the estate's, which is the same lever that fixed
 * qOrigins and qDomains.
 */
export const qUxByApp = (tf: Timeframe, rumAppId?: string | null) => `
fetch user.events, from: ${tf.from}, to: ${tf.to}${scopeApp(rumAppId)}
| summarize errs = countIf(characteristics.classifier == "error"),
    // Whose code failed. A third party's beacon dying degrades the page; the
    // application's own API returning 404 breaks the feature the user came
    // for — measured here, every error reaching easytrade's real users is the
    // second kind: 404s on its own /credit-card-order-service endpoints.
    // Third party is claimed only when the data SAYS so; unattributed counts
    // as our own, so nothing hides behind a null.
    // http.request.provider and exception.file.provider are null on 100% of
    // a live estate's events (measured); the only third-party attribution the
    // data actually carries is the CSP blocked-uri provider — counted when it
    // names anyone but first_party. Unattributed still counts as our own.
    errsThird = countIf(characteristics.classifier == "error" and ${THIRD_PARTY}),
    // Errors that reached a person, split the same way.
    // DISTINCT SCREENS, not view_summary events — the median session emits
    // one view_summary while walking two screens, and 42% emit none
    // (measured); event-counting understated engagement on soft-nav apps
    views = countDistinct(if((characteristics.classifier == "navigation"
      or characteristics.classifier == "view_summary")
      and isNotNull(coalesce(view.name, view.detected_name)),
      lower(coalesce(view.name, view.detected_name)), else: null)),
    viewEvs = countIf(characteristics.classifier == "view_summary"),
    acts = countIf(characteristics.classifier == "user_action"),
    aband = countIf(user_action.complete_reason == "page_hide"),
    navs = countIf(characteristics.classifier == "navigation"),
    mob = countIf(characteristics.classifier == "app_start"
      or characteristics.classifier == "user_interaction"),
    reqs = countIf(characteristics.classifier == "request"),
    // deterministic, not takeAny: 157 sessions (measured) carry two
    // user_type values across their events and takeAny flipped a coin —
    // one robot-marked event now marks the session, every run the same
    robotEv = countIf(dt.rum.user_type == "robot"),
    synthEv = countIf(dt.rum.user_type == "synthetic"),
    synth = countIf(isNotNull(dt.synthetic.monitor.id)),
    // errors that affected the person (USER_HIT) — the only ones that judge
    uhit = countIf(${USER_HIT}),
  by: { appId = dt.rum.application.id, sid = dt.rum.session.id }
| filter isNotNull(appId) and appId != "" and not(startsWith(appId, "APPLICATION-"))
| summarize sessions = count(), hit = countIf(uhit > 0),
    // "Real" is anything not positively identified as a robot or a monitor —
    // an unlabelled session counts as a person, so an unknown never buys the
    // application a quieter verdict than it deserves.
    realSessions = countIf(robotEv == 0 and synthEv == 0 and synth == 0),
    hitReal = countIf(uhit > 0 and robotEv == 0 and synthEv == 0 and synth == 0),
    hitRobot = countIf(uhit > 0 and robotEv > 0),
    hitSynth = countIf(uhit > 0 and (synthEv > 0 or synth > 0)),
    engaged = countIf(views >= 2),
    actions = sum(acts), abandoned = sum(aband),
    errors = sum(errs), errorsThird = sum(errsThird),
    // errors carried by sessions belonging to real people
    realErrors = sum(if(robotEv == 0 and synthEv == 0 and synth == 0, errs, else: 0)),
    // app_start/user_interaction are activity too — without them 20 of the
    // mobile app's 27 "fragments" were real users who launched and tapped
    fragments = countIf(navs == 0 and viewEvs == 0 and acts == 0 and reqs == 0 and mob == 0),
  by: { appId }`;

/** Sessions and errors over time, for the landing page's trend chart. */
/**
 * SESSIONS PER BIN, FROM THE STORE THE HEADLINE COUNTS.
 *
 * The trend used to come from the event scan while the headline came from
 * `user.sessions`, and the two bases met in the open: a card reading 181
 * sessions over two hours sat above a forecast of "≈309 next 40m", drawn
 * from a series that counted a different population. Whichever number a
 * reader trusted, the page contradicted itself.
 *
 * Binned on `start_time`, which is what "sessions in this bin" has to mean
 * for a store whose rows are whole sessions: a session belongs to the moment
 * it began, not to every bin it spanned. Summing these bins therefore
 * reproduces the headline — a cheap check the card prints beside the bars.
 */
/**
 * HOW FAR BACK THE SESSION STORE IS ACTUALLY COMPLETE.
 *
 * The aggregation service waits 30+ minutes of inactivity before it writes a
 * session record, so the newest stretch of any live window holds sessions
 * that have happened and not yet been serialized. A TOTAL over that window is
 * still the right number to print — it is exactly what Users & Sessions will
 * show, which is the promise the card makes. A SERIES is different: drawing
 * those bins as measured zeros says traffic collapsed, and the chart showed a
 * bank's production application falling off a cliff at 20:10 when nothing had
 * happened except the clock. The forecast then trained on the cliff and the
 * analyzer rated it unsound — correctly, about a shape that was not real.
 *
 * So the drawn series stops where the store stops being complete. An hour is
 * the documented 30 minutes with the same again for the write to land.
 */
export const SESSION_LAG_MIN = 60;

/** The series' end: pulled back off a LIVE window, untouched on a past one. */
export const seriesEnd = (tf: Timeframe): string =>
  /^now\(?\)?$/i.test(tf.to.trim()) && tf.minutes > SESSION_LAG_MIN
    ? `now()-${SESSION_LAG_MIN}m` : tf.to;

/**
 * True when a live window sits entirely inside the session store's lag — a
 * 30-minute default, say. Pulling the series' end back by an hour on such a
 * window would make `from` later than `to`, and the store has nothing yet for
 * the window anyway. Consumers switch to the event store for the window's
 * duration and say so.
 */
/**
 * HOW FAR BEHIND LIVE THE EVENT STREAM ITSELF RUNS.
 *
 * Measured on a bank's production application, a 30-minute window binned by
 * the minute: 170k, 144k, 134k, 91k, 54k, then 819 sessions in the newest
 * bin. Nothing happened to the traffic — RUM beacons arrive minutes after
 * the thing they report, so the last few bins of any live window are still
 * filling. On a 2-hour window that is one partial 5-minute bin and nobody
 * sees it. On a 30-minute window with 1-minute bins it is a cliff: the chart
 * paints a collapse that is not there, and a forecast trained on it
 * extrapolates zeros — VALID to the analyzer, nonsense to the reader.
 *
 * So a live series stops a few minutes short of now, exactly as the session
 * series stops an hour short: the bins that cannot be complete are not drawn
 * as measured, and not trained on.
 */
export const EVENT_LAG_MIN = 3;
export const eventSeriesEnd = (tf: Timeframe): string =>
  /^now\(?\)?$/i.test(tf.to.trim()) && tf.minutes > EVENT_LAG_MIN * 3
    ? `now()-${EVENT_LAG_MIN}m` : tf.to;

export const withinSessionLag = (tf: Timeframe): boolean =>
  /^now\(?\)?$/i.test(tf.to.trim()) && tf.minutes <= SESSION_LAG_MIN;

export const qSessionSeries = (tf: Timeframe, frontendName: string) => `
fetch user.sessions, from: ${tf.from}, to: ${seriesEnd(tf)}
| expand fe = frontend.name
| filter fe == "${frontendName.replace(/["\\]/g, "")}"
| summarize sessions = countDistinct(dt.rum.session.id),
  by: { t = bin(start_time, ${binFor(tf.minutes)}) }
| sort t asc`;

export const qPulseSeries = (tf: Timeframe, rumAppId: string) => `
fetch user.events, from: ${tf.from}, to: ${eventSeriesEnd(tf)}
| filter dt.rum.application.id == "${rumAppId.replace(/["\\]/g, "")}"
| summarize sessions = countDistinct(dt.rum.session.id),
    errors = countIf(characteristics.classifier == "error"),
    actions = countIf(characteristics.classifier == "user_action"),
    requests = countIf(characteristics.classifier == "request"),
  by: { t = bin(start_time, ${binFor(tf.minutes)}) }
| sort t asc`;

/**
 * The card's request totals — EXACT, in one ungrouped row.
 *
 * This was "every breakdown of the classic app overview in one scan": grouped
 * by os × version × device × model × app version × country × user type, then
 * rolled up in the browser. Measured on a bank's application it returned 500
 * rows — the cap — out of thousands of combinations, unsorted, and the card's
 * totals were summed over that arbitrary slice. Nothing on screen reads the
 * per-dimension slices; the card reads two numbers. So it asks for exactly
 * those two, ungrouped (nothing to truncate), over the only two event kinds
 * they come from (the classifier filter cuts what Grail reads).
 */
export const qPulseBreakdown = (tf: Timeframe, rumAppId: string) => `
fetch user.events, from: ${tf.from}, to: ${tf.to}
| filter dt.rum.application.id == "${rumAppId.replace(/["\\]/g, "")}"
| filter characteristics.classifier == "request" or characteristics.classifier == "error"
| summarize requests = countIf(characteristics.classifier == "request"),
    // failed CALLS, not status codes — request records carry only 200/201
    // on both measured estates; failures are filed as fetch-source errors
    reqfail = countIf(${FAILED_CALL})`;

/**
 * THE SERIES AND THE CARD'S TOTALS IN ONE SCAN (0.16.4).
 *
 * qPulseSeries (every event, binned) and qPulseBreakdown (request + error,
 * ungrouped) read the same application over the same window, and on a
 * production estate the pair cost two scans where one holds both answers.
 * This is that one scan, built so that NEITHER answer changes:
 *
 * - The TOTALS (requests, reqfail) count every event in [from, to), exactly
 *   as the breakdown did: an event falls in one bin only, so the sum of the
 *   bins IS the ungrouped count.
 * - The DRAWN fields (sessions, errors, actions, requests per bin) count only
 *   events before the series' own end — eventSeriesEnd, the live-lag cut the
 *   series used as its fetch bound — so the bars are the ones qPulseSeries
 *   drew, to the event. `early` lets the client drop a bin that holds only
 *   late events, which the old fetch bound never returned.
 */
export const qPulse = (tf: Timeframe, rumAppId: string,
  /** The series' end, for the comparison panel only: an absolute cut that
   *  stands in for the live-lag cut on an aligned window. */
  endOverride?: string) => {
  const end = endOverride ?? eventSeriesEnd(tf);
  /* start_time, NOT timestamp: timestamp is null on every user.events row
     (dql-syntax-gotchas), so `timestamp < …` was false everywhere and 0.16.4
     drew no bars at all. An absolute end arrives quoted and is a string until
     toTimestamp makes it a time. */
  const endT = /^".*"$/.test(end.trim()) ? `toTimestamp(${end})` : end;
  const cut = end === tf.to ? "true" : `start_time < ${endT}`;
  return `
fetch user.events, from: ${tf.from}, to: ${tf.to}
| filter dt.rum.application.id == "${rumAppId.replace(/["\\]/g, "")}"
| fieldsAdd _in = ${cut}
| summarize early = countIf(_in),
    sessions = countDistinct(if(_in, dt.rum.session.id, else: null)),
    errors = countIf(_in and characteristics.classifier == "error"),
    actions = countIf(_in and characteristics.classifier == "user_action"),
    requests = countIf(_in and characteristics.classifier == "request"),
    reqAll = countIf(characteristics.classifier == "request"),
    failAll = countIf(${FAILED_CALL}),
  by: { t = bin(start_time, ${binFor(tf.minutes)}) }
| sort t asc`;
};

/**
 * A FAILED CALL - one definition, used by the card and by its drill-down.
 *
 * This was `error.source == "fetch"` alone, measured on one estate where the
 * 404s carried exactly that. A reader then found an application whose
 * failures panel was full of `404: api...` rows above a card reading
 * "0.0% calls failed", which is the shape of a predicate that is true
 * somewhere and false here - and one field is a single point of failure when
 * the question is "did a call fail".
 *
 * So the test is the UNION of the signals, each sufficient on its own and
 * none of which a JavaScript exception carries:
 *   - `error.type == "request"` - the platform filed it as a request error
 *   - `error.source == "fetch"` - raised by the fetch/XHR layer
 *   - an HTTP status of 400 or worse on the record itself
 * An exception in the page's own code has no request type, no fetch source
 * and no status code, so it stays out - which is what keeps this number
 * different from the errors card beside it, on purpose.
 *
 * Why not status codes off the `request` records: those carry only 200 and
 * 201 on both measured estates. Counting 4xx/5xx there returned 0 failures
 * against 598 real ones.
 */
export const FAILED_CALL = `characteristics.classifier == "error"
      and (error.type == "request" or error.source == "fetch"
        or coalesce(toLong(http.response.status_code), 0) >= 400)`;

/**
 * THE CARD'S HEADLINE NUMBERS, FROM THE METRIC STORE.
 *
 * Everything on the Overview card was computed by scanning raw `user.events`
 * — sessions, errors, crashes, ANRs, requests, user actions. On a bank's
 * production application those scans take tens of seconds, and the platform
 * has had the same figures pre-aggregated the whole time:
 *
 *   dt.frontend.session.active.estimated_count   sessions (a cardinality
 *                                                metric: countDistinct)
 *   dt.frontend.error.count                      errors, with error.type as
 *                                                a dimension (crash, anr…)
 *   dt.frontend.request.count                    requests
 *   dt.frontend.user_action.count                user actions
 *
 * A metric read answers in milliseconds and scans no Grail bytes, so this is
 * faster AND cheaper than what it replaces. `scalar: true` collapses each
 * series to one number, which is what a headline is.
 *
 * IT DOES NOT REPLACE THE MEASUREMENTS, IT ARRIVES BEFORE THEM. The event
 * scans still run and still decide the final figures, because they answer
 * questions a counter cannot: which sessions met an error, which view, which
 * endpoint. This is what the card shows while that is happening, and the
 * reader is told it is still firming. Where the two disagree, the measured
 * one wins — a metric is an estimate by its own name.
 */
export const qAppVitals = (tf: Timeframe, frontendName: string) => {
  const fe = frontendName.replace(/["\\]/g, "");
  return `
timeseries {
    sessions = countDistinct(dt.frontend.session.active.estimated_count, scalar: true),
    users = countDistinct(dt.frontend.user.active.estimated_count, scalar: true),
    errors = sum(dt.frontend.error.count, scalar: true),
    crashes = sum(dt.frontend.error.count, filter: { error.type == "crash" }, scalar: true),
    anrs = sum(dt.frontend.error.count, filter: { error.type == "anr" }, scalar: true),
    requests = sum(dt.frontend.request.count, scalar: true),
    actions = sum(dt.frontend.user_action.count, scalar: true)
  },
  from: ${tf.from}, to: ${tf.to},
  filter: { frontend.name == "${fe}" }
| limit 1`;
};

/**
 * THE COUNTERS' SERIES FROM THE METRIC STORE — the forecast's canonical input.
 *
 * The forecasts (and the card's bars behind them) were trained on
 * `fetch user.events | makeTimeseries …` over three hours: a raw-event scan,
 * seconds per round, four times over. The platform's own forecasting guide
 * takes a `timeseries` query with an explicit `interval:` as its input, and
 * the metric store answers that in ~200 ms (measured: qAppVitals, three
 * production loads). Same quantities — dt.frontend.error.count,
 * request.count, user_action.count — pre-aggregated over the whole window,
 * so a complete value, never a partial scan: integrity-clean as a FINAL.
 *
 * Sessions are deliberately NOT here. dt.frontend.session.active.estimated_count
 * would be a third definition of "sessions" beside the session store and the
 * event scan — estimated, by its own name — and the headline, the chart and
 * the hand-off have only just been made to agree. Coherence over speed.
 *
 * Trimmed by the same beacon lag as every live series: the newest minutes of
 * a metric fed by beacons are as incomplete as the events behind it.
 */
export const qAppMetricSeries = (tf: Timeframe, frontendName: string) => {
  const fe = frontendName.replace(/["\\]/g, "");
  return `
timeseries {
    errors = sum(dt.frontend.error.count),
    requests = sum(dt.frontend.request.count),
    actions = sum(dt.frontend.user_action.count)
  },
  from: ${tf.from}, to: ${eventSeriesEnd(tf)}, interval: ${binFor(tf.minutes)},
  filter: { frontend.name == "${fe}" }
| limit 1`;
};

/** One counter, as the forecast analyzer's input: history [from, to], one
 *  series, explicit interval — the shape the platform documents. */
export const qMetricForecastExpr = (
  metric: "errors" | "requests" | "actions" | "sessions",
  frontendName: string, from: string, to: string, interval: string,
) => {
  const fe = frontendName.replace(/["\\]/g, "");
  // sessions is a cardinality metric: countDistinct per bin, not sum
  const agg = metric === "sessions"
    ? "countDistinct(dt.frontend.session.active.estimated_count)"
    : `sum(${{ errors: "dt.frontend.error.count", requests: "dt.frontend.request.count",
      actions: "dt.frontend.user_action.count" }[metric]})`;
  return `timeseries ${metric} = ${agg}, from: ${from}, to: ${to}, interval: ${interval},
  filter: { frontend.name == "${fe}" }
| limit 1`;
};

/** ERRORS PER USER ACTION, for the verdict's forecast. The error COUNT rises
 *  with traffic, and more people is not a degradation; the rate per action
 *  does not. Both metrics come from the metric store (no Grail scan), and the
 *  action metric matched the events exactly in every staging capture. Bins with
 *  no action are null, not infinite. */
export const qMetricErrorRateExpr = (
  frontendName: string, from: string, to: string, interval: string,
) => {
  const fe = frontendName.replace(/["\\]/g, "");
  return `timeseries { e = sum(dt.frontend.error.count), a = sum(dt.frontend.user_action.count) },
  from: ${from}, to: ${to}, interval: ${interval},
  filter: { frontend.name == "${fe}" }
| fieldsAdd rate = if(a[] > 0, toDouble(e[]) / a[], else: null)
| fields timeframe, interval, rate
| limit 1`;
};

/** The same rate from events, for an application with no frontend name. */
export const qEventErrorRateExpr = (rumAppId: string, from: string, to: string, interval: string) => `
fetch user.events, from: ${from}, to: ${to}
| filter dt.rum.application.id == "${rumAppId.replace(/["\\]/g, "")}"
| filter characteristics.classifier == "error" or characteristics.classifier == "user_action"
| makeTimeseries { e = countIf(characteristics.classifier == "error"),
    a = countIf(characteristics.classifier == "user_action") }, interval: ${interval}
| fieldsAdd rate = if(a[] > 0, toDouble(e[]) / a[], else: null)
| fields timeframe, interval, rate`;

/** Most requested paths (layers 04/05). */
export const qPaths = (tf: Timeframe, rumAppId?: string | null) => `
fetch user.events, from: ${tf.from}, to: ${tf.to}${scopeApp(rumAppId)}
| filter characteristics.classifier == "request" and isNotNull(url.path)
| summarize reqs = count(), p50 = percentile(toLong(duration), 50),
    p90 = percentile(toLong(duration), 90),
  by: { appId = dt.rum.application.id, path = url.path,
        method = http.request.method, status = http.response.status_code }
| filter isNotNull(appId)
| sort reqs desc | limit 80`;

/** Browser and transport protocol (layers 01/02). */
export const qTransport = (tf: Timeframe, rumAppId?: string | null) => `
fetch user.events, from: ${tf.from}, to: ${tf.to}${scopeApp(rumAppId)}
| filter characteristics.classifier == "request"
| summarize reqs = count(), ttfb = percentile(toLong(web_vitals.time_to_first_byte), 50),
  by: { browser = browser.name, protocol = performance.next_hop_protocol, provider = url.provider }
| sort reqs desc | limit 15`;

/* ─────────────── Smartscape ─────────────── */

/** Row ceilings for the free (Smartscape) and cheap (open signals) legs —
 *  shared with the client caps in useChainData so neither can cut the other. */
export const TOPOLOGY_CAP = 50000;
export const SIGNALS_CAP = 20000;

/** Service-to-service call graph — the backbone of the delivery chain. */
export const qServiceCalls = () => `
smartscapeEdges "calls"
| filter source_type == "SERVICE" and target_type == "SERVICE"
| lookup [smartscapeNodes "SERVICE" | fields id, name], sourceField: source_id, lookupField: id, prefix: "s_"
| lookup [smartscapeNodes "SERVICE" | fields id, name], sourceField: target_id, lookupField: id, prefix: "t_"
| fields srcId = source_id, src = s_name, dstId = target_id, dst = t_name
// Smartscape reads no Grail bytes; a ceiling here only ever drops edges. On
// a bank's estate the client's 200 was hit exactly, so chains were missing
// services. The client cap (useChainData) must match this one.
| limit ${TOPOLOGY_CAP}`;

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
// A pod or node with no name in Smartscape (measured on staging: the lookup
// returned null for some pods) still has an id — the name falls back to it,
// so every row names its thing and no consumer meets a null.
| fields podId = source_id, pod = coalesce(p_name, p_id_classic, source_id),
    podClassic = p_id_classic,
    nodeId = target_id, node = coalesce(n_name, n_id_classic, target_id),
    nodeClassic = n_id_classic
| limit ${TOPOLOGY_CAP}`;

/** Frontends registered in Smartscape. */
/* LIMIT SIZED FOR A REAL ESTATE, NOT A DEMO ONE. At 100 a production tenant's
   frontend simply was not in the answer, so the picker fell back to
   "Application 1a2b3c4d" — and because the sessions facet's name comes from
   the same inventory, the whole session-store path quietly reverted to the
   event store. Smartscape is a topology read: it scans no Grail bytes, so the
   ceiling costs nothing to raise. */
export const qFrontends = () => `smartscapeNodes "FRONTEND" | fields id, name | limit 1000`;

/** Node count per type — used in the topology summary. */
export const qTopologyCounts = () => `
smartscapeNodes "*" | summarize nodes = count(), by: { type }
| filter in(type, {"SERVICE", "K8S_POD", "K8S_NODE", "K8S_CLUSTER", "K8S_NAMESPACE", "FRONTEND", "HOST"})
| sort nodes desc`;

/* ─────────────── Davis, alerts and extensions ─────────────── */

/**
 * Active problems detected by the AI, over the window on screen.
 *
 * These read 24 hours no matter what the reader had selected, which made the
 * chain describe a different period from every number beside it — and cost
 * accordingly: measured on a live estate, the Davis reads were 26 of the
 * 31 GiB one Overview load scanned. The platform's own apps default to two
 * hours and follow the picker; so does this now.
 *
 * WHAT THAT COSTS IN MEANING, stated because it is a real trade: a problem
 * that opened twenty hours ago and has emitted nothing since will not appear
 * in a two-hour window. Davis re-emits while a problem is open, so an active
 * one normally does land in the window — but a quiet long-running problem can
 * fall out of a narrow view. Widening the picker brings it back, which is the
 * contract the rest of this product already has with the timeframe.
 */
export const qProblems = (tf: Timeframe) => `
fetch dt.davis.problems, from: ${tf.from}, to: ${tf.to}
| filter event.status == "ACTIVE"
// Davis marks re-raised problems as duplicates of an original. Every example
// in the platform's own guidance drops them, and counting one incident twice
// would overstate the blast radius a route is meant to size. Measured on this
// estate it currently changes nothing — 5 active problems, 5 distinct ids,
// none flagged — so this is a guard against a case that has not happened yet.
| filter not(dt.davis.is_duplicate)
| fields eventId = event.id, display_id, name = event.name, category = event.category,
    affected = affected_entity_types, entityIds = affected_entity_ids, start = event.start
// Newest first, so if an estate ever has more than 500 open problems the ones
// we drop are the oldest, not an arbitrary slice — and 500 is far above any
// real active count, so "no problems detected" can never be a cap artefact.
| sort start desc
| limit 500`;

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
 * 0.36 GB against 1.06 GB — three times the spend for an identical answer.
 *
 * TWO ROUND TRIPS, NOT A JOIN. This used to carry the span fetch as a join
 * subquery, and the subquery could only be filtered by `isNotNull(service)` —
 * the left side's trace ids are not visible inside it, so it read the whole
 * window. On a large estate that hits the platform's own ceiling: measured on a
 * customer estate, HTTP 400 `JOIN_RIGHT_TABLE_SIZE`, "the join command's
 * subquery read too much data", and the chain's service layer came back empty
 * with no visible reason. Asking for the ids first and filtering the spans BY
 * them removes the subquery entirely, so no join limit applies and the span
 * side is selective instead of exhaustive.
 */
/**
 * WHAT THIS ENVIRONMENT ACTUALLY SENDS, asked only when the application picker came
 * back empty.
 *
 * Every journey this product draws is mined from `user.events`, which is
 * Dynatrace RUM: 34 of the app's queries read it, and the picker itself
 * enumerates FRONTEND nodes by `dt.rum.instrumentation.id`. A customer whose
 * primary source is OpenTelemetry has spans and services but no such
 * application, and the app used to answer that with a blank page.
 *
 * OTel defines `session.id` in its semantic conventions, so a journey mine over
 * spans is conceivable — but only if the CLIENT is instrumented. Measured on a
 * live estate: 147,200 OTel spans in two hours, 9 of them carrying a session
 * id. So this counts rather than assumes, and the page reports what it found.
 */
export const qTelemetryShape = () => `
fetch spans, from: now()-2h
| summarize spans = count(),
    otel = countIf(telemetry.sdk.name == "opentelemetry"),
    sessionSpans = countIf(isNotNull(session.id)),
    services = countDistinct(${SVC_ID})`;

/**
 * @param since how far back to look. Ten minutes answers a busy application
 *   for a twelfth of the spend, but an application with a dozen sessions in two
 *   hours has no trace at all in a ten-minute window — and an empty answer
 *   there reads as "this application reaches no backend", which is a different
 *   claim entirely. So the caller escalates rather than concluding.
 */
/* ONLY THE EVENTS THAT CARRY A TRACE (0.17.42). trace.id lives on request
   events (W3C trace context) and on navigations (Server-Timing); filtering
   the classifier first is what cuts the bytes Grail reads — the id filter
   only cut rows, and on a large application this probe read ≈25–37 GiB on
   every page open. */
export const qAppTraceIds = (rumAppId: string, since = "now()-10m") => `
fetch user.events, from: ${since}
| filter characteristics.classifier == "request" or characteristics.classifier == "navigation"
| filter dt.rum.application.id == "${rumAppId.replace(/["\\]/g, "")}" and isNotNull(trace.id)
| summarize n = count(), by: { trace.id }
| sort n desc
| limit 300
| fields trace.id`;

/** The services those traces crossed. Empty id list means no question to ask. */
export const qAppServices = (traceIds: string[], since = "now()-10m") => `
fetch spans, from: ${since}
// TRACE ID IS A uid IN THE SPAN STORE, not a string, and \`in\` compares types:
// matching it against quoted ids silently returned ZERO rows, which the chain
// drew as "no trace reaches a service". The platform says so in a warning
// rather than an error, so the query succeeds and lies. Cast, then compare.
| fieldsAdd tid = toString(trace.id)
| filter in(tid, { ${traceIds.slice(0, 300)
    .map((i) => `"${String(i).replace(/["\\]/g, "")}"`).join(", ")} })
| filter isNotNull(dt.entity.service) or isNotNull(dt.smartscape.service)
| summarize traces = countDistinctExact(trace.id), by: { svc = ${SVC_ID} }
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
 * trace ids that are PurePaths — they lived only in the classic engine when
 * this was written (measured then: 88k events with trace.id, zero span
 * matches). RE-MEASURED 2026-08-16: that invariant is GONE — 1,108 of 78,619
 * RUM events now carry trace ids that DO join Grail spans, and the 10-minute
 * join alone returns 7 services. The chain still renders correctly because
 * the trace join and this classic walk AGREE on a live estate; if they ever
 * diverge, useAppScope's union would double-source volumes. Watch it.
 * The classic entity model still
 * knows the truth: `calls[dt.entity.service]` is the same relationship the
 * Service Flow screen draws. No volume comes with it, only membership.
 */
export const qAppServicesTopo = (rumAppId: string) => `
smartscapeEdges "calls"
| filter target_type == "SERVICE"
| filter source_id in [ smartscapeNodes "FRONTEND"
    | filter dt.rum.instrumentation.id == "${rumAppId.replace(/["\\]/g, "")}"
    | fields id ]
| lookup [ smartscapeNodes "SERVICE" | fields id, nm = name ],
    sourceField: target_id, lookupField: id, fields: { nm }
| summarize name = takeAny(nm), by: { svc = target_id }
| fieldsAdd traces = 0
| limit 60`;

/** The same bridge, entered by CLASSIC ENTITY ID instead of the RUM id —
 *  one node type now serves web and mobile alike, so this is the same walk
 *  with a different key, not a second relationship. */
export const qAppServicesTopoMobile = (entityId: string) => `
smartscapeEdges "calls"
| filter target_type == "SERVICE"
| filter source_id in [ smartscapeNodes "FRONTEND"
    | filter id_classic == "${entityId.replace(/["\\]/g, "")}"
    | fields id ]
| lookup [ smartscapeNodes "SERVICE" | fields id, nm = name ],
    sourceField: target_id, lookupField: id, fields: { nm }
| summarize name = takeAny(nm), by: { svc = target_id }
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
// id_classic travels too — Davis attributes k8s events to the CLASSIC forms
// (CLOUD_APPLICATION_INSTANCE-, KUBERNETES_NODE-), and the audit measured 11
// active events that could never light a card keyed by Smartscape id alone
| join [ smartscapeNodes "*" | fields id, nm = name, tp = type, idc = id_classic ],
    on: { left[target] == right[id] }, fields: { nm, tp, idc }
| fields src = source_id, id = target, name = nm, type = tp, classic = idc
| limit 800`;

/**
 * The selected component's own vitals — latency percentiles, throughput and
 * failures — fetched on click, never up front: paying for 86 services to
 * answer a question about one is the mistake this app keeps refusing to make.
 * Fixed 30-minute window, said on the drawer's face, for the same cost reason
 * as the trace step.
 */
export const qSvcMetrics = (id: string, tf: Timeframe) => `
fetch spans, from: ${tf.from}, to: ${tf.to}
| filter ${svcIs(id)}
| summarize p50 = percentile(toLong(duration), 50), p90 = percentile(toLong(duration), 90),
    p95 = percentile(toLong(duration), 95), thr = count(),
    fails = countIf(request.is_failed == true)
| limit 1`;

/**
 * ONE UNIT ON BOTH SIDES OF THE RATE.
 *
 * This counted VIEWS as the throughput and every ERROR EVENT as the failures,
 * then the drawer divided one by the other: 95 calls, 1,087 failed, 1144%.
 * Not a rounding problem — two different things sharing a fraction bar. An
 * application can easily record ten errors per view, and nothing about that
 * is a failure RATE.
 *
 * So the app node now measures what every other node in this chain measures:
 * calls out, calls failed, and the latency of those calls. FAILED_CALL is the
 * same predicate the Overview's "calls failed" uses, so the drawer and the
 * card can no longer disagree about what failed. View timing has not been
 * lost — it is the Render tier's own headline, p50 of the view.
 */
export const qAppMetrics = (rumAppId: string, tf: Timeframe) => `
fetch user.events, from: ${tf.from}, to: ${tf.to}
| filter dt.rum.application.id == "${rumAppId.replace(/["\\]/g, "")}"
    and (characteristics.classifier == "request" or (${FAILED_CALL}))
| fieldsAdd _req = if(characteristics.classifier == "request", 1, else: 0)
| summarize p50 = percentile(if(_req == 1, toLong(duration)), 50),
    p90 = percentile(if(_req == 1, toLong(duration)), 90),
    p95 = percentile(if(_req == 1, toLong(duration)), 95),
    thr = countIf(_req == 1), fails = countIf(_req == 0)
| limit 1`;

export const qDomMetrics = (rumAppId: string, domain: string, tf: Timeframe, ratio = 1) => `
fetch user.events, from: ${tf.from}, to: ${tf.to}${ratio > 1 ? `, samplingRatio: ${ratio}` : ""}
/* failed CALLS ride as fetch-source errors, not status >= 400 on request
 * records (those carry only 200/201 — measured on both estates) */
| filter dt.rum.application.id == "${rumAppId.replace(/["\\]/g, "")}"
    and url.domain == "${domain.replace(/["\\]/g, "")}"
    and (characteristics.classifier == "request" or (${FAILED_CALL}))
| fieldsAdd _req = if(characteristics.classifier == "request", 1, else: 0)
| summarize p50 = percentile(if(_req == 1, toLong(duration)), 50),
    p90 = percentile(if(_req == 1, toLong(duration)), 90),
    p95 = percentile(if(_req == 1, toLong(duration)), 95), thr = countIf(_req == 1),
    fails = countIf(_req == 0)
| limit 1`;

/**
 * ONE SCAN FOR TWO QUESTIONS.
 *
 * The board asked the Davis store three separate times over the same 24-hour
 * window, and measured on a live estate each of those scans cost 8.7 GiB —
 * 26.1 GiB of a 30.6 GiB page load, 85% of it, to read one store three ways.
 *
 * Two of the three were coarse counts with no expansion: "events per type and
 * provider" and "custom alerts by name". One scan at the finer grain answers
 * both, because a sum is derivable from its parts — type×provider is the
 * name-level rows added up, and the custom-alert view is the same rows
 * filtered. Measured: 1,267 rows cover all 13,383 events, so the finer grain
 * costs rows, which are free, instead of a second scan, which is not.
 *
 * The third query is NOT merged here, and deliberately. It expands
 * `affected_entity_ids` to bind each signal to what it affects, which
 * multiplies rows per event and drops the 8% of events that affect no entity
 * — a grain the other two cannot be rebuilt from without changing their
 * numbers. Saving a scan is not worth quietly altering a count.
 */
export const qDavisRollup = (tf: Timeframe) => `
fetch dt.davis.events, from: ${tf.from}, to: ${tf.to}
| summarize events = count(), by: { type = event.type, provider = event.provider,
    name = event.name, status = event.status }
// 5000, and the caller checks for truncation. Measured on a reference estate:
// 1,267 rows cover 13,383 events, so the headroom is ~4x — but a cap that is
// silently hit turns the rollup into an undercount, and an undercount wearing
// the same label as a measurement is the failure this product refuses. At the
// cap the hook records an error instead of publishing short numbers.
| sort events desc | limit 5000`;

/** Rows at the cap mean the rollup was cut — the derived counts are short. */
export const DAVIS_ROLLUP_CAP = 5000;

/** Every signal bound to the entity it actually affects — this is what lets
 *  alerts and extension events show up only under the related element. */
export const qSignalsByEntity = (tf: Timeframe) => `
fetch dt.davis.events, from: ${tf.from}, to: ${tf.to}
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
// 300 was hit exactly on a bank's estate (1,825 open events): anomalies past
// it never reached the verdict. Same read either way — the limit only trims.
| sort events desc | limit ${SIGNALS_CAP}`;

/* qCustomAlerts is gone: it was the same 24h scan of the same store, filtered
 * to two providers. Its rows are a subset of qDavisRollup's, selected in
 * memory by the hook that needs them. */

/* ─────────────── helpers ─────────────── */

export const num = (v: unknown): number => (v == null ? 0 : Number(v));
export const fmtN = (n: number) => n.toLocaleString("en-US");
/** ONE share formatter (0..1): a decimal below 10%, none above — three
 *  byte-identical copies had drifted across the board, the poster and the
 *  flow, and Pulse inlined a fourth with a different rule. */
export const fmtPct = (v: number) => `${(v * 100).toFixed(v * 100 < 10 ? 1 : 0)}%`;
/**
 * A COMPACT NUMBER THAT KEEPS SCALING PAST THOUSANDS.
 *
 * This stopped at "k", which is fine on a demo estate and absurd on a real
 * one: a bank's production application printed "27,889.1k errors" and
 * "6,608.2k sessions" — eleven characters to say 27.9M, and wide enough to
 * shove the neighbouring stat out of its cell. A number nobody can read at a
 * glance is not a compact format, it is a long one with a suffix.
 */
export const fmtK = (n: number) => {
  const one = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (n >= 1e9) return one(n / 1e9) + "B";
  if (n >= 1e6) return one(n / 1e6) + "M";
  if (n >= 1000) return one(n / 1000) + "k";
  return fmtN(n);
};
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
export const qDetailExperience = (tf: Timeframe, rumAppId: string, ratio = 1) => `
fetch user.events, from: ${tf.from}, to: ${tf.to}${ratio > 1 ? `, samplingRatio: ${ratio}` : ""}
| filter dt.rum.application.id == "${rumAppId.replace(/["\\]/g, "")}"
    and (characteristics.classifier == "user_action"
      or characteristics.classifier == "error")
// Experience per view, the platform's own rating: experience.level × weight
// (see qExperienceByPlace). One scan; the same rule as the hero and the map.
| fieldsAdd _act = characteristics.classifier == "user_action"
| fieldsAdd _w = coalesce(experience.weight, 1)
| summarize vol = countIf(_act),
    errors = countIf(characteristics.classifier == "error"),
    sessions = countDistinct(dt.rum.session.id),
    p50 = percentile(if(_act, toLong(duration)), 50),
    p90 = percentile(if(_act, toLong(duration)), 90),
    p95 = percentile(if(_act, toLong(duration)), 95),
    /* DYNATRACE'S OWN RATING, as the application's Apdex is (0.17.21): the
       experience level of each action, weighted — no rule of this app's on
       top, so a screen's Apdex and the application's are one arithmetic */
    sat = sum(if(_act and experience.level == "satisfied", _w, else: 0)),
    tol = sum(if(_act and experience.level == "tolerating", _w, else: 0)),
    fru = sum(if(_act and experience.level == "frustrated", _w, else: 0)),
  by: { name = ${VIEW_NAME} }
| filter isNotNull(name) and name != "" and vol > 0
/* COSTLIEST FIRST, not busiest: the screens that keep the Apdex from 1.00 —
   frustrated plus half the tolerating — lead, which is the list a team
   improving a green score needs as much as one fixing a red one */
| fieldsAdd lost = fru + tol / 2
| sort lost desc, vol desc | limit 8`;

/**
 * Errors: what is failing, once per KIND of failure.
 *
 * `error.name` carries the id of whatever the request was for, so one broken
 * endpoint arrived as hundreds of separate rows — 596 of them saying the same
 * thing about /orders/{id}/status/latest. replacePattern collapses the id and
 * the finding is stated once, with its true weight behind it. The pattern is
 * DPL, not a regex, and the replacement is POSITIONAL: with: is rejected.
 *
 * AN ERROR IS NOT ALWAYS NAMED. Measured on a live estate: all 25 errors of one
 * application carry a null error.name — HTTP 500s with no message and no url.
 * An earlier isNotNull(name) filter dropped every one of them, so the card
 * read "27 errors" while this panel read "nothing recorded". Nothing is
 * dropped now: what cannot be named by its own name is named by what it does
 * carry, which for those rows is "HTTP 500 · request".
 */
export const qDetailErrors = (tf: Timeframe, rumAppId: string, ratio = 1) => `
fetch user.events, from: ${tf.from}, to: ${tf.to}${ratio > 1 ? `, samplingRatio: ${ratio}` : ""}
| filter dt.rum.application.id == "${rumAppId.replace(/["\\]/g, "")}"
    and characteristics.classifier == "error"
| fieldsAdd name = coalesce(
    replacePattern(error.name, "'/' INT '/'", "/{id}/"),
    exception.message,
    concat("HTTP ", toString(http.response.status_code), " · ", error.type),
    concat("unnamed ", error.type),
    "unnamed error")
| summarize vol = count(), sessions = countDistinct(dt.rum.session.id),
    real = countIf(coalesce(dt.rum.user_type, "") != "robot"
      and coalesce(dt.rum.user_type, "") != "synthetic"),
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
    // THE UNCOLLAPSED NAME, AND HOW MANY HIDE BEHIND THE ROW.
    // The name above is this app's label: an error.name with its ids replaced,
    // or — when nothing was named — a sentence this app wrote itself. The
    // Error Explorer filters on the PLATFORM's "Error Name", so handing it
    // the label matches nothing and opens an empty page that reads as a
    // working filter. These two decide whether an exact filter is possible:
    // one distinct raw name behind the row means the label IS that name and
    // can travel; more than one means the collapse did its job and there is
    // no single value to send.
    raw = takeAny(error.name), rawNames = countDistinct(error.name),
  by: { name }
| sort vol desc | limit 8`;

/**
 * Web requests per domain.
 *
 * Failures come from the ERROR events, not from status codes: measured on this
 * estate, `request` records carry only 200 and 201 — every failed call is
 * filed as an error with source "fetch". Counting 4xx/5xx off the request
 * records returned 0 failures against 598 real ones.
 */
export const qDetailRequests = (tf: Timeframe, rumAppId: string, ratio = 1) => `
fetch user.events, from: ${tf.from}, to: ${tf.to}${ratio > 1 ? `, samplingRatio: ${ratio}` : ""}
| filter dt.rum.application.id == "${rumAppId.replace(/["\\]/g, "")}"
    and (characteristics.classifier == "request" or (${FAILED_CALL}))
    and not(${DT_AGENT_REQUEST})
/* THE ENDPOINT, NOT THE HOST. This grouped by url.domain, so the drill under
   "Web requests" listed the same handful of hostnames the Called services
   card lists — two cards saying the same thing, and neither of them saying
   which REQUEST is slow or failing, which is the only reason to open this
   panel. The path is what distinguishes one endpoint from another; the
   domain stays in front of it because the same path on two hosts is two
   endpoints. coalesce keeps the fetch-error rows, which do not always carry
   a path, grouped under their host rather than dropped — and the ranking
   below counts requests AND failures, because that host-only bucket can
   hold failures with no requests of its own, and ranking it by request
   volume alone sorted it off the end of the list. The panel then showed
   eight rows of "no failures" while the card above it counted failed
   calls. */
/* THE NAME A TRACE WOULD USE. This was host+path, which repeated the same
   40-character hostname on all eight rows and pushed the part that
   distinguishes them off the end of the column - the reader saw eight
   truncations and no endpoints. A span's Endpoint attribute reads
   "GET /glog/index.faces": method, space, path. Same string here, so the
   row and the trace it opens call one endpoint by one name. The host stays
   as its own field - it is what the trace hand-off filters on, and it is
   printed beside the name rather than inside it. */
| fieldsAdd ep = if(isNull(url.path), url.domain,
    else: if(isNull(http.request.method), url.path,
      else: concat(http.request.method, " ", url.path)))
| summarize vol = countIf(characteristics.classifier == "request"),
    /* THE HOST SURVIVES THE REGROUPING. Pulse hands each row's name to
       useDomainTraces, which matches it against a span's server address — so
       the moment the name became an endpoint, every row stopped matching and
       the trace hand-off went quiet. The host is still one value per row
       (the endpoint contains it), so it rides along as its own field. */
    domain = takeAny(url.domain),
    // the SAME predicate the card counts with, named once in FAILED_CALL -
    // the panel and the headline disagreeing about what a failure is was
    // exactly the defect this replaced
    failures = countIf(${FAILED_CALL}),
    sessions = countDistinct(dt.rum.session.id),
    p50 = percentile(if(characteristics.classifier == "request", toLong(duration)), 50),
    p90 = percentile(if(characteristics.classifier == "request", toLong(duration)), 90),
    p95 = percentile(if(characteristics.classifier == "request", toLong(duration)), 95),
  by: { name = ep }
| filter isNotNull(name) and name != ""
| fieldsAdd weight = vol + failures
| sort weight desc | limit 8`;

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
  by: { dt.entity.service, dt.smartscape.service, dt.service.name },
  filter: { ${ids.slice(0, 40).map(svcIs).join(" or ")} }
| fieldsAdd p50 = arrayFirst(p50) * 1000, p90 = arrayFirst(p90) * 1000,
    p95 = arrayFirst(p95) * 1000,
    calls = arrayFirst(calls), fails = arrayFirst(fails)
// the name is carried out of the SAME field the Services Explorer filters on,
// so the drill-down cannot be filtering by a name that field does not hold
| fields id = ${SVC_ID}, name = dt.service.name, p50, p90, p95, calls, fails
| limit 40`;

/**
 * The provider behind a host: instance, then zone.
 *
 * Validated against Smartscape Gen3 on a live estate before it became code:
 *
 *   HOST-<id> (ip-<redacted>, 15 services)
 *     runs_on → AWS_EC2_INSTANCE-B1CFB55F52DF66F6
 *       runs_on → AWS_AVAILABILITY_ZONE  (use1-az4)
 *   HOST-<id> (gke-…)
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
 * COVERAGE, honestly: AWS and GCP are verified end to end against a live estate.
 * Azure is listed from its entity types and has NOT been observed carrying a
 * host, so it is written but unproven. Azure models VMs inside scale sets and
 * reaches a location rather than a zone, so its second hop may need its own
 * handling when a live estate with Azure hosts turns up.
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
 * Gen3 Databases app (dynatrace.database.overview — read off a live estate's
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
/* the STRONG arm first: the instance node itself names the host it answers
 * on (measured: DB1's db.connection_details.hostname == the store's RDS
 * address). The bare-name arms stay as fallback, but an address match wins
 * the sort below — "DB1" is a generic SID and matching it alone made the
 * reader ask whether the right database had opened. */
| fieldsAdd exact = if(db.connection_details.hostname == "${a}", 1, else: 0)
| filter db.connection_details.hostname == "${a}"
    or name == "${a}"${n ? ` or name == "${n}"` : ""}
    or contains(name, "@${a}") or startsWith(name, "${a}:")
| fields id, type, name, exact
| sort exact desc
| limit 4`;
};

/**
 * Every store address resolved to its DB entity in ONE Smartscape lookup —
 * the per-click qDbEntity, batched, so store CARDS can carry entity ids up
 * front. Why it matters (audit, 2026-08-25): a live estate's active database
 * health alerts bind to the instances' CLASSIC ids (CUSTOM_DEVICE-…), and a
 * card with no ids can never light — the Databases app showed a store's
 * "Configuration" alert while our chain painted it calm.
 */
export const qDbEntities = (targets: Array<{ addr: string; ns?: string }>) => {
  const esc = (v: string) => v.replace(/["\\]/g, "");
  const arm = (t: { addr: string; ns?: string }) => {
    const a = esc(t.addr); const n = esc(t.ns ?? "");
    return `(db.connection_details.hostname == "${a}" or name == "${a}"`
      + (n ? ` or name == "${n}"` : "")
      + ` or contains(name, "@${a}") or startsWith(name, "${a}:"))`;
  };
  return `
smartscapeNodes "*"
| filter startsWith(type, "DB_INSTANCE_") or startsWith(type, "DB_DATABASE_")
| filter ${targets.slice(0, 12).map(arm).join(" or ")}
| fields id, classic = id_classic, type, name, host = db.connection_details.hostname
| limit 40`;
};

/**
 * Whether a silent window means a sleeping application or a dead one.
 *
 * "No coverage" and "no traffic right now" are different findings wearing
 * the same empty column — the reader saw a quiet app and asked whether it
 * had users at all. Measured for easyTravel Mobile: 0 sessions in 2h, 21 in
 * 24h — asleep, not uninstrumented. One small user.sessions scan (the
 * compact store), asked only when the window shows zero.
 */
export const qQuietProbe = (entityId: string) => `
fetch user.sessions, from: now()-24h
| expand ent = dt.rum.application.entities
| filter ent == "${entityId.replace(/["\\]/g, "")}"
| summarize sessions = count(), last = max(start_time)`;

/**
 * The provider behind a serverless placement.
 *
 * A lambda-backed service produces no HOST, so the Cloud layer — born only
 * from hosts — never existed for it, and the chain ended at Run while the
 * platform knew better. Measured on a live estate: the AWS_LAMBDA_FUNCTION node
 * itself carries cloud.provider "aws", aws.region "us-east-1" and
 * aws.account.id — the whole Provider card, as node properties, no edge
 * needed. A region is not an availability zone, and the card says region.
 */
export const qLambdaPlacement = (fnIds: string[]) => `
smartscapeNodes "AWS_LAMBDA_FUNCTION"
/* toSmartscapeId, ALWAYS — a Smartscape id compared to a raw string is
 * false on every row (project rule #1), so this filter matched nothing */
| filter ${fnIds.slice(0, 40)
  .map((f) => `id == toSmartscapeId("${f.replace(/["\\]/g, "")}")`).join(" or ")}
| fields fn = id, name, region = aws.region, account = aws.account.id
| limit 40`;

/**
 * The data stores this application's services talk to.
 *
 * NOT from Smartscape, and that was measured rather than assumed. On this
 * estate Smartscape holds 14 AWS_RDS_DBINSTANCE and 36 AWS_DYNAMODB_TABLE
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
/* 1-in-10 (0.17.17): measured 25 GiB on production for the stores a few
   services call — a store a service uses at any rate still shows up; its
   counts are scaled back by DATA_STORE_SAMPLE in useDataStores. */
export const DATA_STORE_SAMPLE = 10;
export const qServiceDataStores = (serviceIds: string[]) => `
fetch spans, from: now()-10m, to: now(), samplingRatio: ${DATA_STORE_SAMPLE}
| filter isNotNull(db.system)
| filter ${serviceIds.slice(0, 40).map(svcIs).join(" or ")}
| fieldsAdd store = coalesce(server.address, db.namespace, db.system)
| summarize calls = count(),
    rated = countIf(isNotNull(span.status_code)),
    errors = countIf(span.status_code == "ERROR"),
    p50 = percentile(duration, 50), p90 = percentile(duration, 90),
  by: { svc = ${SVC_ID}, store, sys = db.system, ns = db.namespace }
| sort calls desc
| limit 40`;

/**
 * What the CLASSIC topology says these services call — used only for what
 * Smartscape does not know.
 *
 * Measured on a live estate, on the easyTravel mainframe application, and this is
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
export const qServicesGen2Calls = (serviceIds: string[]) => {
  const ids = serviceIds.slice(0, 60).map((s) => `"${s.replace(/["\\]/g, "")}"`).join(",");
  /* THE RIGHT SIDE IS ONLY THE CALLEES (0.17.4). It was every service of the
     estate, joined in full — measured 29 s on a bank's environment for a
     handful of rows. Narrowed to the ids the left side calls, the same rows. */
  return `
fetch dt.entity.service, from: now()-2h
| filter in(id, {${ids}})
| fields src = id, tgt = calls[dt.entity.service]
| filter isNotNull(tgt)
| expand tgt
| join [ fetch dt.entity.service, from: now()-2h
         | filter id in [ fetch dt.entity.service, from: now()-2h
             | filter in(id, {${ids}})
             | fields tgt = calls[dt.entity.service]
             | expand tgt
             | fields tgt ]
         | fields id, nm = entity.name, st = serviceType, ro = runs_on,
                  ext = isExternalService ],
    on: { left[tgt] == right[id] }, fields: { nm, st, ro, ext }
/* An EXTERNAL WEB service is the same code seen from its caller.
 *
 * The classic model describes one running process at more than one
 * granularity, and the walk finds every level. Measured on a live estate:
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
// The ext∧WEB dedup no longer happens here: the flag+type test also killed
// real unmonitored endpoints with no monitored twin (measured: CouchDB_ET,
// 8,482 spans/2h, invisible in every layer). The rows arrive whole and
// useGen2Closure drops only the ones whose monitored twin it can NAME.
| fields src, id = tgt, name = nm, kind = st, host = ro[dt.entity.host],
    ext, stype = st
| limit 80`;
};

/**
 * A service's vitals from the METRIC STORE, for services that have no spans.
 *
 * The drawer reads spans, which is right for anything OneAgent traces into
 * Grail — and wrong for everything else. Measured on a live estate: `MF
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
export const qSvcMetricsFallback = (id: string, tf: Timeframe) => `
timeseries { rt = avg(dt.service.request.response_time),
             ct = sum(dt.service.request.count),
             fl = sum(dt.service.request.failure_count) },
  from: ${tf.from}, to: ${tf.to},
  filter: { ${svcIs(id)} }
| fieldsAdd avgNs = arrayAvg(rt) * 1000, calls = arraySum(ct), fails = arraySum(fl)
| fields avgNs, calls, fails
| limit 1`;

/**
 * Applications the inventory knows and RUM did not report on — with the
 * backend the CLASSIC model says each one calls.
 *
 * The selector is built from `user.events`, which is right for anything
 * sending RUM to Grail and silently wrong for everything else. Measured on
 * a live estate: `easyTravel Mobile (mainframe)` has ZERO events in seven days,
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
smartscapeNodes "FRONTEND"
| filter id in [ smartscapeEdges "calls"
    | filter source_type == "FRONTEND" and target_type == "SERVICE"
    | fields source_id ]
| fields id = id_classic, name, rumId = dt.rum.instrumentation.id,
    kind = frontend.type
| limit 200`;

/**
 * The services one application calls, straight from the classic model.
 *
 * Used as the scope's seed when neither the trace join nor Smartscape found
 * anything — the third source, asked last. Verified on
 * MOBILE_APPLICATION-<id>: the seed is `MF EasyTravelWebserver:9079`,
 * and walking `calls` from there reaches MF EasytravelService,
 * ConfigurationService, BookingService, JourneyService, VerificationService,
 * AuthenticationService, CheckDestination and MF easyTravelBusiness — the
 * service flow's own picture, rebuilt from the entity model.
 */
export const qAppSeedGen2 = (entityId: string) => {
  const e = entityId.replace(/["\\]/g, "");
  return `
smartscapeEdges "calls"
| filter target_type == "SERVICE"
| filter source_id in [ smartscapeNodes "FRONTEND"
    | filter id_classic == "${e}" | fields id ]
| lookup [ smartscapeNodes "SERVICE" | fields id, nm = name ],
    sourceField: target_id, lookupField: id, fields: { nm }
| fields svc = target_id, name = nm
| limit 40`;
};

/**
 * Sessions per application and per origin — the Consume layer's own query.
 *
 * It used to read the device-profile rows, and those are a TOP-20 over the
 * whole environment: grouped by application AND resolution AND pixel ratio AND
 * orientation, twenty rows is a handful of the busiest applications. Measured
 * on a live estate — 248 profile rows across 14 applications, and the top twenty
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
/**
 * The midpoint of a live window, for the free trend split: rows in the
 * second half against the first half is a projection the scan already paid
 * for (countIf columns cost nothing). A shifted window (to ≠ now) gets no
 * midpoint — its "trend" would describe the past and read as a forecast.
 */
const tfMid = (tf: Timeframe): string | null =>
  // tf.to is the DQL form tfFrom emits — "now()", not "now"; comparing the
  // bare word made every live window's midpoint now() and every "late" 0
  /^now\(?\)?$/i.test(tf.to.trim())
    ? `now()-${Math.max(1, Math.round(tf.minutes / 2))}m` : null;

/**
 * SCOPED TO THE APPLICATION ON SCREEN, BECAUSE THE FILTER IS THE BILL.
 *
 * This scanned the whole estate and the client then kept the rows of the one
 * application it was showing — every consumer filters by appId, so the other
 * applications' rows were scanned, paid for and thrown away. Harmless on a
 * demo tenant; on a bank's production estate it is what pushed the landing
 * page past Grail's 500 GB scan limit, and a truncated answer is not a slow
 * answer — it is a wrong one that reports success.
 *
 * Measured and written in this app's own README: a bare count and an
 * eight-column summarize scan the same bytes, so projections are free, but
 * scoping to one application cut a 2-hour window from 5.9 GB to 2.9 GB, and
 * to a small application 0.24 GB. The filter is the only lever that moves,
 * and it was the one not being pulled.
 */
export const qOrigins = (tf: Timeframe, session?: string | null,
  rumAppId?: string | null) => {
  const mid = tfMid(tf);
  return `
fetch user.events, from: ${tf.from}, to: ${tf.to}${onlySession(session)}${scopeApp(rumAppId)}
| summarize agent = takeAny(dt.rum.agent.type),
    // deterministic, like qDevices: a session carrying both robot and human
    // events must land in the SAME origin every run
    utype = if(countIf(dt.rum.user_type == "robot") > 0, "robot",
      else: if(countIf(dt.rum.user_type == "synthetic") > 0, "synthetic",
      else: takeAny(dt.rum.user_type))),
    res = takeAny(concat(device.screen.width, "×", device.screen.height)),
    views = countIf(characteristics.classifier == "view_summary"),
    // start_time, NOT timestamp: measured, timestamp is null on every
    // user.events row of a live estate (14,099 of 14,099 sessions)
    t0 = min(start_time),
    // whether THIS session met an error — summed per origin below it makes
    // the per-origin impact MEASURED; the audit found it was a proportional
    // estimate of the app total, worn as an exact number
    // affected by an error (USER_HIT), the rule the verdict uses
    hit = max(if(${USER_HIT}, 1, else: 0)),
  by: { appId = dt.rum.application.id, sid = dt.rum.session.id }
| summarize sessions = count(), views = sum(views),
    profiles = countDistinct(res),
    /* null (not now()) on shifted windows — "unknown" must stay unknown,
     * or every origin forecasts "falling to 0" on an absolute range */
    late = ${mid ? `countIf(t0 >= ${mid})` : "toLong(null)"},
    hitSessions = sum(hit),
  by: { appId, agent, utype }
| filter not(startsWith(appId, "APPLICATION-")) and isNotNull(appId) and appId != ""
| sort sessions desc
| limit 200`;
};


/**
 * ACCESS AND HEALTH BY LOCATION — one summarize over the window.
 *
 * geo.country.iso_code rides every RUM event, so the tile costs a single
 * scan leg: sessions per country, and the sessions that met an error, from
 * the same rows. Health is judged in the tile against the application's own
 * error share, not an absolute bar — a 2% hit rate is a finding in an app
 * averaging 0.5% and noise in one averaging 4%.
 */
/**
 * THE MAP FROM THE PLATFORM'S OWN METRICS (Marcelo, 2026-10-23: "a Dynatrace
 * já tem os mapas e métricas"). The event-store map read the application's
 * whole window — ~218 GiB and 12-19 s per open on a production application —
 * and every country click read three more full scans (~750 GiB). The
 * dt.frontend.* metrics carry geo.country.iso_code and answer in well under a
 * second from the metric store. What they do not carry is said where it is
 * shown: no states, no "sessions affected", and sessions are the platform's
 * estimate. The application's verdict stays on the exact event pass.
 */
/* THREE READS, IN THE FORMS ALREADY PROVEN IN PRODUCTION. The first cut asked
   for the session cardinality metric and the two counters in one braced
   timeseries; that combination had never run against real data, and on the
   a customer staging estate the map came back empty. Each read below is the exact
   shape the comparison panel validated (sessions by country; summed counters;
   first-byte percentile), joined by country in useGeo. */
export const qGeoMetrics = (tf: Timeframe, frontendName: string) => `
timeseries sessions = countDistinct(dt.frontend.session.active.estimated_count, scalar: true),
  from: ${tf.from}, to: ${tf.to},
  filter: { frontend.name == "${frontendName.replace(/["\\]/g, "")}" },
  by: { geo.country.iso_code }
| fieldsAdd country = geo.country.iso_code
| filter isNotNull(country)
| sort sessions desc
| limit 40`;
/* ONE METRIC PER READ. Two sums in one timeseries are joined on their
   dimensions: an application with no user-action series (a mobile app whose
   actions are not reported) made the joined answer EMPTY, errors included —
   measured on a customer staging estate, every country read "—". Each counter
   is its own read now; one missing cannot erase the other. */
export const qGeoCountMetric = (tf: Timeframe, frontendName: string,
  metric: "errors" | "actions") => `
timeseries ${metric} = sum(${metric === "errors" ? "dt.frontend.error.count" : "dt.frontend.user_action.count"}, scalar: true),
  from: ${tf.from}, to: ${tf.to},
  filter: { frontend.name == "${frontendName.replace(/["\\]/g, "")}" },
  by: { geo.country.iso_code }
| fieldsAdd country = geo.country.iso_code
| limit 200`;

/** The platform's experience weights of real people's actions, per country
 *  and level — the same rating the application's score is summed from, so a
 *  country is judged by the verdict's own measure (0.17.0), for ≈0 GiB. */
export const qGeoExperienceMetric = (tf: Timeframe, frontendName: string) => `
timeseries w = sum(dt.frontend.experience.weight, scalar: true),
  from: ${tf.from}, to: ${tf.to},
  filter: { frontend.name == "${frontendName.replace(/["\\]/g, "")}" and dt.rum.user_type == "real_user" },
  by: { geo.country.iso_code, experience.level }
| fieldsAdd country = geo.country.iso_code, level = experience.level
| limit 600`;

/** First-byte time p75 per country, web only (mobile has no such metric). */
export const qGeoTtfbMetric = (tf: Timeframe, frontendName: string) => `
timeseries ttfb = percentile(dt.frontend.web.navigation.time_to_first_byte, 75, scalar: true),
  from: ${tf.from}, to: ${tf.to},
  filter: { frontend.name == "${frontendName.replace(/["\\]/g, "")}" },
  by: { geo.country.iso_code }
| fieldsAdd country = geo.country.iso_code
| limit 40`;

export const qGeo = (tf: Timeframe, rumAppId: string) => `
fetch user.events, from: ${tf.from}, to: ${tf.to}
| filter dt.rum.application.id == "${rumAppId.replace(/["\\]/g, "")}"
| filter isNotNull(geo.country.iso_code)
${PLACE_SCORE_FIELDS}
| summarize
    sessions = countDistinct(dt.rum.session.id),
    hitSessions = countDistinct(if(${USER_HIT},
      dt.rum.session.id, else: null)),
    // LATENCY per region, from the same rows: ttfb embeds the network route
    // to the user, and projection is free — this column costs no extra scan
    ttfbMs = percentile(toDouble(ttfb.value), 75),
    // REAL PEOPLE, as the application's verdict counts them — so a place is
    // judged on the same population as the page header
    realSessions = countDistinct(if(_xreal, dt.rum.session.id, else: null)),
    realHit = countDistinct(if(_xreal and ${USER_HIT},
      dt.rum.session.id, else: null)),
    // the place's experience score — the platform's rating, real people
    // only, the same weighted counts the hero sums (see PLACE_SCORE_FIELDS)
    ${PLACE_SCORE_SUMS},
  by: { country = geo.country.iso_code }
| sort sessions desc
| limit 12`;


/**
 * INSIDE ONE COUNTRY: its states, and its cities.
 *
 * The map stopped at the country because an older comment in this file said
 * city was null on every RUM row. Re-measured on a live estate: of 498,426
 * events in two hours, `geo.city.name` rides 223,457 of them (45%) and
 * `geo.region.name` 213,009 (43%). The claim was stale.
 *
 * STATES GO ON THE MAP, CITIES DO NOT, and the reason is in the data rather
 * than in effort. Strato's ChoroplethLayer paints by ISO 3166-2 — the
 * sub-national standard — which is exactly what `geo.region.iso_code`
 * carries, so a state needs no centroid table at all. A city has neither an
 * ISO code nor a coordinate: `geo.location.latitude` measured NULL on 100% of
 * rows. Nothing can be positioned from a name, so cities are a ranked list.
 *
 * ONE CAVEAT THE CALLER MUST HONOUR: the platform returns the region SUFFIX
 * alone — "CA", "NSW", "32" — while ISO 3166-2 is "US-CA", "AU-NSW", "PL-32".
 * The country has to be prefixed, and not for tidiness: "CA" on its own is
 * both California and Canada.
 *
 * Coverage travels with the rows. Where fewer than half the sessions carry a
 * location this fine, a reader adding the states up and finding less than the
 * country is owed the reason, not left to guess at a bug.
 */
export const qGeoRegions = (tf: Timeframe, rumAppId: string, iso: string) => `
fetch user.events, from: ${tf.from}, to: ${tf.to}
| filter dt.rum.application.id == "${rumAppId.replace(/["\\]/g, "")}"
| filter geo.country.iso_code == "${iso.replace(/["\\]/g, "")}"
// Named states only. Measured on a live estate, one application's US traffic
// was 419 sessions with NO region against 3 with one — and an unnamed row
// sorted to the top would have been the loudest thing on the map while saying
// nothing. The sessions without a state are not lost: the caller holds the
// country's own total and states the shortfall as coverage, which is a fact
// about instrumentation rather than a place.
| filter isNotNull(geo.region.iso_code)
${PLACE_SCORE_FIELDS}
| summarize
    sessions = countDistinct(dt.rum.session.id),
    hit = countDistinct(if(${USER_HIT},
      dt.rum.session.id, else: null)),
    // REAL PEOPLE, as the application's verdict counts them — so a place is
    // judged on the same population as the page header
    realSessions = countDistinct(if(_xreal, dt.rum.session.id, else: null)),
    realHit = countDistinct(if(_xreal and ${USER_HIT},
      dt.rum.session.id, else: null)),
    ${PLACE_SCORE_SUMS},
  by: { region = geo.region.iso_code, name = geo.region.name }
| sort sessions desc
| limit 40`;


/** What ONE COUNTRY does inside this application: its screens, and where it
 *  meets errors — the geo tile's drilldown, one leg per click, memoised. */
/**
 * The row for errors that belong to NO screen. Measured on the Android app:
 * request errors and crashes carry view.name, but ANRs — the app frozen,
 * not a page broken — arrive with view null. Filtering them out made the
 * drill's rows sum below the country's own hit count, and sent a reader
 * into a session whose error was "nowhere" on the list they came from.
 */
export const NO_SCREEN = "(no screen — app-level errors)";

export const qGeoCountry = (tf: Timeframe, rumAppId: string, iso: string) => `
fetch user.events, from: ${tf.from}, to: ${tf.to}
| filter dt.rum.application.id == "${rumAppId.replace(/["\\]/g, "")}"
| filter geo.country.iso_code == "${iso.replace(/["\\]/g, "")}"
| fieldsAdd vn = ${VIEW_NAME}
| filter isNotNull(vn) or characteristics.classifier == "error"
| fieldsAdd vn = if(isNull(vn), "${NO_SCREEN}", else: vn)
// THE SCREEN IS JUDGED BY THE PLACE'S OWN TWO ARMS. A place turns amber on
// its errors OR its experience score; a screen list that carried only the
// errors could not show why a slow state was amber (the busiest state on staging:
// Warning on its score, every screen "Healthy").
${PLACE_SCORE_FIELDS}
| summarize
    sessions = countDistinct(dt.rum.session.id),
    hit = countDistinct(if(${USER_HIT},
      dt.rum.session.id, else: null)),
    ${PLACE_SCORE_SUMS},
  by: { view = vn }
| sort sessions desc
| limit 8`;


/**
 * THE SAME LIST, ONE LEVEL DOWN. Opening a state used to change the cities
 * and nothing else: the screens underneath went on describing the whole
 * country, so clicking an amber state showed a list in which that state's
 * traffic was a rounding error. This is qGeoCountry with the region added to
 * the filter — NOT to the grain, because a session that moves between states
 * is counted in each and summing those rows back up would overstate the
 * country. One more scan, and only when a reader opens a state, which is the
 * same bargain the cities leg already makes.
 */
export const qGeoRegion = (tf: Timeframe, rumAppId: string, iso: string,
  region: string) => `
fetch user.events, from: ${tf.from}, to: ${tf.to}
| filter dt.rum.application.id == "${rumAppId.replace(/["\\]/g, "")}"
| filter geo.country.iso_code == "${iso.replace(/["\\]/g, "")}"
| filter geo.region.iso_code == "${region.replace(/["\\]/g, "")}"
| fieldsAdd vn = ${VIEW_NAME}
| filter isNotNull(vn) or characteristics.classifier == "error"
| fieldsAdd vn = if(isNull(vn), "${NO_SCREEN}", else: vn)
// THE SCREEN IS JUDGED BY THE PLACE'S OWN TWO ARMS. A place turns amber on
// its errors OR its experience score; a screen list that carried only the
// errors could not show why a slow state was amber (the busiest state on staging:
// Warning on its score, every screen "Healthy").
${PLACE_SCORE_FIELDS}
| summarize
    sessions = countDistinct(dt.rum.session.id),
    hit = countDistinct(if(${USER_HIT},
      dt.rum.session.id, else: null)),
    ${PLACE_SCORE_SUMS},
  by: { view = vn }
| sort sessions desc
| limit 8`;


/**
 * WHO a region's sessions are, against everyone else — the geo drill's
 * characteristics leg. Per-session rows (one scan), pivoted in the client:
 * the flag says in/out of the country, `hit` says whether the session met an
 * error, and the dimensions are the ones the platform records for every
 * agent. Everything needed to answer "what is DIFFERENT about this region,
 * and inside it, what carries the errors" — in one leg.
 */
export const qGeoWho = (tf: Timeframe, rumAppId: string, iso: string, rate = 1) => `
fetch user.events, from: ${tf.from}, to: ${tf.to}
| filter dt.rum.application.id == "${rumAppId.replace(/["\\]/g, "")}"${sessionSample(rate)}
| summarize
    /* max, not takeAny — membership is "ANY event in this country", and
     * takeAny flipped it per run for sessions with mixed/null geo rows */
    inC = max(if(geo.country.iso_code == "${iso.replace(/["\\]/g, "")}", 1, else: 0)),
    // affected by an error (USER_HIT) — the rule every verdict uses
    hit = countIf(${USER_HIT}),
    os = takeAny(os.name), browser = takeAny(browser.name),
    isp = takeAny(client.isp), devtype = takeAny(device.type),
    conn = takeAny(network.connection.type),
    osv = takeAny(os.version), browserv = takeAny(browser.version),
  by: { sid = dt.rum.session.id }
/* A deterministic sample of sessions (sampleRate) rather than "the first
   10,000" of millions, which the country-vs-rest rates were read off. */
| limit 10000`;


/* ── SHADOW CANDIDATES (?compare=1) ──────────────────────────────────────────
 * Queries that MIGHT replace current ones, run beside them so the difference is
 * measured before anything is swapped (Marcelo, 2026-10-23: "what does not
 * match cannot be substituted"). Nothing on screen reads them; the comparison
 * panel does. Aligned windows use absolute minute-floored timestamps, so the
 * metric store and the event store cover exactly the same span. */

/** Minute-floored absolute window — the metric store's own grain — that ends
 *  SHADOW_SETTLE_MIN before now. Ending at now left the newest minutes still
 *  filling while the queries ran: on staging the reference read 50,494 errors and
 *  the candidate, seconds later, 50,503 over the very same window — the late
 *  beacons, not the definitions. A settled window gives both sides the same
 *  events, so any difference left is a real one. */
export const SHADOW_SETTLE_MIN = 10;
export const alignedWindow = (minutes: number) => {
  const end = Math.floor(Date.now() / 60000) * 60000 - SHADOW_SETTLE_MIN * 60000;
  return { from: new Date(end - minutes * 60000).toISOString(), to: new Date(end).toISOString() };
};
/** The same window as a Timeframe every builder accepts: quoted absolute
 *  timestamps, so a reference and a candidate run seconds apart still read
 *  EXACTLY the same events (a relative now()-1h slides between them, and a
 *  comparison would measure the slide — measured: ±1 session, ±1 action). */
export const alignedTf = (minutes: number): Timeframe => {
  const w = alignedWindow(minutes);
  return { from: `"${w.from}"`, to: `"${w.to}"`, minutes, label: `aligned ${minutes}m` } as Timeframe;
};

/* EXACT, NOT ESTIMATED. countDistinct is a stochastic estimate (HLL,
   precision 14: about 1% standard error at production cardinalities). On staging,
   a few hundred sessions an hour, the estimate is still exact, which is why
   the first comparisons matched to the unit; on a production estate they
   would not. The per-session reference counts exactly, so every candidate
   that might replace it counts with countDistinctExact. */
/** Candidate verdict numerator + score: one ungrouped pass over the only two
 *  event kinds that can hurt a person (error, user_action). */
export const qUxLean = (tf: Timeframe, rumAppId: string, exact = true) => {
  const D = distinctFn(exact);
  return `
fetch user.events, from: ${tf.from}, to: ${tf.to}
| filter dt.rum.application.id == "${esc(rumAppId)}"
| filter characteristics.classifier == "error" or characteristics.classifier == "user_action"
| fieldsAdd _real = coalesce(dt.rum.user_type, "") != "robot" and coalesce(dt.rum.user_type, "") != "synthetic"
    and isNull(dt.synthetic.monitor.id)
| fieldsAdd _rated = characteristics.classifier == "user_action" and isNotNull(experience.level)
| fieldsAdd _w = coalesce(experience.weight, 1)
| fieldsAdd _err = _rated and ${ACT_ERR}
| fieldsAdd _crash = _real and ${CRASH}
| fieldsAdd _robot = coalesce(dt.rum.user_type, "") == "robot"
| fieldsAdd _synth = coalesce(dt.rum.user_type, "") == "synthetic" or isNotNull(dt.synthetic.monitor.id)
| fieldsAdd _isErr = characteristics.classifier == "error"
| summarize hit = ${D(`if(${USER_HIT}, dt.rum.session.id, else: null)`)},
    hitReal = ${D(`if(_real and ${USER_HIT}, dt.rum.session.id, else: null)`)},
    // the reference judges a SESSION robot if any of its events is; this
    // judges the hurting event — the panel says whether the two agree
    hitRobot = ${D(`if(_robot and ${USER_HIT}, dt.rum.session.id, else: null)`)},
    hitSynth = ${D(`if(_synth and ${USER_HIT}, dt.rum.session.id, else: null)`)},
    errors = countIf(_isErr),
    realErrors = countIf(_isErr and _real),
    errorsThird = countIf(_isErr and ${THIRD_PARTY}),
    actions = countIf(characteristics.classifier == "user_action"),
    ratedActs = countIf(_real and _rated),
    errActions = countIf(_real and _err),
    scoreCrashes = countIf(_crash),
    // what each web arm contributes (evidence for the WEB_ACT_ERR choice):
    // actions carrying each error kind, counted whether or not it judges
    webActExc = countIf(characteristics.classifier == "user_action" and coalesce(error.exception_count, 0) > 0),
    webAct4xx = countIf(characteristics.classifier == "user_action" and coalesce(error.http_4xx_count, 0) > 0),
    webAct5xx = countIf(characteristics.classifier == "user_action" and coalesce(error.http_5xx_count, 0) > 0),
    webActOther = countIf(characteristics.classifier == "user_action" and coalesce(error.http_other_count, 0) > 0),
    webActCsp = countIf(characteristics.classifier == "user_action" and coalesce(error.csp_violation_count, 0) > 0),
    satisfied = sum(if(_real and _rated and not(_err) and experience.level == "satisfied", _w, else: 0)),
    tolerating = sum(if(_real and _rated and not(_err) and experience.level == "tolerating", _w, else: 0)),
    frustrated = sum(if(_crash, 1, else: if(_real and _rated and (_err or experience.level == "frustrated"), _w, else: 0)))`;
};

/** The Overview's verdict and score in one pass over the two event kinds that
 *  can hurt a person (0.16.0, validated beside qUxByApp + qExperience on staging). */
export const qShadowLean = (tf: Timeframe, rumAppId: string, exact = true) => qUxLean(tf, rumAppId, exact);

/** Candidate verdict denominator: the census's countDistinct, with real people. */
export const qShadowCensus = (tf: Timeframe, rumAppId: string, exact = true) => {
  const D = distinctFn(exact);
  return `
fetch user.events, from: ${tf.from}, to: ${tf.to}
| filter dt.rum.application.id == "${esc(rumAppId)}"
| summarize sessions = ${D("dt.rum.session.id")},
    realSessions = ${D(`if(coalesce(dt.rum.user_type, "") != "robot"
      and coalesce(dt.rum.user_type, "") != "synthetic" and isNull(dt.synthetic.monitor.id),
      dt.rum.session.id, else: null)`)}`;
};

/** Reference for the metric candidate: sessions from EVENTS over the same
 *  aligned window — total, per user type, per country, per 2-minute bin. */
export const qShadowSessionsEvents = (w: { from: string; to: string }, rumAppId: string) => {
  const base = `fetch user.events, from: "${w.from}", to: "${w.to}"
  | filter dt.rum.application.id == "${esc(rumAppId)}"`;
  return `
data record(k = "", b = "", sessions = 0)
| filter false
| append [ ${base}
  | summarize sessions = countDistinct(dt.rum.session.id), by: { k = "total", b = "" } ]
| append [ ${base}
  | summarize sessions = countDistinct(dt.rum.session.id), by: { k = "user type", b = dt.rum.user_type } ]
| append [ ${base}
  | summarize sessions = countDistinct(dt.rum.session.id), by: { k = "country", b = geo.country.iso_code }
  | sort sessions desc | limit 12 ]
| append [ ${base}
  | summarize sessions = countDistinct(dt.rum.session.id), by: { k = "bin", b = toString(bin(start_time, 2m)) } ]
| limit 200`;
};

/** The metric candidate over the same aligned window. */
export const qShadowSessionsMetric = (w: { from: string; to: string }, frontendName: string,
  by: "total" | "user type" | "country" | "bin") => {
  const fe = esc(frontendName);
  const dim = by === "user type" ? ", by: { dt.rum.user_type }" : by === "country" ? ", by: { geo.country.iso_code }" : "";
  return by === "bin"
    ? `timeseries sessions = countDistinct(dt.frontend.session.active.estimated_count), from: "${w.from}", to: "${w.to}", interval: 2m, filter: { frontend.name == "${fe}" }`
    : `timeseries sessions = countDistinct(dt.frontend.session.active.estimated_count, scalar: true), from: "${w.from}", to: "${w.to}", filter: { frontend.name == "${fe}" }${dim}`;
};

/** Candidate: the lean pass GROUPED by country and user type — one scan for
 *  the verdict, the score, the origins and the map's per-country harm. */
export const qShadowLeanGrouped = (tf: Timeframe, rumAppId: string, exact = true) => {
  const D = distinctFn(exact);
  return `
fetch user.events, from: ${tf.from}, to: ${tf.to}
| filter dt.rum.application.id == "${esc(rumAppId)}"
| filter characteristics.classifier == "error" or characteristics.classifier == "user_action"
| fieldsAdd _real = coalesce(dt.rum.user_type, "") != "robot" and coalesce(dt.rum.user_type, "") != "synthetic"
    and isNull(dt.synthetic.monitor.id)
| fieldsAdd _rated = characteristics.classifier == "user_action" and isNotNull(experience.level)
| fieldsAdd _w = coalesce(experience.weight, 1)
| fieldsAdd _err = _rated and ${ACT_ERR}
| fieldsAdd _crash = _real and ${CRASH}
| summarize hitReal = ${D(`if(_real and ${USER_HIT}, dt.rum.session.id, else: null)`)},
    satisfied = sum(if(_real and _rated and not(_err) and experience.level == "satisfied", _w, else: 0)),
    tolerating = sum(if(_real and _rated and not(_err) and experience.level == "tolerating", _w, else: 0)),
    frustrated = sum(if(_crash, 1, else: if(_real and _rated and (_err or experience.level == "frustrated"), _w, else: 0))),
    crashes = countIf(characteristics.classifier == "error" and error.type == "crash"),
    anrs = countIf(characteristics.classifier == "error" and error.type == "anr"),
  by: { cc = geo.country.iso_code, ut = dt.rum.user_type }
| limit 2000`;
};

/** Candidate: views and view times read off view_summary alone — the census
 *  reads every event to get them. */
export const qShadowViews = (tf: Timeframe, rumAppId: string) => `
fetch user.events, from: ${tf.from}, to: ${tf.to}
| filter dt.rum.application.id == "${esc(rumAppId)}"
| filter characteristics.classifier == "view_summary"
| summarize views = count(),
    p50View = percentile(toLong(duration), 50),
    p90View = percentile(toLong(duration), 90),
    p95View = percentile(toLong(duration), 95)`;

/** Candidate: errors, crashes and ANRs from the metric store, window as the
 *  census asks it (the census is the comparison). */
export const qShadowErrorMetrics = (tf: Timeframe, frontendName: string) => `
timeseries errors = sum(dt.frontend.error.count, scalar: true),
  crashes = sum(dt.frontend.error.count, filter: { error.type == "crash" }, scalar: true),
  anrs = sum(dt.frontend.error.count, filter: { error.type == "anr" }, scalar: true),
  actions = sum(dt.frontend.user_action.count, scalar: true),
  from: ${tf.from}, to: ${tf.to}, filter: { frontend.name == "${esc(frontendName)}" }`;

/** Reference and candidate for first-byte time per country (web), aligned. */
export const qShadowTtfbEvents = (w: { from: string; to: string }, rumAppId: string) => `
fetch user.events, from: "${w.from}", to: "${w.to}"
| filter dt.rum.application.id == "${esc(rumAppId)}"
| filter isNotNull(geo.country.iso_code) and isNotNull(ttfb.value)
| summarize ttfbMs = percentile(toDouble(ttfb.value), 75), by: { cc = geo.country.iso_code }
| sort ttfbMs desc
| limit 30`;
export const qShadowTtfbMetric = (w: { from: string; to: string }, frontendName: string) => `
timeseries ttfb = percentile(dt.frontend.web.navigation.time_to_first_byte, 75, scalar: true),
  from: "${w.from}", to: "${w.to}", filter: { frontend.name == "${esc(frontendName)}" },
  by: { geo.country.iso_code }`;
