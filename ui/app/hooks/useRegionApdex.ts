// The Apdex of each state of one country — the same rating the application's
// and the countries' Apdex are summed from (dt.frontend.experience.weight is
// extracted from these very user actions), read where the metric store cannot
// answer: it carries the country, not the state.
//
// Read only when a country is opened, only real people's rated user actions,
// and inside the click budget (utils/cost scanRatio): on a large application
// a Grail sample, which leaves a share — and the Apdex is one — unbiased.
import { useEffect, useState } from "react";
import { useMemoGen } from "../utils/memo";
import { runDql, runRefined, type Timeframe } from "../utils/dql";
import { frontendNodeOf } from "../utils/frontendMetrics";

export interface RegionApdex { sat: number; tol: number; fru: number }
export type RegionApdexMap = Map<string, RegionApdex> & { ratio?: number };

const memo = new Map<string, RegionApdexMap>();
const q = (s: string) => s.replace(/["\\]/g, "");

export const qRegionApdex = (tf: Timeframe, rumAppId: string, iso: string, ratio = 1) => `
fetch user.events, from: ${tf.from}, to: ${tf.to}${ratio > 1 ? `, samplingRatio: ${ratio}` : ""}
| filter dt.rum.application.id == "${q(rumAppId)}"
    and characteristics.classifier == "user_action"
    and dt.rum.user_type == "real_user"
    and geo.country.iso_code == "${q(iso)}"
    and isNotNull(experience.level)
| fieldsAdd _w = coalesce(experience.weight, 1)
| summarize sat = sum(if(experience.level == "satisfied", _w, else: 0)),
    tol = sum(if(experience.level == "tolerating", _w, else: 0)),
    fru = sum(if(experience.level == "frustrated", _w, else: 0)),
  by: { region = geo.region.iso_code, name = geo.region.name }
| filter isNotNull(region) or isNotNull(name)
| limit 200`;

/* THE MINUTES A COUNTRY'S ACTIONS RAN IN (0.17.52). A sample of a large
   application holds almost nothing of a small country — 15 rated actions in
   Argentina, read 1:10, left every province "not rated" and the action table
   with two rows. The metric store says in which minutes the country's user
   actions ran; when they fit in a handful of minutes, reading those minutes
   whole is both cheaper and exact, so it replaces the sample. */
const MAX_EXACT_MIN = 6;
async function exactMinutes(tf: Timeframe, rumAppId: string, iso: string): Promise<Timeframe[] | null> {
  const node = await frontendNodeOf(rumAppId);
  if (!node) return null;
  const rows = await runDql<{ v?: unknown[]; timeframe?: { start?: string } }>(
    `timeseries v = sum(dt.frontend.user_action.count), from: ${tf.from}, to: ${tf.to}, interval: 1m,
  filter: { dt.smartscape.frontend == toSmartscapeId("${q(node.id)}") and geo.country.iso_code == "${q(iso)}" }`, 1);
  const bins = (rows[0]?.v ?? []).map((x) => Number(x) || 0);
  const start = Date.parse(String(rows[0]?.timeframe?.start ?? ""));
  const mins = bins.map((v, i) => ({ v, i })).filter((x) => x.v > 0);
  if (!Number.isFinite(start) || !mins.length || mins.length > MAX_EXACT_MIN) return null;
  return mins.map(({ i }) => ({ ...tf, minutes: 1,
    from: `"${new Date(start + i * 6e4).toISOString()}"`, to: `"${new Date(start + (i + 1) * 6e4).toISOString()}"` }));
}

/** By state code ("SP") and by lower-cased name; null while asked. */
export function useRegionApdex(tf: Timeframe, rumAppId: string | null | undefined,
  iso: string | null, ratio: number, active: boolean): RegionApdexMap | null {
  const gen = useMemoGen();
  const key = active && rumAppId && iso ? `${tf.from}|${tf.to}|${rumAppId}|${iso}|${ratio}|${gen}` : "";
  const [out, setOut] = useState<RegionApdexMap | null>(key ? memo.get(key) ?? null : null);
  useEffect(() => {
    if (!key) { setOut(null); return; }
    const hit = memo.get(key);
    if (hit) { setOut(hit); return; }
    setOut(null);
    let live = true;
    // the ratio is refined by the read's measured cost (runRefined)
    (async () => {
      if (ratio > 1) {
        const mins = await exactMinutes(tf, rumAppId!, iso!).catch(() => null);
        if (mins) {
          const parts = await Promise.all(mins.map((t) =>
            runDql<Record<string, unknown>>(qRegionApdex(t, rumAppId!, iso!, 1), 200)));
          // the weights add across minutes; one row per state
          const by = new Map<string, Record<string, unknown>>();
          for (const part of parts) for (const r of part) {
            const k = `${r.region ?? ""}|${r.name ?? ""}`;
            const cur = by.get(k);
            by.set(k, cur ? { ...cur, sat: Number(cur.sat) + Number(r.sat), tol: Number(cur.tol) + Number(r.tol),
              fru: Number(cur.fru) + Number(r.fru) } : { ...r });
          }
          return { rows: [...by.values()], ratio: 1 };
        }
      }
      return runRefined((r) => qRegionApdex(tf, rumAppId!, iso!, r), 200, ratio);
    })()
      .then(({ rows, ratio }) => {
        const m: RegionApdexMap = new Map();
        for (const r of rows) {
          const v = { sat: Number(r.sat) || 0, tol: Number(r.tol) || 0, fru: Number(r.fru) || 0 };
          if (r.region) m.set(String(r.region), v);
          if (r.name) m.set(String(r.name).toLowerCase(), v);
        }
        if (ratio > 1) m.ratio = ratio;
        memo.set(key, m);
        if (live) setOut(m);
      })
      .catch(() => { if (live) setOut(new Map()); });
    return () => { live = false; };
  }, [key]);
  return out;
}

/* ── WHAT PUT THE STATE IN ITS COLOUR (0.17.19) ─────────────────────────────
   Marcelo, 2026-10-24: "ao clicar no estado, mostrar urls ou actions que
   levaram ao status". The opened state's rated user actions, by name, ranked
   by what each costs the state's Apdex — frustrated plus half the tolerating,
   the same arithmetic as the score — with how often it ran, its own Apdex and
   its response time. Read on the click, inside the click budget. */
export interface RegionAction {
  name: string; n: number; sat: number; tol: number; fru: number;
  p50?: number; p90?: number;
}
export type RegionActions = RegionAction[] & { ratio?: number;
  /** Read whole from the minutes the metric says the actions ran in. */
  byMinute?: boolean };

export const qRegionActions = (tf: Timeframe, rumAppId: string, iso: string,
  region: string, ratio = 1) => `
fetch user.events, from: ${tf.from}, to: ${tf.to}${ratio > 1 ? `, samplingRatio: ${ratio}` : ""}
| filter dt.rum.application.id == "${q(rumAppId)}"
    and characteristics.classifier == "user_action"
    and dt.rum.user_type == "real_user"
    and geo.country.iso_code == "${q(iso)}"${region
      ? `\n    and geo.region.iso_code == "${q(region)}"` : ""}
    and isNotNull(experience.level)
| fieldsAdd _w = coalesce(experience.weight, 1),
    act = coalesce(user_action.name, view.name, view.detected_name, page.name, "unnamed action")
| summarize n = count(),
    sat = sum(if(experience.level == "satisfied", _w, else: 0)),
    tol = sum(if(experience.level == "tolerating", _w, else: 0)),
    fru = sum(if(experience.level == "frustrated", _w, else: 0)),
    p50 = percentile(toLong(duration), 50), p90 = percentile(toLong(duration), 90),
  by: { act }
| fieldsAdd lost = fru + tol / 2
| sort lost desc
| limit 8`;

const actMemo = new Map<string, RegionActions>();

/* THE MINUTES THE ACTIONS HAPPENED IN (0.17.50, 0.17.52): see exactMinutes.
   Null when the country's actions do not fit in a few minutes (the sample
   stands then). */
async function countryActionsByMinute(tf: Timeframe, rumAppId: string, iso: string, region: string)
  : Promise<Record<string, unknown>[] | null> {
  const mins = await exactMinutes(tf, rumAppId, iso);
  if (!mins) return null;
  const parts = await Promise.all(mins.map((t) =>
    runDql<Record<string, unknown>>(qRegionActions(t, rumAppId, iso, region, 1), 8)
      .catch(() => [] as Record<string, unknown>[])));
  // merge per action: counts add; the percentiles of the busiest part stand
  const by = new Map<string, Record<string, unknown>>();
  for (const part of parts) for (const r of part) {
    const k = String(r.act ?? "unnamed action");
    const cur = by.get(k);
    if (!cur) { by.set(k, { ...r }); continue; }
    const big = Number(r.n) > Number(cur.n);
    by.set(k, { ...cur, n: Number(cur.n) + Number(r.n), sat: Number(cur.sat) + Number(r.sat),
      tol: Number(cur.tol) + Number(r.tol), fru: Number(cur.fru) + Number(r.fru),
      p50: big ? r.p50 : cur.p50, p90: big ? r.p90 : cur.p90 });
  }
  return [...by.values()]
    .sort((a, b) => (Number(b.fru) + Number(b.tol) / 2) - (Number(a.fru) + Number(a.tol) / 2))
    .slice(0, 8);
}

/** The state's costliest actions — or, with region "", the whole opened
 *  country's (0.17.42); null while asked or when nothing is open. */
export function useRegionActions(tf: Timeframe, rumAppId: string | null | undefined,
  iso: string | null, region: string | null, ratio: number): RegionActions | null {
  const gen = useMemoGen();
  const key = rumAppId && iso && region !== null ? `${tf.from}|${tf.to}|${rumAppId}|${iso}|${region}|${ratio}|${gen}` : "";
  const [out, setOut] = useState<RegionActions | null>(key ? actMemo.get(key) ?? null : null);
  useEffect(() => {
    if (!key) { setOut(null); return; }
    const hit = actMemo.get(key);
    if (hit) { setOut(hit); return; }
    setOut(null);
    let live = true;
    (async () => {
      /* exact when the country's actions fit in a few minutes (0.17.52) —
         for the country and for any of its states */
      if (ratio > 1) {
        const exact = await countryActionsByMinute(tf, rumAppId!, iso!, region!).catch(() => null);
        if (exact) return { rows: exact, ratio: 1, partialWindow: true };
      }
      const got = await runRefined((r) => qRegionActions(tf, rumAppId!, iso!, region!, r), 8, ratio);
      return { ...got, partialWindow: false };
    })()
      .then(({ rows, ratio, partialWindow }) => {
        const k = ratio;
        const res: RegionActions = rows.map((r) => ({
          name: String(r.act ?? "unnamed action"), n: (Number(r.n) || 0) * k,
          sat: Number(r.sat) || 0, tol: Number(r.tol) || 0, fru: Number(r.fru) || 0,
          p50: r.p50 == null ? undefined : Number(r.p50),
          p90: r.p90 == null ? undefined : Number(r.p90),
        }));
        if (ratio > 1) res.ratio = ratio;
        if (partialWindow) res.byMinute = true;
        actMemo.set(key, res);
        if (live) setOut(res);
      })
      .catch(() => { if (live) setOut([]); });
    return () => { live = false; };
  }, [key]);
  return out;
}

/* ── WHAT SETS THIS STATE APART (0.17.48) ───────────────────────────────────
   Marcelo, 2026-10-25: "ainda vejo poucos detalhes de estados com score mais
   baixo… não sei o que causou". The costliest actions say WHAT hurt; this says
   what is DIFFERENT here. The application's rated actions, split by inside and
   outside the state, across the dimensions a cause lives in — operating
   system, app version or browser, device, network provider, and how the
   action ended (timeout, page hidden…) — so a low score reads as "Android 14
   on carrier X, ending in timeouts, only here" rather than as a colour.
   One read, on the click, inside the click budget (runRefined). */
export interface RegionWhyRow { here: boolean; d: string; v: string; w: number; lost: number; n: number; p50?: number }
export type RegionWhy = RegionWhyRow[] & { ratio?: number };

export const qRegionWhy = (tf: Timeframe, rumAppId: string, iso: string, region: string, ratio = 1) => `
fetch user.events, from: ${tf.from}, to: ${tf.to}${ratio > 1 ? `, samplingRatio: ${ratio}` : ""}
| filter dt.rum.application.id == "${q(rumAppId)}"
    and characteristics.classifier == "user_action"
    and dt.rum.user_type == "real_user"
    and isNotNull(experience.level)
| fieldsAdd _here = geo.country.iso_code == "${q(iso)}"${region ? ` and geo.region.iso_code == "${q(region)}"` : ""}
| fieldsAdd _w = toDouble(coalesce(experience.weight, 1))
| fieldsAdd _lost = if(experience.level == "frustrated", _w, else: if(experience.level == "tolerating", _w / 2, else: 0.0))
| fieldsAdd _dims = array(
    record(d = "operating system", v = coalesce(os.name, "unknown")),
    record(d = "app or browser", v = coalesce(app.short_version, browser.name, "unknown")),
    record(d = "device", v = coalesce(device.model.identifier, device.type, "unknown")),
    record(d = "network provider", v = coalesce(client.isp, "unknown")),
    record(d = "action ended by", v = coalesce(user_action.complete_reason, "unknown")))
| expand _dims
| summarize w = sum(_w), lost = sum(_lost), n = count(),
    p50 = percentile(toLong(duration), 50),
  by: { here = _here, d = _dims[d], v = _dims[v] }
| limit 3000`;

const whyMemo = new Map<string, RegionWhy>();

/** The opened state against the rest of the application; null while asked. */
export function useRegionWhy(tf: Timeframe, rumAppId: string | null | undefined,
  iso: string | null, region: string | null, ratio: number): RegionWhy | null {
  const gen = useMemoGen();
  const key = rumAppId && iso && region !== null ? `${tf.from}|${tf.to}|${rumAppId}|${iso}|${region}|${ratio}|${gen}` : "";
  const [out, setOut] = useState<RegionWhy | null>(key ? whyMemo.get(key) ?? null : null);
  useEffect(() => {
    if (!key) { setOut(null); return; }
    const hit = whyMemo.get(key);
    if (hit) { setOut(hit); return; }
    setOut(null);
    let live = true;
    runRefined((r) => qRegionWhy(tf, rumAppId!, iso!, region!, r), 3000, ratio)
      .then(({ rows, ratio }) => {
        const res: RegionWhy = rows.map((r) => ({
          here: r.here === true || r.here === "true", d: String(r.d ?? ""), v: String(r.v ?? ""),
          w: Number(r.w) || 0, lost: Number(r.lost) || 0, n: (Number(r.n) || 0) * ratio,
          p50: r.p50 == null ? undefined : Number(r.p50),
        }));
        if (ratio > 1) res.ratio = ratio;
        whyMemo.set(key, res);
        if (live) setOut(res);
      })
      .catch(() => { if (live) setOut([]); });
    return () => { live = false; };
  }, [key]);
  return out;
}

/** Per dimension, the value that adds most loss HERE beyond what the same
 *  value loses elsewhere — the "what is different about this place". */
export interface WhyFinding { d: string; v: string; shareOfLoss: number;
  apdexHere: number; apdexElse: number | null; n: number; p50?: number }
export function whyFindings(rows: RegionWhyRow[]): { findings: WhyFinding[]; apdexElse: number | null } {
  const dims = [...new Set(rows.map((r) => r.d))];
  // the rest of the application's Apdex, from one dimension's sum (each sums to the whole)
  const first = rows.filter((r) => r.d === dims[0] && !r.here);
  const wElse = first.reduce((a, r) => a + r.w, 0), lElse = first.reduce((a, r) => a + r.lost, 0);
  const apdexElse = wElse > 0 ? 1 - lElse / wElse : null;
  const findings: WhyFinding[] = [];
  for (const d of dims) {
    const here = rows.filter((r) => r.d === d && r.here);
    const lostHere = here.reduce((a, r) => a + r.lost, 0);
    if (!(lostHere > 0)) continue;
    let best: (WhyFinding & { excess: number }) | null = null;
    for (const h of here) {
      if (!(h.w > 0) || !(h.lost > 0)) continue;
      const e = rows.find((r) => r.d === d && !r.here && r.v === h.v);
      const rateElse = e && e.w > 0 ? e.lost / e.w : (wElse > 0 ? lElse / wElse : 0);
      const excess = h.lost - h.w * rateElse;
      if (!best || excess > best.excess) {
        best = { d, v: h.v, shareOfLoss: h.lost / lostHere, apdexHere: 1 - h.lost / h.w,
          apdexElse: e && e.w > 0 ? 1 - e.lost / e.w : null, n: h.n, p50: h.p50, excess };
      }
    }
    if (best && best.excess > 0) findings.push(best);
  }
  findings.sort((a, b) => (b as WhyFinding & { excess: number }).excess - (a as WhyFinding & { excess: number }).excess);
  return { findings, apdexElse };
}
