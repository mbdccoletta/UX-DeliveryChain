// Pan and zoom for the map surfaces, the way Smartscape behaves:
// wheel zooms toward the pointer, dragging empty space pans, and the
// transform lives on an inner canvas so layout coordinates stay intact.
import { useCallback, useEffect, useRef, useState } from "react";

export interface Transform { x: number; y: number; z: number }
const MIN_Z = 0.35;
const MAX_Z = 2.6;
const clampZ = (z: number) => Math.min(MAX_Z, Math.max(MIN_Z, z));
/** Snap to whole pixels — fractional translation blurs text and SVG strokes. */
const snap = (t: Transform): Transform => ({ x: Math.round(t.x), y: Math.round(t.y), z: t.z });

export function usePanZoom(
  stageRef: React.RefObject<HTMLElement>,
  canvasRef: React.RefObject<HTMLElement>,
) {
  const [t, setT] = useState<Transform>({ x: 0, y: 0, z: 1 });
  // mirror of the transform so pointer handlers never depend on setState timing
  const tRef = useRef<Transform>({ x: 0, y: 0, z: 1 });
  /**
   * Keeps the content inside its own stage.
   *
   * Zooming and panning were unbounded, so the diagram could be pushed past the
   * edges — measured at 128px spilling either side at 60% — and read as the
   * neighbouring panel covering it. Bounds fix that at the source: when the
   * content is larger than the stage its edges may meet the stage's edges but
   * never pass them, and when it is smaller it simply centres.
   */
  const bound = useCallback((t: Transform): Transform => {
    const stage = stageRef.current, canvas = canvasRef.current;
    if (!stage || !canvas) return t;
    const cw = canvas.scrollWidth * t.z, ch = canvas.scrollHeight * t.z;
    const sw = stage.clientWidth, sh = stage.clientHeight;
    const axis = (pos: number, content: number, view: number) =>
      content <= view ? (view - content) / 2 : Math.min(0, Math.max(view - content, pos));
    return { z: t.z, x: axis(t.x, cw, sw), y: axis(t.y, ch, sh) };
  }, [stageRef, canvasRef]);

  const apply = useCallback((next: Transform) => {
    const v = snap(bound(next)); tRef.current = v; setT(v);
  }, [bound]);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  /**
   * True once the user has zoomed or panned by hand.
   *
   * Auto-fitting is right until someone takes control: after that, refitting on
   * every resize would throw away the view they chose, which is worse than a
   * diagram that does not re-centre. So the stage refits itself only while
   * nobody has touched it, and `fit` (the ⤢ button) hands control back.
   */
  const touched = useRef(false);

  /** Scales content down until it fits the stage, then centres it. */
  const fit = useCallback(() => {
    const stage = stageRef.current, canvas = canvasRef.current;
    if (!stage || !canvas) return;
    const w = canvas.scrollWidth, h = canvas.scrollHeight;
    if (!w || !h) return;
    // Only scale down when the content genuinely cannot fit; otherwise keep 1:1
    // so glyphs stay on the pixel grid.
    const needed = Math.min((stage.clientWidth - 24) / w, (stage.clientHeight - 24) / h);
    // The floor used to be 0.9 — "arriving small is arriving weak" — and it
    // meant fit did not fit: at 90% the chain still overflowed and grew a
    // scrollbar, which is exactly what the reader asked to never see. Fitting
    // wins; the base scale of the diagram was raised instead, so even a full
    // fit arrives readable. Zooming past it by hand still pans.
    const z = needed >= 1 ? 1 : clampZ(Math.max(needed, 0.5));
    touched.current = false;
    apply({ z, x: Math.max(0, (stage.clientWidth - w * z) / 2), y: 12 });
  }, [stageRef, canvasRef, apply]);

  const zoomBy = useCallback((factor: number) => {
    touched.current = true;
    const stage = stageRef.current;
    const cur = tRef.current;
    const z = clampZ(cur.z * factor);
    if (!stage) { apply({ ...cur, z }); return; }
    // keep the centre of the stage anchored while zooming with the buttons
    const cx = stage.clientWidth / 2, cy = stage.clientHeight / 2;
    const k = z / cur.z;
    apply({ z, x: cx - (cx - cur.x) * k, y: cy - (cy - cur.y) * k });
  }, [stageRef, apply]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      touched.current = true;
      const cur = tRef.current;
      const z = clampZ(cur.z * (e.deltaY > 0 ? 0.9 : 1.11));
      const k = z / cur.z;
      // zoom toward the pointer, so the point under the cursor stays put
      apply({ z, x: px - (px - cur.x) * k, y: py - (py - cur.y) * k });
    };
    const onDown = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest("[data-node], button, a, input, select")) return;
      drag.current = { x: e.clientX, y: e.clientY, ox: tRef.current.x, oy: tRef.current.y };
      stage.classList.add("dragging");
    };
    const onMove = (e: MouseEvent) => {
      if (!drag.current) return;
      touched.current = true;
      const d = drag.current;
      apply({ ...tRef.current, x: d.ox + (e.clientX - d.x), y: d.oy + (e.clientY - d.y) });
    };
    const onUp = () => { drag.current = null; stage.classList.remove("dragging"); };

    stage.addEventListener("wheel", onWheel, { passive: false });
    stage.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      stage.removeEventListener("wheel", onWheel);
      stage.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [stageRef, apply]);

  /**
   * Refits whenever the stage changes size — dragging the splitter, resizing the
   * window, collapsing a panel. A ResizeObserver rather than a window listener,
   * because the splitter changes this element without the window moving at all,
   * which is exactly the case that was going unhandled.
   */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let frame = 0;
    const ro = new ResizeObserver(() => {
      // one refit per frame: the observer fires continuously while dragging
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { if (!touched.current) fit(); });
    });
    ro.observe(stage);
    /* The CONTENT resizes too: data arrives, labels widen, a column gains
     * cards — and a fit computed before that is stale, which is how the chain
     * ended 401px wider than its stage with no scrollbar left to say so. The
     * canvas is observed with the same one-refit-per-frame guard; a manual
     * zoom still wins, because touched blocks the refit either way. */
    if (canvasRef.current) ro.observe(canvasRef.current);
    return () => { cancelAnimationFrame(frame); ro.disconnect(); };
  }, [stageRef, canvasRef, fit]);

  /**
   * Glides the view so one element sits centred at reading zoom — the answer
   * to "clicked it, now show it to me". Marks the view as user-controlled so
   * the auto-fit does not snatch it back; `fit` (or deselecting) releases it.
   */
  const focusOn = useCallback((elId: string, z = 1.2) => {
    const stage = stageRef.current, canvas = canvasRef.current;
    const el = document.getElementById(elId);
    if (!stage || !canvas || !el) return;
    const cur = tRef.current;
    const er = el.getBoundingClientRect();
    const cr = canvas.getBoundingClientRect();
    const ex = (er.left + er.width / 2 - cr.left) / cur.z;
    const ey = (er.top + er.height / 2 - cr.top) / cur.z;
    touched.current = true;
    canvas.classList.add("glide");
    window.setTimeout(() => canvas.classList.remove("glide"), 460);
    apply({ z, x: stage.clientWidth / 2 - ex * z, y: stage.clientHeight / 2 - ey * z });
  }, [stageRef, canvasRef, apply]);

  return { t, fit, focusOn, zoomIn: () => zoomBy(1.2), zoomOut: () => zoomBy(1 / 1.2), reset: () => { touched.current = true; apply({ x: 0, y: 0, z: 1 }); } };
}
