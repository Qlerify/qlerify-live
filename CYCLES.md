# Recurring cycles (period-scoped aggregates)

A **cycle aggregate** is a workflow root whose identity is *subject × period* —
"Company X's 2026Q3 quarterly cycle". The engine treats it as a first-class
concept: one case per subject per period, children assigned to the right
period's case by their own business dates, and a new period's case opened
automatically when its first event arrives.

## How the model declares a cycle

Nothing but the entity's natural **`key`** in the Qlerify export:

```json
"Quarter": {
  "key": ["hubspotCompanyId", "quarter"],
  "fields": [ { "name": "id" }, { "name": "quarter" }, { "name": "hubspotCompanyId" }, … ]
}
```

- Key fields whose name is (or ends with) `quarter`, `month`, `week`, or `year`
  form the **period** part; the rest form the **subject** the cycle recurs for.
- An entity with the default `["id"]` key is not period-scoped — non-cycle
  workflows are completely unaffected by any of this.
- Canonical period formats (UTC): quarter `2026Q3`, month `2026-08`, week
  `2026-W32` (ISO 8601), year `2026`. See `src/twin/period.ts`.

## What the engine does (src/twin/period.ts, correlate.ts, derive.ts, packs/ingest.ts)

- **Correlation**: a child row carries only its subject FK (e.g.
  `Meeting.companyId`); the engine buckets the child's business date into a
  period and resolves `(subject value, period)` against the cycle table's
  **column values** (never id shapes) to find the case. The child↔subject match
  is by field name (`companyId` ↔ `hubspotCompanyId`), not entity name, so
  renaming the cycle entity cannot sever it.
- **Canonical row id**: at ingest, the engine composes the cycle row id itself —
  `<subject>@<period>` (e.g. `hubspot-company-3379727147@2026Q3`) — replacing
  any connector-supplied id (with a journaled warning). Connectors never
  hand-compose composite keys.
- **Lazy cycle opening**: when a child's period has no cycle row yet AND the
  subject is known from an earlier period, derive opens the row (marked
  `_provisional`, fields copied from the latest same-subject row) and emits the
  cycle's create event at the period's start (`businessAtKind: estimated`). The
  connector's next pull **merges into** the provisional row instead of skipping
  on the id.
- **Diagnostics** (`DeriveResult.cycles` + connector journal notes): lazily
  opened cycles, children with no business date (period uncomputable — check
  the connector's dateRoles), unknown subject values (value-shape drift between
  parent and child connectors), replaced ids, defaulted periods.

Children do **not** get a period attribute in the model — a stored copy could
disagree with the date it derives from. The date is the truth.

## Connector rules (enforced by the engine, taught to the builder AI)

The connector-builder prompt (`src/packs/connector/codegen.ts`) injects these
automatically — and ONLY — when the model declares a cycle:

- **Cycle table connector**: emit the subject key field(s) verbatim from the
  source's natural key; set the period field in the canonical format (or omit
  it — the engine fills the current period at pull time); do not derive an id.
- **Child table connector**: the subject FK field must carry the cycle table's
  subject value **byte-for-byte** (no added prefixes, no stripped ids); never
  filter rows to the current period — emit everything in scope with real dates.

## Enabling cycles on the Quarterly Cycle Dashboard (operator checklist)

1. **In Qlerify**: set the `Quarter` entity's key to
   `["hubspotCompanyId", "quarter"]`, then reload the model here.
2. **Re-instruct + rebuild the three connectors** in the Connectors tab (the
   builder AI now receives the cycle rules):
   - `hubspot-quarter`: drop the "id: hubspot-company-… NO quarter suffix"
     instruction — no id at all; make `hubspotCompanyId` the exact same string
     the meeting/deal connectors emit (today Quarter stores the bare HubSpot id
     `3379727147` while Meeting/Deal emit `hubspot-company-3379727147` — pick
     one form, use it everywhere).
   - `hubspot-meeting` / `hubspot-deal`: `companyId` must equal that subject
     value verbatim; remove any "current quarter only" source filtering.
3. **Fix meeting dates**: set the `hubspot-meeting` connector's dateRoles
   `created` to `scheduledAt` (today it points at a never-populated
   `createdAt`, so every Meeting event has no business time — and without a
   business date a meeting cannot be bucketed into a quarter at all).
4. **Rebuild the data**: re-pull the connectors and run `POST /sim/rebuild`
   (correlation is stamped at insert; existing EventLog rows are only fixed by
   a rebuild). Watch `DeriveResult.cycles.unknownSubjects` — it lists any
   subject values that still don't line up between connectors.

Next quarter needs no model change: a Q4 pull creates Q4 rows (new canonical
ids), and any Q4 child arriving before the pull opens its cycle provisionally.
Scheduling pulls themselves (server-side cron) is deliberately out of scope for
now — trigger pulls manually or from an external scheduler.
