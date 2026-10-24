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
import { runDql, type Timeframe } from "../utils/dql";

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
    runDql<Record<string, unknown>>(qRegionApdex(tf, rumAppId!, iso!, ratio), 200)
      .then((rows) => {
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
export type RegionActions = RegionAction[] & { ratio?: number };

export const qRegionActions = (tf: Timeframe, rumAppId: string, iso: string,
  region: string, ratio = 1) => `
fetch user.events, from: ${tf.from}, to: ${tf.to}${ratio > 1 ? `, samplingRatio: ${ratio}` : ""}
| filter dt.rum.application.id == "${q(rumAppId)}"
    and characteristics.classifier == "user_action"
    and dt.rum.user_type == "real_user"
    and geo.country.iso_code == "${q(iso)}"
    and geo.region.iso_code == "${q(region)}"
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

/** The state's costliest actions; null while asked or when none is open. */
export function useRegionActions(tf: Timeframe, rumAppId: string | null | undefined,
  iso: string | null, region: string | null, ratio: number): RegionActions | null {
  const gen = useMemoGen();
  const key = rumAppId && iso && region ? `${tf.from}|${tf.to}|${rumAppId}|${iso}|${region}|${ratio}|${gen}` : "";
  const [out, setOut] = useState<RegionActions | null>(key ? actMemo.get(key) ?? null : null);
  useEffect(() => {
    if (!key) { setOut(null); return; }
    const hit = actMemo.get(key);
    if (hit) { setOut(hit); return; }
    setOut(null);
    let live = true;
    runDql<Record<string, unknown>>(qRegionActions(tf, rumAppId!, iso!, region!, ratio), 8)
      .then((rows) => {
        const k = ratio;
        const res: RegionActions = rows.map((r) => ({
          name: String(r.act ?? "unnamed action"), n: (Number(r.n) || 0) * k,
          sat: Number(r.sat) || 0, tol: Number(r.tol) || 0, fru: Number(r.fru) || 0,
          p50: r.p50 == null ? undefined : Number(r.p50),
          p90: r.p90 == null ? undefined : Number(r.p90),
        }));
        if (ratio > 1) res.ratio = ratio;
        actMemo.set(key, res);
        if (live) setOut(res);
      })
      .catch(() => { if (live) setOut([]); });
    return () => { live = false; };
  }, [key]);
  return out;
}
