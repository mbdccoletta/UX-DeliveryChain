// What "Refresh" has to mean when twenty-six hooks each keep their own cache.
//
// Every data hook in this app memoises its result in a module-level Map keyed
// by the question — timeframe, application, entity. That is deliberate: moving
// between tabs re-mounts the hooks and re-asking Grail for an answer already
// on the screen is money. But Refresh only ever reloaded the shared estate
// loader, so after pressing it the header said "live" over a page that was
// part fresh and part cached, and nothing on the screen distinguished them.
// Worse, a cache cannot be fixed by clearing it: a hook only re-fetches when
// its KEY changes, so an emptied Map is simply an empty Map nobody reads.
//
// So the generation is part of the key. Refresh bumps it, every hook sees a
// key it has never answered, and the whole page goes back to Grail together.
// The old entries become unreachable rather than deleted, which costs memory
// per refresh and buys a guarantee: nothing can serve an answer from before
// the reader asked for a new one.
import { useEffect, useState } from "react";

let gen = 0;
const subs = new Set<() => void>();

/** Refresh: every memo key changes, so every hook asks again. */
export function bumpMemoGen(): void {
  gen += 1;
  subs.forEach((f) => f());
}

/** The current generation, re-rendering the caller when it changes. */
export function useMemoGen(): number {
  const [, force] = useState(gen);
  useEffect(() => {
    const f = () => force(gen);
    subs.add(f);
    return () => { subs.delete(f); };
  }, []);
  return gen;
}
