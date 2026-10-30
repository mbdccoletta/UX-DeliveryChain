# DeliveryChain UX

Dynatrace AppEngine app that builds the **delivery chain from Smartscape** and
crosses it with **RUM on Grail**, **problems detected by the AI (Davis)**,
**custom alerts** and **extension events**.
App ID: `my.deliverychain.ux`.

## Run on the dev server

Point the checkout at your own environment first. `app.config.json` ships a
placeholder on purpose — the environment you point at is a local fact, not a
committed one:

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

`dt-app dev` opens the SSO URL on first run — you need to authenticate against
the environment. After that the app serves on `http://localhost:3000` (or the
port passed with `-p`).

Deploy: `npm run deploy` (same precedence rules).

> The directory name contains a space, so quote it in shell commands.

## The four views

| Tab | What it shows | Where the data comes from |
|---|---|---|
| **Overview** | One application's health as its users met it: one status from the Apdex Dynatrace computes (Critical under 0.50, Warning under 0.85), sessions, errors and crashes, forecasts from the platform's analyzer, and where in the world they connect from — each country on its own Apdex, down to state. | `dt.frontend.*` metrics, `user.sessions`, Smartscape, `dt.davis.problems` |
| **Journeys** | Session Sankey: application → furthest stage reached → outcome. Where a ribbon narrows is where the business loses people. | `user.events` (sessions per app) + per-session path mining |
| **Delivery Chain** | Seven layers — user, network, application, edge, services, runtime, infrastructure — each with its statistics, Davis problems, custom alerts and extension events. | `smartscapeEdges "calls"` and `"runs_on"`, `smartscapeNodes`, `user.events`, `dt.davis.problems`, `dt.davis.events` |
| **Business Control** | What the experience is worth: conversion, what failure costs, the funnel rung by rung, and the busiest routes. | the mined journeys, plus `user.events` |

Every page carries an **Intelligence** section — questions built around the decision that page
supports, answered inline by Dynatrace Intelligence, grounded in the figures on screen and
instructed to invent none. The Delivery Chain and Business Control open with **whether the cause
is inside or outside the customer's own domains** (own code, domain, edge, services, runtime and
hosts against third-party domains, the users' side and the cloud provider). On the map, an opened
country or state lists the user actions that cost its Apdex most and **what sets it apart** from
the rest of the application (operating system, app version or browser, device, network provider,
how actions ended); each action hands off to Dynatrace Assist with its exact filter.

## Queries

All of them live in [`ui/app/utils/dql.ts`](ui/app/utils/dql.ts) and were
validated against a live estate before becoming code. The main ones:

- **Applications and headline figures**: `dt.frontend.*` metrics by the
  application's Smartscape FRONTEND node (sessions, errors, requests, user
  actions, experience weights); `user.events` only for breakdowns, within a budget
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

## What it costs to run

Grail charges a query by **the bytes it scans**, not the rows it returns, so this is stated rather
than hidden. Every figure below was measured on a production estate (one application of ~4.5
million sessions an hour, a 1-hour window), not estimated; `ui/app/utils/cost.ts` records the
`scannedBytes` the platform reports for every query the app runs. Convert to your own bill with
your contract's Query rate — the figures are volumes, on purpose.

**The headline numbers come from where Dynatrace takes its own.** Sessions, errors by type,
requests and failed calls, user actions and the experience weights are the `dt.frontend.*`
metrics, keyed by the application's FRONTEND node in Smartscape — the figures the platform's
Frontends app shows, coherent with it by construction, and practically free to read. Raw
`user.events` are read only for what metrics cannot answer, and always inside a budget.

### Consumption examples

| What the reader does | Scanned |
|---|---|
| Open the Overview | ≈ 8 GiB |
| Open the Delivery Chain (after the Overview) | ≈ 1–3 GiB |
| Open Journeys (path mining) | ≈ 8.5 GiB |
| Open Business Control | ≈ 24 GiB — ≈ 0 when reopened within 10 minutes |
| Open a country or a state on the map | ≈ 0.5–3 GiB |
| Open a route portrait | ≈ 20 GiB the first time — ≈ 0 when reopened within 5 minutes |
| **A full tour of the four screens** | **≈ 40–45 GiB** (the event-counting releases: ≈ 1,500 GiB) |
| Revisit any screen in the same session | ≈ 0 |
| **Any single query, worst case** | **≤ ≈ 25 GiB** (≤ ≈ 50 GiB for a sized slice read) |

| Usage pattern | Scanned per month |
|---|---|
| One person, five full tours a working day | ≈ 4,700 GiB |
| Ten people, five full tours a working day | ≈ 47,000 GiB |
| A NOC screen reloading the Overview every 15 minutes, around the clock | ≈ 23,000 GiB |

On that estate the app's queries showed **no billed Query usage** in the platform's own billing
events over seven days — RUM queries issued by apps were not billed there at the time of writing.
The volumes above are therefore the load the app puts on Grail, and what it would bill if that
changes; check your own `BILLING_USAGE_EVENT` records rather than assuming either way.

### Guardrails

- **A ceiling on every query.** Each execute carries a scan limit of ≈ 25 GiB, whatever its window
  or fallback; a read that reaches it answers partially, the page says "Partial data", and the
  answer is never cached as whole.
- **The window defaults to 1 hour and is capped at 2.** The label says when the cap acted.
- **Reads sized by what they actually cost.** Journeys and Business Control read a settled
  two-minute (or one-minute) probe first; Grail reports what it scanned, and the window is read
  whole if it fits 25 GiB, or as its last settled minutes, counts scaled and marked "sample · last
  N min". Click-time breakdowns pick their sampling ratio the same way, inside 3 GiB, and refine
  it once the first read reports its real cost.
- **Small places are read exactly.** When a country's user actions fit in a few minutes (the
  metric store says which), those minutes are read whole instead of sampling the hour.
- **No estate-wide fallback.** An application filter does not cut the bytes Grail reads, so no
  screen ever falls back to scanning the whole window of raw events: without the metric store or
  the session store a figure is shown as not measured.
- **Caches.** A per-user, per-window cache (Business Control keeps 10 minutes; the age is always on
  screen; Refresh bypasses it) and an in-page memory, so revisits scan nothing. It is *user* app
  state: a cached result is scoped to the permissions of whoever ran it.

## Scopes

Fifteen, all declared with their reason in
[`app.config.json`](app.config.json). **Fourteen are read or execute; the only
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
| `environment-api:metrics:read` | The RUM classic Apdex (`builtin:apps.*`) — only for an application the new RUM rates no user action for |

> If the **Delivery** tab shows empty service/runtime layers, it is almost
> always the `storage:smartscape:read` scope missing or not granted to the
> user — the banner at the top shows the exact message of the failed query.

## Structure

```
app.config.json                      manifest (id, scopes, version)
ui/main.tsx                          bootstrap (AppRoot, dtVisualRefreshEnabled)
ui/app/App.tsx                       shell: tabs, timeframe, application picker
ui/app/utils/dql.ts                  every query, and what each one measured
ui/app/utils/verdict.ts              the thresholds — one home, every screen
ui/app/utils/links.ts                hand-offs to the platform's own apps
ui/app/hooks/useChainData.ts         loads the estate in parallel, failure tolerant
ui/app/components/Pulse.tsx          Overview, including the geo tile
ui/app/components/FlowSankey.tsx     Journeys (canvas)
ui/app/components/DeliveryChain.tsx  the seven layers and their signals
ui/app/components/ReportView.tsx     Business Control
ui/app/components/Intelligence.tsx   the per-page questions
ui/app/styles/theme.css              tokens, then the app's own layer
```
