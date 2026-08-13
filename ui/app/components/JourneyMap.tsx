// Application journey: detected views → requests → services → runtime, with an
// animated mesh. Everything comes from the queries; nothing is hardcoded.
import React, { useEffect, useRef, useState } from "react";
import { fmtMs, fmtN, perfScore } from "../utils/dql";
import type { ChainData } from "../hooks/useChainData";
import { usePanZoom } from "../hooks/usePanZoom";

type Tone = "good" | "warn" | "bad" | "info";
const TVAR: Record<Tone, string> = { good: "var(--good)", warn: "var(--warn)", bad: "var(--bad)", info: "var(--info)" };
const toneOf = (score: number): Tone => (score >= 75 ? "good" : score >= 40 ? "warn" : "bad");

interface N { id: string; col: number; nm: string; mt: string; tone: Tone; det: Array<[string, string]> }

export function JourneyMap({ data, appId }: { data: ChainData; appId: string }) {
  const [sel, setSel] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const { t: view, fit, zoomIn, zoomOut, reset } = usePanZoom(hostRef, canvasRef);

  const views = data.views.filter((v) => v.appId === appId).slice(0, 5);
  // THIS application's busiest request paths — no shape guess: an easyTravel
  // page requests .jsf endpoints, not /api/*, and a filter on the latter left
  // the whole column reading "no data".
  const paths = data.paths.filter((p) => p.appId === appId).slice(0, 4);
  const svcFan = data.calls.reduce<Record<string, string[]>>((a, c) => {
    (a[c.src] ??= []).push(c.dst); return a;
  }, {});
  const services = Object.entries(svcFan).sort((a, b) => b[1].length - a[1].length).slice(0, 4);
  const deps = data.runtime.slice(0, 3);

  const nodes: N[] = [
    ...views.map<N>((v) => {
      const s = perfScore(v.p50);
      return { id: "v-" + v.view, col: 0, nm: v.view, mt: `${fmtMs(v.p50)} · perf ${s}`, tone: toneOf(s),
        det: [["Sessions", fmtN(v.sessions)], ["Views", fmtN(v.views)], ["p50", fmtMs(v.p50)], ["Score", String(s)]] };
    }),
    ...paths.map<N>((p) => ({ id: "r-" + p.path, col: 1, nm: `${p.method ?? ""} ${p.path}`.trim(),
      mt: `${fmtMs(p.p50)} · ${fmtN(p.reqs)} req`, tone: p.status && Number(p.status) >= 400 ? "bad" : "good",
      det: [["Requests", fmtN(p.reqs)], ["p50", fmtMs(p.p50)], ["p90", fmtMs(p.p90)], ["Status", p.status ?? "—"]] })),
    ...services.map<N>(([nm, dst]) => ({ id: "s-" + nm, col: 2, nm: nm.split(" - ")[0],
      mt: `calls ${dst.length}`, tone: dst.length >= 6 ? "warn" : "good",
      det: [["Smartscape", "SERVICE · " + nm], ["Fan-out", String(dst.length)],
            ["Calls", dst.slice(0, 6).map((d) => d.split(" - ")[0]).join(" · ")]] })),
    ...deps.map<N>((r) => ({ id: "d-" + r.pod, col: 3, nm: r.pod.slice(0, 28),
      mt: r.node.startsWith("gke") ? "GKE" : r.node.startsWith("aks") ? "AKS" : "node",
      tone: "info", det: [["Pod", r.pod], ["Node", r.node]] })),
  ];

  useEffect(() => {
    const draw = () => {
      const svg = svgRef.current, host = canvasRef.current;
      if (!svg || !host) return;
      const box = host.getBoundingClientRect();
      const z = box.width / Math.max(1, host.offsetWidth);
      svg.setAttribute("viewBox", `0 0 ${host.offsetWidth} ${host.offsetHeight}`);
      const anchor = (id: string, side: "l" | "r") => {
        const el = document.getElementById("jn-" + id);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: ((side === "r" ? r.right : r.left) - box.left) / z,
                 y: (r.top + r.height / 2 - box.top) / z };
      };
      const parts: string[] = [];
      for (let c = 0; c < 3; c++) {
        const A = nodes.filter((n) => n.col === c), B = nodes.filter((n) => n.col === c + 1);
        A.forEach((a, ai) => B.forEach((b, bi) => {
          if (ai !== 0 && bi !== 0) return;
          const p = anchor(a.id, "r"), q = anchor(b.id, "l");
          if (!p || !q) return;
          const worse: Tone = a.tone === "bad" || b.tone === "bad" ? "bad"
            : a.tone === "warn" || b.tone === "warn" ? "warn" : "good";
          const mx = (p.x + q.x) / 2;
          const dim = sel && sel !== a.id && sel !== b.id;
          parts.push(`<path d="M ${p.x} ${p.y} C ${mx} ${p.y}, ${mx} ${q.y}, ${q.x} ${q.y}"
            stroke="${TVAR[worse]}" style="opacity:${dim ? 0.1 : 0.65}"></path>`);
        }));
      }
      svg.innerHTML = parts.join("");
    };
    draw();
    const id = setTimeout(draw, 60);
    window.addEventListener("resize", draw);
    return () => { clearTimeout(id); window.removeEventListener("resize", draw); };
  }, [nodes, sel, view]);

  const cols = ["Experience (views)", "Requests", "Services", "Runtime"];
  const selNode = nodes.find((n) => n.id === sel);

  useEffect(() => {
    if (!selNode) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSel(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selNode]);

  return (
    <>
      <div className="panel jn stage" ref={hostRef}>
        <div className="stage__canvas" ref={canvasRef}
             style={view.z === 1 && view.x === 0 && view.y === 0
               ? undefined
               : { transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}>
          <svg className="jn-svg" ref={svgRef} aria-hidden="true" />
          <div className="jn-grid">
          {cols.map((c, ci) => (
            <div className="jn-col" key={c}>
              <h3>{c}</h3>
              {nodes.filter((n) => n.col === ci).map((n) => (
                <div key={n.id} id={"jn-" + n.id} className={`nd ${sel === n.id ? "sel" : ""}`}
                  style={{ ["--tone" as string]: TVAR[n.tone] }} role="button" tabIndex={0}
                  onClick={() => setSel((s) => (s === n.id ? null : n.id))}
                  onKeyDown={(e) => { if (e.key === "Enter") setSel((s) => (s === n.id ? null : n.id)); }}>
                  <span className="nd__nm">{n.nm}</span>
                  <span className="nd__mt">{n.mt}</span>
                </div>
              ))}
              {!nodes.some((n) => n.col === ci) && (
                <p className="dim" style={{ fontSize: 12, textAlign: "center" }}>no data</p>
              )}
            </div>
          ))}
          </div>
        </div>
        <div className="zoomctl">
          <button onClick={zoomOut} title="Zoom out" aria-label="Zoom out">−</button>
          <span className="lvl">{Math.round(view.z * 100)}%</span>
          <button onClick={zoomIn} title="Zoom in" aria-label="Zoom in">+</button>
          <button onClick={fit} title="Fit to view" aria-label="Fit to view">⤢</button>
          <button onClick={reset} title="Reset to 100%" aria-label="Reset">1:1</button>
        </div>
      </div>

      {/* details as an overlay, the chain's own pattern: the map keeps its
          full width, and ✕, Escape or the backdrop hand it back untouched */}
      {selNode && (
        <div className="ovl" onClick={(e) => {
          if (e.target === e.currentTarget) setSel(null);
        }}>
          <aside className="panel drawer" role="dialog" aria-modal="true"
            aria-label={`Details: ${selNode.nm}`}>
            <div className="panel__hd">
              <span className="lbl">Selected node</span>
              <span className="hint">{selNode.nm.slice(0, 40)}</span>
              <button className="drawer__x" onClick={() => setSel(null)}
                aria-label="Close">✕</button>
            </div>
            <div className="pad side__body drawer__body">
              {selNode.det.map(([k, v]) => (
                <div key={k} style={{ display: "flex", justifyContent: "space-between",
                  gap: 14, fontSize: 12, padding: "5px 0",
                  borderTop: "1px solid var(--border)" }}>
                  <span className="dim">{k}</span>
                  <b className="num" style={{ fontSize: 12, textAlign: "right" }}>{v}</b>
                </div>
              ))}
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
