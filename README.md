# DeliveryChain UX

Dynatrace AppEngine app that builds the **delivery chain from Smartscape** and
crosses it with **RUM on Grail**, **problems detected by the AI (Davis)**,
**custom alerts** and **extension events**.
App ID: `my.deliverychain.ux`.

## Run on the dev server

```bash
cd "/Users/marcelo.coletta/projects/DeliveryChain UX"
npm install
npx dt-app dev --environment-url https://bwm98081.apps.dynatrace.com
```

`dt-app dev` opens the SSO URL on first run — you need to authenticate with a
tenant account. After that the app serves on `http://localhost:3000` (or the
port passed with `-p`).

Deploy to the tenant: `npm run deploy`.

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

## Scopes

Declared in [`app.config.json`](app.config.json): `storage:user.events:read`,
`storage:events:read`, `storage:entities:read`, `storage:smartscape:read`,
`storage:buckets:read`, `storage:system:read`.

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
