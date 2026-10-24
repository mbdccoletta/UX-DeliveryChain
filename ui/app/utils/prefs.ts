// What this app remembers about a reader between opens — server-side.
//
// Two facts used to live in localStorage: the last application opened (so a
// return visit skips the estate-wide discovery pass, ~374 GB measured in
// production) and the applications whose session count exceeds the platform's
// exact-count limit (so the census asks for the estimate first instead of
// paying a failed exact scan — ~13 s and most of a 269 GB read). The app runs
// in its own sandboxed origin, and in production that memory did not survive:
// the exact scan failed again on a later version. The user app state (already
// in the app's scopes) is kept by the platform per user and per app, across
// versions and browsers; localStorage stays as the instant first answer.
import { stateClient } from "@dynatrace-sdk/client-state";

const KEY = "deliverychain-prefs";
const LS_LAST = "deliverychain:lastApp";
const LS_OVER = "deliverychain:overExact";

interface Prefs { v: 1; lastApp?: string; overExact?: string[] }
let prefs: Prefs = { v: 1 };

const lsGet = (k: string): string | null => {
  try { return window.localStorage.getItem(k); } catch { return null; }
};
const lsSet = (k: string, v: string) => {
  try { window.localStorage.setItem(k, v); } catch { /* blocked storage */ }
};

/** Read once at boot, bounded: the page never waits more than `ms` for it. */
export function loadPrefs(ms = 400): Promise<void> {
  const read = stateClient.getUserAppState({ key: KEY })
    .then((s) => {
      const p = JSON.parse(s.value) as Partial<Prefs>;
      prefs = { v: 1, lastApp: p.lastApp, overExact: Array.isArray(p.overExact) ? p.overExact : [] };
    })
    .catch(() => { /* absent or not allowed: localStorage still answers */ });
  return Promise.race([read, new Promise<void>((r) => setTimeout(r, ms))]);
}

const save = () => {
  void stateClient.setUserAppState({ key: KEY, body: { value: JSON.stringify(prefs) } })
    .catch(() => { /* best effort: the next open simply learns again */ });
};

/** The last application this reader opened, if any. */
export const lastApp = (): string | null => lsGet(LS_LAST) ?? prefs.lastApp ?? null;
export function rememberApp(appId: string) {
  lsSet(LS_LAST, appId);
  if (prefs.lastApp === appId) return;
  prefs = { ...prefs, lastApp: appId };
  save();
}

/** Applications (or `<app>:hit` keys) known to exceed countDistinctExact's
 *  1,000,000-value limit — asked for the precision-16 estimate directly. */
export function overExactLimit(key?: string | null): boolean {
  if (!key) return false;
  if ((prefs.overExact ?? []).includes(key)) return true;
  try { return (JSON.parse(lsGet(LS_OVER) ?? "[]") as string[]).includes(key); } catch { return false; }
}
export function markOverExactLimit(key?: string | null) {
  if (!key) return;
  try {
    const xs = JSON.parse(lsGet(LS_OVER) ?? "[]") as string[];
    if (!xs.includes(key)) lsSet(LS_OVER, JSON.stringify([...xs, key].slice(-50)));
  } catch { /* blocked storage */ }
  const cur = prefs.overExact ?? [];
  if (cur.includes(key)) return;
  prefs = { ...prefs, overExact: [...cur, key].slice(-50) };
  save();
}
