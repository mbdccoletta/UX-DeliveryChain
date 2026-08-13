// Which contacted domains are actually served by instrumented code.
//
// The browser records a domain; the backend records spans. A domain we serve
// has both — measured on this tenant, `server.address == "10.107.164.30"`
// matches 231,270 spans across 7 services — while a CDN, a font host or an
// analytics beacon has no span behind it at all.
//
// That distinction is the whole point of this hook: it decides whether a
// domain row can hand off to the Distributed Tracing explorer, or whether the
// only honest destination is a query. `http.request.provider` would have been
// the cheap way to tell, but it is null on every domain of this tenant, so the
// question is answered by asking the spans directly.
//
// ONE scan for the whole panel, on the click that opens it, memoised per
// domain set and window — never per row.
import { useEffect, useState } from "react";
import { runDql, type Timeframe } from "../utils/dql";

const memo = new Map<string, Set<string>>();

/** The subset of `domains` that has spans, or null while loading. */
export function useDomainTraces(
  domains: string[], tf: Timeframe, active = true,
): Set<string> | null {
  const list = [...domains].sort();
  const key = active && list.length ? `${list.join(",")}|${tf.from}|${tf.to}` : "";
  const [out, setOut] = useState<Set<string> | null>(
    key ? memo.get(key) ?? null : null);

  useEffect(() => {
    if (!key) { setOut(null); return; }
    const hit = memo.get(key);
    if (hit) { setOut(hit); return; }

    setOut(null);
    let live = true;
    (async () => {
      try {
        const where = list.slice(0, 12)
          .map((d) => `server.address == "${d.replace(/["\\]/g, "")}"`).join(" or ");
        const rows = await runDql<{ addr?: string }>(
          `fetch spans, from: ${tf.from}, to: ${tf.to}
           | filter ${where}
           | summarize n = count(), by: { addr = server.address }
           | filter n > 0 | limit 12`, 12);
        const set = new Set(rows.map((r) => String(r.addr)));
        memo.set(key, set);
        if (live) setOut(set);
      } catch {
        // an empty set is the safe answer: rows fall back to the query
        // hand-off rather than offering traces that may not exist
        if (live) setOut(new Set());
      }
    })();

    return () => { live = false; };
  }, [key, tf, list.join(",")]);

  return out;
}
