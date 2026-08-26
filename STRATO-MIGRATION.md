# Strato migration + Saved Journeys model

Approved prototype: https://claude.ai/code/artifact/fa3bc44a-0a40-4e97-8bf1-86a71a9e82ca
Branch: `backend-summary`. Nothing committed.

## Why both at once

The Saved Journeys rewrite deletes most of the custom controls that would
otherwise have to be migrated (the definition mode, its stepper, its refusal
hints, its state-dependent button). Doing the model first means migrating less.

---

## Phase 1 — delete the definition mode

The mechanism the reader could not use. All in `ui/app/components/FlowSankey.tsx`
unless noted.

- `defining`, `definingRef`, `defHint`, `wholeFlowAgain`
- the `.flow-def` entry button and `.flow-def-bar` (bar, steps `1 · pick` / `2 · save`,
  refusal hints, `save this journey`, `clear stored definition`)
- `editJourney` / `startDefining` props and their effects; in `App.tsx` the
  `editJ` and `startDef` state and `onStartDefine` / `onEditJourney` handlers
- in `ReportView.tsx`: `onEditJourney`, `onStartDefine`
- CSS: `.flow-def*`, `.flow-def-bar*`, `.flow-def-step*`, `.flow-def-list`

KEEP (all of it still correct):
- `useOutcomeDefs.ts` — per-user app-state, the two stores, the 404-vs-unreadable
  distinction, `saveJourney` / `dropJourney`
- `ConversionDefs.tsx` — the list; it becomes the chip bar's source
- the route id scheme `jp-<views joined by >` shared with the diagram
- `useRouteCohort.ts` and the whole cohort maths

## Phase 2 — Saved Journeys

1. **Save what is already selected.** The ordinary selection bar gains a
   `Save as journey` button (Strato primary) whenever `picks.length > 0`. It
   opens a Strato TextInput for the name. No mode, no refusals: whatever can be
   selected can be saved.
2. **Storage.** `saveJourney(appId, journey)` already appends. Add `name` to the
   stored shape (`{ path: string[]; name: string; goal: boolean }`) and migrate
   the old array-of-paths form on read (absent name → join with " → ").
3. **Goal is a star, not a prerequisite.** `goal` per saved journey. The
   conversion predicate (`outcome-defs`) is DERIVED: the goals' last views. A
   journey with no star is a filter and nothing more.
4. **One bar on every page.** Lift the chip row out of FlowSankey into a shared
   component mounted by `App.tsx` above the tab content, driven by the `rt` URL
   state that already exists. Journeys, Overview, Delivery Chain, Business
   Control and the poster then all read the same selection.
5. **Wording.** "conversion" disappears from authoring; it returns only as the
   result — *completion rate* — and the board states which goal journeys produced
   it. With no goal set, say so in amber rather than guessing from view names.

## Phase 3 — Strato components

The app already reads these tokens (`ui/app/styles/theme.css:53`), so the
palette work is done; what is left is the CONTROLS.

| custom today | Strato |
|---|---|
| `.flow-sel__b`, `.btn`, `.cdefs__a`, `.cdefs__start` | `Button` (primary / secondary / subtle) |
| `prompt()` for the journey name | `TextInput` + `FormField` |
| `title="…"` on every control | `Tooltip` |
| `.dt-chip` / `.flow-pick` / `.cdefs__r` | `Chip` / `FilterBar` |
| `.bc__rule`, `.rinfo__seg-ft` state strips | `Surface` + `Text` variants |
| `.panel`, `.card` | `Container` / `Surface` |

Rules while migrating:
- one control type per PR-sized change, verified in the browser before the next
- never hand-roll a colour: everything through `--dt-colors-*`
- the canvas sankey stays hand-drawn (Strato has no equivalent), but its label
  colours must come from the same tokens

## Open bugs to fix on the way

1. **The poster opens with 0 sessions** (`openInfographic` in FlowSankey). Both
   queries were measured against the tenant and are healthy — `qPathSessions`
   and `qCohortSessions` both return rows with `sid`. The lead is the **400 Bad
   Request** responses in the app console: identify which request and its body.
   Until this is fixed the poster's conversion block — and the journeys list
   inside it — never render.
2. **Unverified from the last eight rounds**, in test order: the tightened canvas
   hit box (`hitAt`, routes mode `[14, 150]`); multi-route selection now that the
   flow no longer re-mines on pick; the numbered accordion list; the poster
   header showing selected journeys; the empty-cohort fallback on Business
   Control (a journey with no traffic must show the whole application in amber).

## Measured facts worth not re-deriving

- Grail bills by bytes SCANNED and the window is linear; projection is free, so
  extra columns cost nothing — but each `append` leg pays its own scan.
- A query stopped at the 500 GB cap returns `SUCCEEDED` with only a WARNING in
  `result.metadata.grail.notifications`.
- Forecast history is capped at 24h by `forecastPlan` (`utils/forecast.ts`);
  before that a 30-day window asked the analyzer for 90 days, four times over.
- Conversion is ARRIVING, not walking a path: goals are destinations, so a
  customer who reached the goal by another route still converted.
