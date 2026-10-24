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
