// Where the numbers are heading, from the platform's own predictive analyzer.
//
// Everything else in this app reports what already happened. This is the one
// piece that looks forward — and it only speaks when the analyzer says the
// forecast is sound: an unreliable projection shown to a business owner is
// worse than no projection at all.
import { analyzersClient } from "@dynatrace-sdk/client-davis-analyzers";

const ANALYZER = "dt.statistics.GenericForecastAnalyzer";

export interface Forecast {
  /** Projected values, one per interval ahead. */
  point: number[];
  lower: number[];
  upper: number[];
  /** Sum of the projected points — the "how much more" figure. */
  total: number;
  /** Difference between the last and first projected point. */
  slope: number;
  /** How many intervals ahead, and how long each is. */
  horizon: number;
  intervalMs: number;
}

/** Polls until the analysis completes, per the documented execution contract. */
async function poll(requestToken: string) {
  const MAX = 10;
  for (let i = 0; i < MAX; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const { result } = await analyzersClient.pollAnalyzerExecution({
      analyzerName: ANALYZER, requestToken,
    });
    if (result.executionStatus === "COMPLETED") return result;
    if (result.executionStatus === "ABORTED") throw new Error("analysis aborted");
  }
  // the guide recommends cancelling rather than leaving it running; a result
  // that lands between the last poll and the cancel is still returned
  const cancelled = await analyzersClient.cancelAnalyzerExecution({
    analyzerName: ANALYZER, requestToken,
  });
  if (cancelled?.result.executionStatus === "COMPLETED") return cancelled.result;
  throw new Error("analysis did not finish");
}

/**
 * Runs a forecast over a DQL timeseries.
 *
 * Returns null whenever the answer would not be trustworthy — analyzer refused,
 * quality not VALID, or no points came back. Callers show nothing in that case.
 */
export async function forecast(expression: string, horizon = 12): Promise<Forecast | null> {
  try {
    const res = await analyzersClient.executeAnalyzer({
      analyzerName: ANALYZER,
      body: { timeSeriesData: { expression }, forecastHorizon: horizon } as never,
    });
    const result = res.requestToken ? await poll(res.requestToken) : res.result;
    if (result.executionStatus !== "COMPLETED") return null;

    const out = (result.output as never as Array<Record<string, never>>)?.[0];
    // the analyzer states whether its own forecast is sound; anything but VALID
    // is not worth putting in front of someone
    if ((out as never as { forecastQualityAssessment?: string })
      ?.forecastQualityAssessment !== "VALID") return null;

    const rec = (out as never as {
      timeSeriesDataWithPredictions?: { records?: Array<Record<string, unknown>> };
    }).timeSeriesDataWithPredictions?.records?.[0];
    if (!rec) return null;

    const point = (rec["dt.davis.forecast:point"] as number[]) ?? [];
    const lower = (rec["dt.davis.forecast:lower"] as number[]) ?? [];
    const upper = (rec["dt.davis.forecast:upper"] as number[]) ?? [];
    if (!point.length) return null;

    return {
      point, lower, upper,
      total: point.reduce((a, b) => a + b, 0),
      slope: point[point.length - 1] - point[0],
      horizon: point.length,
      intervalMs: Number(rec.interval ?? 0) / 1e6,
    };
  } catch {
    // no scope, analyzer unavailable, or the query returned nothing usable
    return null;
  }
}
