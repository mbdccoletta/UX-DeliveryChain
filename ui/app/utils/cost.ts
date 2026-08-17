// What this app costs to run, counted as it runs.
//
// Grail bills a query by the BYTES IT SCANS, and the app measured itself to
// learn what that means: projection is free (a bare count and an eight-column
// summarize scan the same 5.9 GB of this tenant's two hours), filters are
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
let windowKey = "";
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

/** Every completed query reports what Grail actually read for it. */
export function noteScan(bytes: number, wasTruncated = false): void {
  queries += 1;
  if (wasTruncated) truncated += 1;
  if (Number.isFinite(bytes) && bytes > 0) scanned += bytes;
  emit();
}

/** Does this notification mean the scan was cut short? */
export const isScanLimit = (message?: string | null) =>
  /scanLimitGBytes|gigabytes of data were scanned/i.test(message ?? "");

/** A new window is a new bill: the counter belongs to the timeframe on screen. */
export function resetScan(key: string): void {
  if (key === windowKey) return;
  windowKey = key;
  scanned = 0;
  queries = 0;
  truncated = 0;
  emit();
}

export const scanTotals = () => ({ bytes: scanned, queries, truncated });

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
