// The breakdown behind a card, fetched when that card is opened.
//
// Every card on the landing page states one number. This is the list under it:
// which views, which failures, which domains — with the percentiles and the
// failure counts the card only summarises. One query per card, run on the click
// that opens it and memoised per application, window and card, so re-opening
// costs nothing.
import { useEffect, useState } from "react";
import { useMemoGen } from "../utils/memo";
import {
  qDetailErrors, qDetailExperience, qDetailRequests, runDql, type Timeframe,
} from "../utils/dql";
import type { Metric } from "./useEcgForecast";

/** The metrics that own a card, and therefore a breakdown. "actions" has no
 *  card of its own — it is a rate printed inside the experience card. */
export type DetailMetric = Extract<Metric, "sessions" | "errors" | "requests">;

export interface DetailRow {
  name: string;
  /** Requests only: the HOST this endpoint belongs to. The name is the whole
   *  endpoint now, and the trace lookup keys on the host. */
  domain?: string;
  /** What sizes the bar: actions, errors or requests, depending on the card. */
  vol: number;
  sessions: number;
  /** Durations in nanoseconds — absent on the errors card. */
  p50?: number;
  p90?: number;
  p95?: number;
  /** Requests card: calls that failed. */
  failures?: number;
  /** Views card: errors recorded on that view — what decides its drill-down. */
  errors?: number;
  /** Errors card: how many reached a real person, and whose code failed. */
  real?: number;
  third?: number;
  /** error.type — what the Error Inspector filters on. */
  type?: string;
  /** How many of these carry a real error.name. Zero means the Error Explorer,
   *  which lists BY name, would open on nothing. */
  named?: number;
  /** Errors card: the raw, uncollapsed error.name, and how many distinct raw
   *  names the row's label stands for. One means the label is the platform's
   *  own value and can be sent as a filter; more means it cannot. */
  raw?: string;
  rawNames?: number;
  /** error.source — how it was raised. Shown, never used as a filter value. */
  src?: string;
  /** Experience card: the Apdex bands for this view. */
  sat?: number;
  tol?: number;
  fru?: number;
}

const QUERY: Record<DetailMetric, (tf: Timeframe, app: string, ratio?: number) => string> = {
  sessions: qDetailExperience,
  errors: qDetailErrors,
  requests: qDetailRequests,
};

const memo = new Map<string, DetailRow[] & { ratio?: number }>();

/** Rows for one card, or null while they are being fetched. */
export function useCardDetail(
  appId: string, tf: Timeframe, metric: DetailMetric | null,
  /** THE GUARDRAIL ON A CLICK (0.17.10). A breakdown has no metric
   *  equivalent — views, endpoints and error names live only on the events —
   *  and on a production estate one click read 118–140 GiB. The caller
   *  sizes a Grail sampling ratio (1, 10, 100…) so the read stays inside
   *  OPTIONAL_SCAN_BUDGET_GIB; counts are scaled back by it, shares and
   *  percentiles hold, and the rows carry the ratio so the panel says so. */
  ratio = 1,
): (DetailRow[] & { ratio?: number }) | null {
  const gen = useMemoGen();
  const key = metric ? `${appId}|${tf.from}|${tf.to}|${metric}|${ratio}|${gen}` : "";
  const [rows, setRows] = useState<(DetailRow[] & { ratio?: number }) | null>(
    key ? memo.get(key) ?? null : null);

  useEffect(() => {
    if (!key || !metric) { setRows(null); return; }
    const hit = memo.get(key);
    if (hit) { setRows(hit); return; }

    // Clear before fetching: without this the panel kept the previous card's
    // rows on screen under the new card's title — the same stale-reflection
    // bug the chain had when switching application.
    setRows(null);
    let live = true;
    (async () => {
      try {
        const raw = await runDql<Record<string, unknown>>(QUERY[metric](tf, appId, ratio), 20);
        // a sampled count is the sample times the ratio — an estimate, marked
        const x = (v: unknown) => (v == null ? undefined : Number(v) * ratio);
        const out: DetailRow[] & { ratio?: number } = raw.map((r) => ({
          name: String(r.name ?? "—"),
          domain: r.domain == null ? undefined : String(r.domain),
          vol: (Number(r.vol) || 0) * ratio,
          sessions: Number(r.sessions) || 0,
          p50: r.p50 == null ? undefined : Number(r.p50),
          p90: r.p90 == null ? undefined : Number(r.p90),
          p95: r.p95 == null ? undefined : Number(r.p95),
          failures: x(r.failures),
          errors: x(r.errors),
          real: x(r.real),
          third: x(r.third),
          type: r.type == null ? undefined : String(r.type),
          named: x(r.named),
          raw: r.raw == null ? undefined : String(r.raw),
          rawNames: r.rawNames == null ? undefined : Number(r.rawNames),
          src: r.src == null ? undefined : String(r.src),
          sat: x(r.sat),
          tol: x(r.tol),
          fru: x(r.fru),
        }));
        if (ratio > 1) out.ratio = ratio;
        memo.set(key, out);
        if (live) setRows(out);
      } catch {
        // the panel says it found nothing rather than showing a broken frame
        if (live) setRows([]);
      }
    })();

    return () => { live = false; };
  }, [key, metric, appId, tf]);

  return rows;
}
