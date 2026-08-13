// The URL is the app's shareable state.
//
// A finding here is only useful if it can be sent to someone: "the footer on
// the checkout view is losing 183 sessions" has to travel as a link, not as
// instructions. So the view, the application, the window and the selected
// element live in the query string, and the browser's back button walks them.
//
// Deliberately NOT in the URL: hover, focus mode, the splitter width, scroll.
// Those are transient or per-person, and putting them in a shared link would
// impose one person's screen on another.
import { useCallback, useEffect, useRef, useState } from "react";

export type UrlState = Record<string, string | null>;

/** Reads the current query string into a plain object. */
function read<T extends UrlState>(defaults: T): T {
  const q = new URLSearchParams(window.location.search);
  const out = { ...defaults };
  for (const k of Object.keys(defaults) as Array<keyof T & string>) {
    const v = q.get(k);
    if (v !== null) out[k] = v as T[keyof T & string];
  }
  return out;
}

/** Serialises state back, dropping the keys that hold their default. */
function write<T extends UrlState>(next: T, defaults: T): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(next)) {
    if (v === null || v === undefined || v === defaults[k]) continue;
    q.set(k, v);
  }
  const s = q.toString();
  return s ? `?${s}` : window.location.pathname;
}

export interface UrlStateApi<T extends UrlState> {
  state: T;
  /**
   * @param push true for a change worth a history entry (a different view, a
   * different application, a different element), false for an adjustment that
   * would only clutter the back button — the guide calls out relative
   * timeframes as the example of the latter.
   */
  set: (patch: Partial<T>, push?: boolean) => void;
}

export function useUrlState<T extends UrlState>(defaults: T): UrlStateApi<T> {
  const [state, setState] = useState<T>(() => read(defaults));
  // The history call is a side effect, so it must not live inside a setState
  // updater: React may invoke an updater more than once, which would push
  // duplicate entries. The ref mirrors the state so `set` can compute the next
  // value without asking React for the current one.
  const ref = useRef(state);
  ref.current = state;

  // the back and forward buttons are navigation, so they drive the state
  useEffect(() => {
    const onPop = () => setState(read(defaults));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
    // defaults is a literal from the caller; re-reading on identity change
    // would loop, and its values never change during a session
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = useCallback((patch: Partial<T>, push = true) => {
    const next = { ...ref.current, ...patch };
    const url = write(next, defaults);
    if (url !== window.location.search + window.location.hash) {
      if (push) window.history.pushState(next, "", url);
      else window.history.replaceState(next, "", url);
    }
    ref.current = next;
    setState(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { state, set };
}
