// What this app costs to run, counted as it runs.
//
// Grail bills a query by the BYTES IT SCANS, and the app measured itself to
// learn what that means: projection is free (a bare count and an eight-column
// summarize scan the same 5.9 GB of a live estate's two hours), filters are
// everything (one application 2.9 GB, a small one 0.24 GB), every `append`
// leg pays its own scan — and the window is LINEAR, so twenty-four hours
// costs about twelve times two.
//
// That last fact is the one the reader holds in their hand and cannot see:
// the timeframe selector is the biggest cost control in the product. So the
// app stops guessing and counts: every query reports what it scanned, the
// header shows the running total for the window on screen, and a cached view
// adds nothing — because it scanned nothing.

let scanned = 0;
let queries = 0;
/**
 * Queries Grail STOPPED at its scan limit. Measured on a 30-day window: the
 * platform caps a fetch at 500 GB, returns state SUCCEEDED, and puts a WARNING
 * in the metadata — so a wide window quietly answers from a PARTIAL scan. This
 * app does not print a partial number as a measured one, so the count travels
 * to the header and the badge says so.
 */
let truncated = 0;
/** Every query of this window, in order: what it read and whether it finished.
 *  The header draws one bar per entry, which is the readout AND the evidence —
 *  a truncated query is a red bar you can point at. */
let trace: Array<{ bytes: number; cut: boolean; label: string }> = [];
/** Queries in flight right now, so the readout can show it is still working. */
let inFlight = 0;
let windowKey = "";
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

/** A query left for Grail. */
export function noteScanStart(): void { inFlight += 1; emit(); }

/** Every completed query reports what Grail actually read for it. */
export function noteScan(bytes: number, wasTruncated = false, label = "query"): void {
  queries += 1;
  inFlight = Math.max(0, inFlight - 1);
  if (wasTruncated) truncated += 1;
  const b = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  scanned += b;
  // the readout holds the last 48 — enough to show the shape of a page load
  trace.push({ bytes: b, cut: wasTruncated, label });
  if (trace.length > 48) trace = trace.slice(-48);
  emit();
}

/** Does this notification mean the scan was cut short? */
export const isScanLimit = (message?: string | null) =>
  /scanLimitGBytes|gigabytes of data were scanned/i.test(message ?? "");

/** A new window is a new bill: the counter belongs to the timeframe on screen. */
/* THE PAGE'S CLOCK. "A última resposta não pode ser maior que 10 segundos"
   is a bound on the PAGE, not on each query — a query that starts six
   seconds in does not get its own fresh ten. The epoch is the moment the
   window on screen changed, which is also when the bill restarts; the
   runner reads the remaining budget from here. Queries issued after the
   budget has elapsed are user actions (a drill opened a minute later) and
   keep their own per-query bound instead — see pageBudgetMs. */
export const PAGE_BUDGET_MS = 10000;

/* THE GUARDRAIL ON WHAT IS OPTIONAL (0.16.27). The cards' projections
   (sessions, errors, requests — useMetricForecast) are drawn beside the
   facts; the verdict reads none of them (its own forecast is the error rate,
   on the metric store) — so they are never allowed to cost like facts on a
   customer's estate. Measured on production,
   the event-history fallback of one forecast read 466 GiB. An optional read
   that would scan more than this is not run; the page shows no projection
   instead. The estimate is measured, not guessed: the window's own event
   scan (the pulse) times the history's length over the window's. */
export const OPTIONAL_SCAN_BUDGET_GIB = 25;
let windowStartedAt = Date.now();
/** Milliseconds of the page budget still left, or null once the first-load
 *  budget has fully elapsed (later queries are interactions, not the load). */
export function pageBudgetMs(): number | null {
  const left = PAGE_BUDGET_MS - (Date.now() - windowStartedAt);
  return left > 0 ? left : null;
}

export function resetScan(key: string): void {
  if (key === windowKey) return;
  windowKey = key;
  windowStartedAt = Date.now();
  scanned = 0;
  queries = 0;
  truncated = 0;
  trace = [];
  emit();
}

export const scanTotals = () => ({ bytes: scanned, queries, truncated, trace, inFlight });

/**
 * WHERE THE MONEY WENT, not just how much.
 *
 * A single total says the page is expensive and nothing about what to do. The
 * bill is the sum of a handful of scans with very different shapes — a
 * per-session summarize over the whole estate costs orders more than the same
 * projection scoped to one application — so the readout groups by what each
 * query READ. Grouped, the ranking is the work list: whatever sits on top is
 * the next thing worth scoping.
 *
 * Nothing extra is executed for this. Grail reports scannedBytes with every
 * result; this is the number it already sent, kept instead of discarded.
 */
export const scanByLabel = () => {
  const by = new Map<string, { bytes: number; n: number; cut: number }>();
  for (const t of trace) {
    const cur = by.get(t.label) ?? { bytes: 0, n: 0, cut: 0 };
    cur.bytes += t.bytes; cur.n += 1; if (t.cut) cur.cut += 1;
    by.set(t.label, cur);
  }
  return [...by.entries()]
    .map(([label, v]) => ({ label, ...v }))
    .sort((a, b) => b.bytes - a.bytes);
};

/** Has any query on this screen come back from a PARTIAL scan?
 *
 *  Grail stops a fetch at its 500 GB scan limit, returns state SUCCEEDED, and
 *  puts the warning in the metadata — so a wide window quietly answers from
 *  part of the data. This app detects that and counted it, and the counter
 *  had no consumer: the figures were rendered and cached exactly as if they
 *  were complete. Detected and ignored is not a guardrail.
 *  The rows are still returned — withholding them would leave the reader with
 *  nothing instead of something partial — but the screen now says so. */
export const hasTruncation = () => truncated > 0;

/** A cached payload that was truncated when it was first read re-raises the
 *  warning, so the banner does not disappear just because the figures came
 *  back from the cache instead of from Grail. */
export function noteCachedTruncation(): void {
  truncated += 1;
  emit();
}

export function subscribeScan(f: () => void): () => void {
  subs.add(f);
  return () => { subs.delete(f); };
}

/**
 * The published DPS list rate for querying Grail, per GiB scanned. A contract
 * may carry another number, which is why the badge shows the BYTES as the
 * fact and the money only as an "at list rate" aside.
 */
export const DPS_PER_GIB = 0.0035;

export const fmtBytes = (b: number) =>
  b >= 1e12 ? `${(b / 1e12).toFixed(2)} TB`
  : b >= 1e9 ? `${(b / 1e9).toFixed(b / 1e9 >= 10 ? 0 : 1)} GB`
  : b >= 1e6 ? `${Math.round(b / 1e6)} MB`
  : `${Math.round(b / 1e3)} kB`;

export const fmtMoney = (b: number) => {
  const usd = (b / 1024 ** 3) * DPS_PER_GIB;
  return usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`;
};
