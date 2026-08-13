// Two-pane layout with a draggable gutter: the map on the left, the drilldown
// on the right. The chosen width survives reloads, and the pane collapses to a
// single column on narrow screens.
import React, { useCallback, useEffect, useRef, useState } from "react";

const MIN = 280;
const MAX_RATIO = 0.6;
const DEFAULT = 380;

export function SplitPane({
  storageKey, left, right,
}: { storageKey: string; left: React.ReactNode; right: React.ReactNode }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState<number>(() => {
    const saved = Number(localStorage.getItem(storageKey));
    return Number.isFinite(saved) && saved >= MIN ? saved : DEFAULT;
  });
  const dragging = useRef(false);
  const wRef = useRef(w);
  wRef.current = w;

  const clamp = useCallback((px: number) => {
    const host = hostRef.current?.clientWidth ?? 1200;
    return Math.round(Math.min(host * MAX_RATIO, Math.max(MIN, px)));
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current || !hostRef.current) return;
      e.preventDefault();
      const right = hostRef.current.getBoundingClientRect().right;
      const next = clamp(right - e.clientX);
      wRef.current = next;
      setW(next);
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.classList.remove("col-resizing");
      // read from the ref: state may not have flushed yet when the drag ends
      localStorage.setItem(storageKey, String(wRef.current));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [clamp, storageKey]);

  /** Keep the pane inside bounds when the window resizes. */
  useEffect(() => {
    const onResize = () => setW((cur) => clamp(cur));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clamp]);

  const startDrag = () => {
    dragging.current = true;
    document.body.classList.add("col-resizing");
  };
  /** Keyboard resize, so the gutter is not mouse-only. */
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft") setW((c) => clamp(c + 24));
    else if (e.key === "ArrowRight") setW((c) => clamp(c - 24));
    else if (e.key === "Home") setW(DEFAULT);
    else return;
    e.preventDefault();
    requestAnimationFrame(() => localStorage.setItem(storageKey, String(wRef.current)));
  };

  return (
    <div className="split" ref={hostRef} style={{ ["--side-w" as string]: `${w}px` }}>
      {left}
      <div className="gutter" role="separator" aria-orientation="vertical" tabIndex={0}
        aria-label="Resize the detail panel" title="Drag to resize · double-click to reset"
        onMouseDown={startDrag} onDoubleClick={() => setW(DEFAULT)} onKeyDown={onKey}>
        <span />
      </div>
      {right}
    </div>
  );
}
