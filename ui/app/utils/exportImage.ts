// One-click PNG of a screen region — the poster and the board are things
// people paste into slides and tickets, and a screenshot crops what a real
// export keeps: the whole element, at 2× for text that survives projection.
//
// html-to-image serialises the live DOM with its computed styles into an SVG
// foreignObject and rasterises it — bundled, so the CSP (which only guards
// runtime origins) is not involved. Cross-origin webfonts that refuse to
// inline simply fall back to the stack's next font rather than failing the
// export.
import { toPng } from "html-to-image";

export async function exportImage(el: HTMLElement, filename: string): Promise<void> {
  /* FAITHFUL TO ALL OF IT — twice over. Vertically: a max-height container
   * (the poster) renders clipped, so the clone stands at full scroll
   * height. Horizontally: DESCENDANT rails with their own overflow (the
   * tile row, long sequences, wide tables) keep clipping even when the
   * canvas is wide, because their width tracks the root's — so the deep
   * content width is measured across every descendant and the CLONE is
   * told to stand that wide; percent-width children then expand and the
   * rails no longer cut. The live element never changes. */
  const rect = el.getBoundingClientRect();
  let fullH = Math.max(el.scrollHeight, el.clientHeight);
  let fullW = Math.max(el.scrollWidth, el.clientWidth);
  el.querySelectorAll<HTMLElement>("*").forEach((n) => {
    const r = n.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    fullW = Math.max(fullW, Math.round(r.left - rect.left) + n.scrollWidth);
    fullH = Math.max(fullH, Math.round(r.top - rect.top) + n.scrollHeight);
  });
  fullW = Math.min(fullW, 4200); fullH = Math.min(fullH, 16000);
  /* THE CLONE MUST STAND AT THE ORIGIN. The poster centres itself with the
   * classic `position:absolute; inset:0; margin:auto` — so the clone kept
   * resolving those auto margins and was rendered OFFSET inside the canvas,
   * overflowing the right edge by exactly the left gap. Invisible on a narrow
   * window (27px each side) and ruinous on a wide one (~370px), which is why
   * it survived the first horizontal fix. Neutralised here, on the clone
   * only — the live element is never touched. */
  const url = await toPng(el, {
    width: fullW,
    height: fullH,
    style: { maxHeight: "none", maxWidth: "none", height: `${fullH}px`,
      width: `${fullW}px`, overflow: "visible",
      position: "static", inset: "auto", margin: "0", transform: "none" },
    pixelRatio: 2,
    // chrome that only makes sense on screen (the export button itself, a
    // close ✕) stays out of the picture
    filter: (node) => !(node instanceof HTMLElement
      && (node.classList.contains("noexport") || node.classList.contains("drawer__x"))),
    // the app's ground, so a region with transparent padding does not export
    // as a checkerboard-looking hole in dark decks
    backgroundColor: getComputedStyle(document.body).backgroundColor || "#0e1017",
    // webfont CSS from the platform origin can refuse serialisation; skip it
    // and let the fallback stack render instead of throwing
    skipFonts: true,
  });
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".png") ? filename : `${filename}.png`;
  a.click();
}
