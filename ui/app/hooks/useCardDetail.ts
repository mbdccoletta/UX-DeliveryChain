// The breakdown behind a card, fetched when that card is opened.
//
// Every card on the landing page states one number. This is the list under it:
// which views, which failures, which domains — with the percentiles and the
// failure counts the card only summarises. One query per card, run on the click
// that opens it and memoised per application, window and card, so re-opening
// costs nothing.
import { useEffect, useState } from "react";
import {
  qDetailErrors, qDetailExperience, qDetailRequests, runDql, type Timeframe,
} from "../utils/dql";
import type { Metric } from "./useEcgForecast";

/** The metrics that own a card, and therefore a breakdown. "actions" has no
 *  card of its own — it is a rate printed inside the experience card. */
export type DetailMetric = Extract<Metric, "sessions" | "errors" | "requests">;

export interface DetailRow {
  name: string;
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
  /** error.source — how it was raised. Shown, never used as a filter value. */
  src?: string;
  /** Experience card: the Apdex bands for this view. */
  sat?: number;
  tol?: number;
  fru?: number;
}

const QUERY: Record<DetailMetric, (tf: Timeframe, app: string) => string> = {
  sessions: qDetailExperience,
  errors: qDetailErrors,
  requests: qDetailRequests,
};

const memo = new Map<string, DetailRow[]>();

/** Rows for one card, or null while they are being fetched. */
export function useCardDetail(
  appId: string, tf: Timeframe, metric: DetailMetric | null,
): DetailRow[] | null {
  const key = metric ? `${appId}|${tf.from}|${tf.to}|${metric}` : "";
  const [rows, setRows] = useState<DetailRow[] | null>(
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
        const raw = await runDql<Record<string, unknown>>(QUERY[metric](tf, appId), 20);
        const out: DetailRow[] = raw.map((r) => ({
          name: String(r.name ?? "—"),
          vol: Number(r.vol) || 0,
          sessions: Number(r.sessions) || 0,
          p50: r.p50 == null ? undefined : Number(r.p50),
          p90: r.p90 == null ? undefined : Number(r.p90),
          p95: r.p95 == null ? undefined : Number(r.p95),
          failures: r.failures == null ? undefined : Number(r.failures),
          errors: r.errors == null ? undefined : Number(r.errors),
          real: r.real == null ? undefined : Number(r.real),
          third: r.third == null ? undefined : Number(r.third),
          type: r.type == null ? undefined : String(r.type),
          named: r.named == null ? undefined : Number(r.named),
          src: r.src == null ? undefined : String(r.src),
          sat: r.sat == null ? undefined : Number(r.sat),
          tol: r.tol == null ? undefined : Number(r.tol),
          fru: r.fru == null ? undefined : Number(r.fru),
        }));
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
