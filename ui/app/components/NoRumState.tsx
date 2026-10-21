// What the product says when there is no RUM application to talk about.
//
// This app answers one question — what a user's journey crosses, and where the
// business loses them — and that question needs a SESSION recorded on the
// client. Dynatrace RUM provides it in `user.events`; a tenant whose primary
// source is OpenTelemetry usually instruments the backend, and has no such
// application at all.
//
// Until now that produced a blank page: every view is gated on a selected
// application, so with none the whole product rendered nothing and explained
// nothing. A blank page is the worst possible answer — it looks like a defect
// in the app rather than a fact about the data.
//
// So this measures instead. It counts what the tenant DOES send and names it,
// then says exactly which half of the product that supports and which half it
// cannot, and why. The rule this product applies everywhere else — say "not
// measurable" rather than dress noise as a finding — applied to itself.
import React from "react";
import { fmtN, qTelemetryShape, runDql } from "../utils/dql";

interface Shape {
  spans: number; otel: number; sessionSpans: number; services: number;
}

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function NoRumState() {
  const [shape, setShape] = React.useState<Shape | null>(null);
  const [state, setState] = React.useState<"loading" | "done" | "error">("loading");

  React.useEffect(() => {
    let live = true;
    (async () => {
      try {
        const rows = await runDql<Record<string, unknown>>(qTelemetryShape(), 1);
        const r = rows[0] ?? {};
        if (!live) return;
        setShape({ spans: num(r.spans), otel: num(r.otel),
          sessionSpans: num(r.sessionSpans), services: num(r.services) });
        setState("done");
      } catch { if (live) setState("error"); }
    })();
    return () => { live = false; };
  }, []);

  const otelLed = shape ? shape.otel > 0 && shape.otel >= shape.spans * 0.5 : false;
  /* The one number that decides whether a journey mine is even possible on this
     tenant: a session id on a span. Without it there is nothing to group by. */
  const clientInstrumented = shape ? shape.sessionSpans > 0 : false;

  return (
    <div className="norum">
      <div className="norum__hd">
        <h2>No RUM application in this environment</h2>
        <p>
          This product mines journeys from Dynatrace RUM sessions. The
          application picker enumerates frontends by their RUM instrumentation
          id, and this environment has none — so there is nothing to select, and
          the journey views have nothing to draw.
        </p>
      </div>

      {state === "loading" && (
        <div className="norum__probe">measuring what this environment does send…</div>
      )}

      {state === "error" && (
        <div className="norum__probe norum__probe--bad">
          Could not read the span store to say what this environment sends —
          most often the <span className="num">storage:spans:read</span> scope is
          not granted to this user.
        </div>
      )}

      {state === "done" && shape && (
        <>
          <div className="norum__facts">
            <div className="norum__f">
              <b className="num">{fmtN(shape.services)}</b>
              <span>services on the map</span>
            </div>
            <div className="norum__f">
              <b className="num">{fmtN(shape.spans)}</b>
              <span>spans in the last 2h</span>
            </div>
            <div className="norum__f">
              <b className="num">{fmtN(shape.otel)}</b>
              <span>of them OpenTelemetry</span>
            </div>
            <div className={clientInstrumented ? "norum__f" : "norum__f norum__f--bad"}>
              <b className="num">{fmtN(shape.sessionSpans)}</b>
              <span>carry a session id</span>
            </div>
          </div>

          <div className="norum__verdict">
            {clientInstrumented ? (
              <p>
                Some spans here carry <span className="num">session.id</span>,
                which is the field a journey would be mined from. It is not what
                this product reads today — every journey query reads{" "}
                <span className="num">user.events</span> — so the journey views
                stay empty until that mine is rebuilt against spans.
              </p>
            ) : (
              <p>
                <b>No span in this environment carries a session id.</b>{" "}
                {otelLed
                  ? "OpenTelemetry leads the telemetry here, and it is instrumenting the backend: "
                  : ""}
                without a session recorded on the client there is no journey to
                mine — not by this product, and not by any rebuild of it. What is
                missing is client instrumentation (Dynatrace RUM, or OpenTelemetry
                browser/mobile emitting <span className="num">session.id</span>),
                not a query.
              </p>
            )}
          </div>

          <div className="norum__split">
            <div className="norum__col norum__col--no">
              <span className="norum__col-l">no data for it here</span>
              <ul>
                <li><b>Overview</b> — Apdex, sessions, crashes</li>
                <li><b>Journeys</b> — the session flow</li>
                <li><b>Business Control</b> — conversion and what failure costs</li>
              </ul>
              <p>
                All three are mined from RUM sessions. No query rewrite reaches
                them without a session recorded on the client.
              </p>
            </div>
            <div className="norum__col norum__col--ok">
              <span className="norum__col-l">your data supports it — the view does not, yet</span>
              <ul>
                <li><b>Services and runtime</b> — Smartscape topology, which OTel spans build</li>
                <li><b>Problems and alerts</b> — Davis, custom events, extensions</li>
                <li><b>Infrastructure</b> — hosts, pods and their placement</li>
              </ul>
              <p>
                {shape.services > 0 ? <>The {fmtN(shape.services)} services above are
                  already on the map. </> : null}
                But the Delivery Chain is built as <em>the chain one application
                reaches</em> — it starts from the RUM application and walks down.
                Serving an environment with no application means giving it a
                second entry point, rooted in a service rather than a frontend.
                That work is not done; this page would rather say so than open a
                view that renders empty.
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
