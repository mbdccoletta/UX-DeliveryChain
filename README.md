# DeliveryChain UX

Dynatrace AppEngine app that builds the **delivery chain from Smartscape** and
crosses it with **RUM on Grail**, **problems detected by the AI (Davis)**,
**custom alerts** and **extension events**.
App ID: `my.deliverychain.ux`.

## Run on the dev server

Point the checkout at your own environment first. `app.config.json` ships a
placeholder on purpose — the tenant you use is a local fact, not a committed
one:

```bash
cp .env.example .env      # then edit DT_APP_ENVIRONMENT_URL
npm install
npm start
```

Precedence is `--environment-url` flag → `DT_APP_ENVIRONMENT_URL` → the value
in `app.config.json`, so a one-off environment needs no edit at all:

```bash
npm start -- --environment-url https://<your-environment>.apps.dynatrace.com
```

`dt-app dev` opens the SSO URL on first run — you need to authenticate with a
tenant account. After that the app serves on `http://localhost:3000` (or the
port passed with `-p`).

Deploy: `npm run deploy` (same precedence rules).

> The directory name contains a space, so quote it in shell commands.

## The four views

| Tab | What it shows | Where the data comes from |
|---|---|---|
| **1 · Flow** | Session Sankey: application → furthest stage reached → outcome. Ribbon width is the session count, so wherever a ribbon narrows is where the business loses users. | `user.events` (sessions per app) + per-session path mining |
| **2 · Delivery** | Seven layers (user → network → application → edge → services → runtime → infrastructure) with an animated mesh, one distinct icon per layer and, on every link, statistics + Davis problems + custom alerts + extensions. | `smartscapeEdges "calls"` and `"runs_on"`, `smartscapeNodes`, `user.events`, `dt.davis.problems`, `dt.davis.events` |
| **3 · Journey** | Measured views → requests → services → runtime, with the mesh and per-node detail. | `user.events` (view_summary and request) + Smartscape |
| **4 · Health** | Environment rollup, application table, active problems and volume per event provider. | `user.events`, `dt.davis.problems`, `dt.davis.events` |

## Queries

All of them live in [`ui/app/utils/dql.ts`](ui/app/utils/dql.ts) and were
validated against the tenant before becoming code. The main ones:

- **Applications**: `user.events` aggregated by `dt.rum.application.id`
- **Journey sequences**: `collectArray` of views per session, with URLs
  normalized (`/product/*`, `/cart/checkout/*`)
- **Devices**: by `device.screen`, `device.orientation`, `dt.rum.agent.type`
- **Domains and paths**: `request` events by `url.domain` / `url.path`
  (`browser.name` is populated on those events, but not on view events)
- **Topology**: `smartscapeEdges "calls"` between services and `"runs_on"`
  from pod to node
- **Signals**: active `dt.davis.problems` and `dt.davis.events` by
  `event.provider` (separating Davis AI, `METRIC_EVENTS` and
  `EVENTS_REST_API_INGEST`)

Every query is failure tolerant: if one cannot run (a missing scope, say), the
screen keeps working and the error shows up in a banner at the top.

## What this app costs to run (DPS)

This app reads Grail, and **Grail bills a query by the bytes it scans**, not by
the rows it returns. Everything below was measured on a reference estate rather
than estimated; the accounting lives in
[`ui/app/utils/cost.ts`](ui/app/utils/cost.ts), which records the
`scannedBytes` the platform reports for every query the app runs.

**The timeframe is the biggest lever, and it is linear.** One full tour of a
2-hour window scanned ~16.9 GB. The same tour over 24 hours is roughly 12× that
(~200 GB); over 30 days it would be ~6 TB. At the published DPS list rate for
querying Grail — **$0.0035 per GiB scanned** — that is about $0.06, $0.66 and
$20 respectively. Your contract may carry a different rate.

**Filters change the bill; projections do not.** A bare `count()` and an
eight-column `summarize` scanned the same 5.9 GB of a 2-hour window. Scoping to
a single application cut that to 2.9 GB, and to a small application to 0.24 GB.
Each `append` leg pays its own scan.

Three guardrails are built in:

- **The window length is capped at 24 hours** ([`ui/app/App.tsx`](ui/app/App.tsx)).
  The end you picked is kept and the start is pulled up to 24h before it, so a
  careless 30-day selection cannot bill like one. The label says when the cap
  acted — a silently different window is the one lie this app refuses to tell.
- **A per-user, per-window cache** ([`ui/app/utils/cache.ts`](ui/app/utils/cache.ts))
  with a TTL that follows the window (1–10 minutes). Revisiting a screen in the
  same window scans nothing. The age is always on screen and Refresh always
  bypasses it. It is *user* app state, not app state: a cached result is scoped
  to the permissions of whoever ran it, so it cannot leak RUM figures to a
  reader without RUM scopes.
- **Truncation is detected, not ignored.** Grail stops a fetch at its 500 GB
  scan limit, returns state `SUCCEEDED`, and puts the warning in the metadata —
  so a wide window quietly answers from a partial scan. `isScanLimit()` catches
  that message and the query is counted as truncated.

> **Not surfaced in the UI today.** The header readout that showed the running
> total was removed in `8cac9b0`, so `scanTotals()`, `fmtBytes()` and
> `fmtMoney()` currently have no consumer — the app measures its own
> consumption and prints it nowhere. The counters and the CSS (`.scanb`) are
> intact if you want to put it back.

## Scopes

Fourteen, all declared with their reason in
[`app.config.json`](app.config.json). **Thirteen are read or execute; the only
write is the app's own per-user query cache.**

| Scope | Why |
|---|---|
| `storage:user.events:read` | RUM on Grail: views, requests, errors and actions |
| `storage:user.sessions:read` | `frontend.name` per application — the name Users & Sessions filters by, which differs from the entity name |
| `storage:events:read` | Davis problems, custom alerts and extension events |
| `storage:entities:read` | Names of applications, services and other entities |
| `storage:smartscape:read` | Topology: `smartscapeNodes` and `smartscapeEdges` (the delivery chain) |
| `storage:buckets:read` | Bucket metadata the DQL client requires |
| `storage:system:read` | System tables used by DQL |
| `storage:spans:read` | Opens one specific request in Distributed Tracing — that app accepts a trace id and nothing else |
| `storage:metrics:read` | Throughput forecast per service rides the metric store, orders cheaper than re-scanning 24h of spans |
| `davis:analyzers:read` | Read the predictive analyzer definitions |
| `davis:analyzers:execute` | Run the forecast analyzer |
| `davis-copilot:conversations:execute` | List and run the conversation skill behind "Explain this page" |
| `state:user-app-states:read` | Read the per-user query cache |
| `state:user-app-states:write` | Write the per-user query cache |

> If the **Delivery** tab shows empty service/runtime layers, it is almost
> always the `storage:smartscape:read` scope missing or not granted to the
> user — the banner at the top shows the exact message of the failed query.

## Structure

```
app.config.json                      manifest (id, scopes)
ui/main.tsx                          bootstrap (AppRoot)
ui/app/App.tsx                       shell: tabs, timeframe, application picker
ui/app/utils/dql.ts                  queries + formatting helpers
ui/app/hooks/useChainData.ts         loads everything in parallel, failure tolerant
ui/app/components/FlowSankey.tsx     session flow (canvas)
ui/app/components/DeliveryChain.tsx  delivery chain + per-layer signals
ui/app/components/JourneyMap.tsx     application journey
ui/app/styles/theme.css              "operations terminal" theme
pilots/prototype.html                navigable prototype the app grew from
```
