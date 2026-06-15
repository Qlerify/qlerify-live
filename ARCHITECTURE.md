# qlerify-live — Architecture Plan

> **Goal:** a *process-native* competitor to Palantir. The live source of truth is a
> Qlerify event-storming / DDD model (a domain-event DAG with commands, aggregates,
> entities, value objects, read models, roles, and Given/When/Then acceptance criteria).
> Palantir is *data-native*; we are *process-native*.

## 0. The reframe — live *reload* vs live *reconfiguration*

Today the model is a hot-swappable **data object** that a few passive views read
(`model.ts` reloads `workflow.json`; `registry.ts` `EVENTS` and the chat system prompt
rebuild; the frontend redraws the diagram). But the **systems themselves** — the 7
bounded contexts' command handlers, business logic, Prisma tables, read-models, and
widgets — are hand-written TypeScript generated *once*. Edit the model and add an event,
field, or whole system, and none of it materializes.

**This plan's entire job:** turn the model from a data object a few views read into a
**spec the running system re-derives its behavior from.**

## 1. Shape — a Kernel + Packs; the 5 parts are *layers inside a pack*

Two tiers, not five top-level subsystems:

- **Kernel** (`src/kernel/`) — deterministic platform, hand-written *once*, never per-system:
  ontology loader + hot-reload (`model.ts`), event bus + log writer (`bus.ts`), HTTP `cmd()`
  wrapper + auth seam, errors/invariants, model round-trip (`sync.ts`), registry overlay,
  Prisma client — **plus two new pieces: a codegen engine and a pack-loader.**
- **Packs** (`src/packs/{bc}/`) — one per bounded context / source system (Helix, PRIM, SAP,
  ESTER, Compass, Test, Logistics today; Cognito, real-SAP later). Each pack bundles the 5
  parts as layers: `adapter/` (#2), `commands/` (#3), `widgets/` (#4), `ingestion/` (#5) +
  a `pack.manifest.json`, exporting a stable `Pack` interface the kernel mounts via
  `loadPacks()` — replacing the 28 hand-listed routes in `routes.ts:63-136`.

**"Rig the app for codegen on the fly"** then means **"scaffold one new pack folder"**, not
"edit five cross-cutting subsystems."

**Dependency direction** (strict, acyclic): Ontology(1) → everything. Within a pack:
Ingestion(5) → Adapter(2) → Command(3) → View(4). The *informs-the-model* arrow runs
**backward**: an adapter discovers `firstName` ≠ `first-name` → proposes a model delta →
`sync.ts` write-path applies it → hot-reload re-scaffolds the deterministic half.

## 2. The shared primitive + LOCKED decisions

Every generator (commands, adapters, widgets, detectors, ingestion) emits into the **same
seam: deterministic scaffold + AI-authored region + a regen manifest.**

| Decision | LOCKED choice | Rationale |
|---|---|---|
| **AI-region seam** | **Two files**: `{x}.gen.ts` (deterministic, always overwritten) + `{x}.logic.ts` (AI: `apply()`+`detect()`+`DESCRIBE`, preserved), joined by a typed `CommandContext`. | No-build repo, no AST tooling; clean git diffs; trivial regen rule. |
| **Non-DDD config home** | **One sidecar** `.qlerify/overlay.json`, keyed by model ref, merged + validated in `loadOntology` (reuses `problems[]`/throw + hot-reload). | `workflow.json` stays Qlerify's pristine, byte-round-tripping export (sync.ts hashing/version-history intact). Avoids 6 scattered sidecars + precedence chaos. |
| **Model write-path** | **Build early** — `sync.ts` → Qlerify MCP `update_*` with **review-then-apply + conflict/merge**. | Unlocks the "adapter corrects the model" loop; it's the single biggest dependency 4 of 5 parts assume exists. |
| **First slice** | **Pilot the SAP Purchase Order pack** behind existing routes. | Proves scaffold + AI-region + regen + detect + describe on a real state machine, demo intact. |

**One `detect()` per event, shared** between the command precondition guard (#3) and the
storyline-reconstruction predicate (#5). Same GWT → one signature, one home — generalized
from the two predicates already in `derived.ts`.

**Regen manifest** (per command/widget/adapter, in `codegen.json`):
`{gwtHash, schemaHash, aiPromptHash, generatedAt}`.
- **Regenerate everything** — always re-emit `.gen.ts`; re-invoke AI only when `gwtHash` drifted (hand-edits survive).
- **Regenerate AI-only** — rewrite one `.logic.ts`.
- Drift is **surfaced, not auto-applied** (same discipline as `registryError`).

## 3. The five sections

**Part 1 — Ontology as the live-config surface.** Extend `loadOntology` to merge + validate
`overlay.json`; move `STEP_SEQUENCE`/phases/`derived` out of `registry.ts` into config; add
`linearOrder()` defaulting to `topologicalOrder()`. Make the workflow **VIEW** model-driven —
`app.js` calls `/ontology` *zero times* today and hardcodes `BC_PANELS`; serve panels/columns/
tones from the overlay via `/api/ontology`. *Det:* whole merged ontology + view. *AI:* only
classification prose written *into* the overlay as reviewable JSON.

**Part 2 — Adapters + model-correction loop.** A `SourceAdapter` interface (`introspect /
mapping / pull / push / healthcheck`); sidecar `.qlerify/adapters/<id>.json`. The FDE loop
runs in the existing chat agent harness (`agent.ts`/`tools.ts`, confirmation-gated):
introspect source API → propose `fieldMap` against the imprecise ontology entity → write +
**test on the fly** → on contradiction, emit a structured `modelCorrection` back through the
`sync.ts` write-path. *Det:* interface, `applyFieldMap`, secret resolution, `emit()` push
envelope. *AI:* field-map pairs + pull/push body + correction diff.

**Part 2a — Simulated adapters (the default scaffolded state).** Every `SourceAdapter`
carries a `mode: 'simulated' | 'recorded' | 'live'` behind one interface, so nothing
downstream knows which it's talking to. A freshly scaffolded pack gets a **simulated** adapter
for free, so it runs end-to-end — commands, twin, widgets — *before any real adapter exists.*
Example data is tiered, deterministic-first: (1) **model-synthesized** from each entity's
`SchemaField.exampleData` + `dataType` + `required`, honoring `relatedEntity` FKs so a
synthesized PurchaseOrder links to a synthesized Project (seeded RNG → reproducible);
(2) **AI-enriched** fixtures via the chat harness when examples are sparse or need narrative
realism; (3) **recorded** real responses captured into `.qlerify/adapters/<id>/fixtures/` once
the live API is reachable. Crucially a simulated adapter can emit a *storyline* of raw
create/update/delete events along a plausible timeline (reusing `simulator/` + `clock.ts`),
not just a static snapshot — directly satisfying the "recreate the likely events along the
storyline" note and giving the twin a believable history. The **mode ladder is the FDE
workflow:** start `simulated` → `record` real responses (deterministic, offline tests) → flip
to `live`; the same fixtures are the test oracle at every rung, and a recorded response that
doesn't match the model-synthesized shape is exactly how `firstName` vs `first-name` surfaces
as a `modelCorrection`. *Det:* the synthesizer, fixture replay, the mode switch. *AI:* enriched
fixtures + the believable storyline.

**Part 3 — Commands.** Keep the working skeleton (`assertRole → validate → load+guard →
mutate+version → emit`) but **source role from `event.role`** (kills hardcoded `'Buyer'`) and
validation from `command.required` + entity-field type recovery. *Det:* `.gen.ts` skeleton +
routes + `/detect` endpoint + `DESCRIBE` template. *AI:* `apply()` (GWT "Then"), `detect()`
(predicate + evidence), refined `DESCRIBE`. Auto-generated human-readable command + detection
description.

**Part 4 — Views/widgets.** Runtime-interpreted by default, AI-injected per widget. A
server-built **widget manifest** (`src/views/manifest.ts` from `getOntology()`): one form per
command, one table per array read-model, one detail per entity — hot-reloaded like `EVENTS`.
`app.js` gains generic `renderWidget(descriptor, data)`. A widget may declare
`custom:{module:'web/widgets/<id>.js'}` — AI-authored ES module dynamically imported, falling
back to the deterministic widget on throw/missing. Custom modules marked **stale** on hash
mismatch, never auto-broken.

**Part 5 — Ingestion → dual event store → digital twin.** Peel the single `EventLog` into:
**Store 1 `RawEvent`** (immutable, append-only, adapter-fed: `RawCreated`/`RawUpdated`
generic, `RawDeleted`, `RawKnown` with real `eventRef`); **Store 2 `BusinessEvent`** (today's
`EventLog`, now derived & rebuildable); **the twin** = Prisma aggregate tables as projections.
A `src/twin/` module: `ingest()`, a `Reconstructor` walking `topologicalOrder()` running each
event's shared `detect()` over raw rows, a `Projector` replaying Store 2 into truncated tables,
and `replay()` wired to `onOntologyReload` so **changing the model or the data triggers a
rebuild.** Importing completed cases = recreate the likely storyline via `runner.ts`. Lazy vs
materialized is a per-BC config knob.

**Cross-cutting — Security (crypto-shredding).** Tag `pii`/`subjectKey` per field **in the
overlay**; encrypt at the single `bus.ts` serialization chokepoint with a per-subject DEK from
a pluggable `KeyVault` (dev = SQLite table wrapped by a master KEK; prod = Supabase Vault/KMS
behind the same interface). **`forgetSubject()` = destroy the key** → log immutable, ciphertext
permanently unreadable, next Store-2 rebuild yields tombstones for free. Same vault stores
adapter credentials.

## 4. The platform spine to build ONCE, first (owned by no single section)

1. **Model write-path** — `sync.ts` is pull-only (`get_workflow`) today. Add code→model push
   (MCP `update_*` + review-then-apply + conflict/merge). *(Locked: build early.)*
2. **Event idempotency + monotonic per-stream sequence** — `EventLog` has **no unique
   constraint**; replays double-fire. Fix at the persistence layer before splitting the store.
3. **Ambient `mode: live | replay` on the bus** — so rebuilds don't re-call real Cognito/SAP or
   re-fire derived events. `emit()` is the choke point; add a mode.
4. **Code→model drift detector** — inverse of `loadOntology` validation; turns `codegen.json`'s
   free-text `syncedFromCode` notes into a real reviewable diff.
5. **Config precedence + single overlay load/validate gate**; **provenance enum**
   (`initial|fetch|code-sync|adapter-sync`).
6. **Codegen acceptance gate** — revive `runner.ts` `runHappyPath` as an npm script that *must
   pass* after any regeneration. It's the only end-to-end oracle and is currently dead.

## 5. Sequencing

- **Increment 0 — Spine + lock the seam:** spine #2, #3, #6 + codegen engine + overlay loader/validation.
- **Increment 1 — Pilot SAP Purchase Order pack** (see below), demo intact.
- **Increment 2 — Model write-path** (#1, #4, #5) with review + conflict handling.
- **Increment 3 — First real adapter (Cognito)** + the `firstName` correction loop (needs Inc. 2).
- **Increment 4 — Dual store + twin + replay** (needs Inc. 0 idempotency/seq/mode).
- **Increment 5 — Crypto-shredding** — *must precede the first real-PII adapter pull.*
- **Increment 6 — Views rewire** to the manifest.

**Simulated adapters land early** (right after Increment 1): because they need no credentials
and no write-path, a model-synthesized simulated adapter (Part 2a) lets you exercise the dual
store, twin, and widgets (Increments 4 & 6) with believable data long before the first real
adapter (Increment 3).

**Ordering constraints:** write-path before any adapter-informs-model loop · idempotency/seq/
replay-mode before the dual store · seam mechanism before any generator · overlay validation
before simplifying `registry.ts` and rewiring the frontend · crypto-shred before real PII
ingest · preserve byte-stable `/commands/{bc}/{name}` + `/queries/{name}` URLs and extend
`tests/ontology/conformance.test.ts` before swapping route registration.

## 6. Increment 1 — SAP Purchase Order pilot (the concrete first slice)

State machine: `DRAFT → ORDERED → CONFIRMED → RECEIVED` (richest self-contained money-path).

1. **Lock the seam** as two files: `{command}.gen.ts` + `{command}.logic.ts`.
2. **Build the kernel codegen seam:** `src/kernel/codegen/` (deterministic generator reading
   `getOntology()` + per-command `codegen.json` record) and `src/commands/runtime.ts`
   (`CommandContext`, `validateAgainstSchema`). Reuse the Anthropic client pattern from
   `chat/agent.ts` for the AI authoring step.
3. **Regenerate the 4 SAP PO commands** (confirm exact names against `src/sap/purchase-order/
   commands.ts` + the model) into `.gen.ts` (skeleton) + `.logic.ts` (`apply`/`detect`/`DESCRIBE`).
4. **Source `assertRole` from `event.role`** (remove the hardcoded `'Buyer'` literal); build
   validation from `command.required` + entity-field type recovery.
5. **Add per-command codegen records** (`gwtHash`, `schemaHash`, `aiModel`, `aiPromptHash`) and
   `/commands/sap/{name}/describe` + `/commands/sap/{name}/detect` endpoints.
6. **Prove both regen operations:** regenerate-AI-only rewrites one `.logic.ts`; model
   hot-reload re-emits `.gen.ts` with the AI region byte-untouched.
7. **Acceptance gate:** revive `runHappyPath` (`runner.ts`) as an npm script that must still pass
   after regeneration.

This slice proves live-config → deterministic scaffold (Parts 1+3), the AI-region/regen
boundary every other part reuses, the GWT→logic seam, detection, and the conformance/golden-test
discipline — all behind existing routes with the working demo intact.

### Increment 1 — STATUS: DONE (2026-06-14)

Built and verified:
- **Kernel codegen** `src/kernel/codegen/` — `introspect.ts` (model → CommandDescriptor,
  deterministic, with command-field type recovery from the aggregate entity), `emit.ts` (pure
  content emitters), `generate.ts` (idempotent writer + manifest), `status.ts` (drift detector),
  `ai.ts` (regenerate-AI-only via the Anthropic client + GWT prompt).
- **Runtime seam** `src/commands/runtime.ts` (`CommandContext`, `DetectInput`, `DetectResult`),
  `src/commands/registry.ts` + generated `registry.generated.ts` (detect/DESCRIBE registration).
- **Two-file seam for the 4 SAP PO commands**: `{cmd}.gen.ts` (deterministic skeleton, role from
  `event.role` — no hardcoded literal) + `{cmd}.logic.ts` (apply/detect/DESCRIBE). `commands.ts`
  is now a generated barrel, so HTTP routes / runner / tests import the same path unchanged.
- **Endpoints**: `/api/commands`, `/api/commands/status`, `/commands/:bc/:name/describe`,
  `POST /commands/:bc/:name/detect`.
- **npm scripts**: `codegen`, `codegen:ai`, `sim`, `sim:disruptions`.
- **Conformance test extended** to understand BOTH handler styles (legacy single-file +
  generated .gen/.logic seam) — the prerequisite the critique flagged.

Proven: tsc clean · **103/103 tests pass** · happy path 34 events · generator idempotent
(2nd run 0 writes) · **regenerate-everything leaves .logic.ts byte-identical** · live vertical
(detect=false → order via generated handler → PO ORDERED → detect=true → event logged) · wrong
role → 403 · **edit a GWT in the live model → hot-reload → that one command flips to gwt-drift
while the others stay current → restore → all current** (live reconfiguration, per-command
granularity). `.qlerify/codegen.commands.json` records gwtHash/schemaHash/aiPromptHash per command.

Not yet done (deferred per plan): regenerate-AI-only was built but not run live (needs an API
call); the generator only writes the .gen skeleton, so a brand-new command still needs its
.logic.ts authored (by hand or `codegen:ai`). The pre-existing `--with-disruptions` runner bug
(lockBuildPlan on a SUPERSEDED plan id) is unrelated to this increment and left as-is.

**Next:** Increment 2 (model write-path) per §5, or migrate a second bounded context to prove
the generator generalizes beyond SAP.

### Increment 1b — STATUS: DONE (2026-06-14) — "swap reconfigures everything deterministic"

Goal: a full ontology swap reconfigures everything that *can* be model-derived; only the
AI/hand-written business code remains to (re)author, and it's auto-stubbed so the app still
compiles and boots. Plus an irreversible-drop warning before any projection table is dropped.

Built and verified:
- **Overlay sidecar** `.qlerify/overlay.json` (order/phase/derived keyed by event key), merged +
  validated inside `loadOntology` (stale keys fail loudly like a dangling `$ref`), hot-reloaded
  (watch extended to overlay.json). `OntologyEvent` gains `order/phase/derived`; new
  `Ontology.linearOrder()` (overlay order → topological fallback).
- **`registry.ts` fully model-derived** — the hardcoded 28-entry `STEP_SEQUENCE` is GONE; `EVENTS`
  is built from `linearOrder()` + overlay phase/derived. `EventDef` relaxed to `string`/`number`.
- **`auth.ts` roles model-derived** — the 16-string `Role` union is GONE (`type Role = string`);
  runtime validates against `getOntology().roles`.
- **Conformance test model-relative** — no more magic 28/7/16; asserts internal consistency
  (linearOrder covers events, every role ∈ model.roles, EVENTS ≡ model events in linear order).
- **Prisma schema generator** `src/kernel/codegen/schema.ts` — emits a valid `schema.prisma` from
  `ontology.entities` (type map, required→nullable, version+timestamps, string FKs, EventLog infra
  table preserved verbatim with a generic `scopeId`). Output passes `prisma validate`.
- **Swap orchestrator** `src/kernel/codegen/swap.ts` + `npm run swap` — read-only `swapPreview()`
  diffs current tables vs the new model (dropped / created / kept), the CLI prints a prominent
  **IRREVERSIBLE drop warning** and is a safe DRY RUN unless `--yes`; `applySwap()` writes schema +
  a fresh overlay + regenerates skeletons for every BC. `GET /api/model/swap-preview` feeds the UI.
- **Generator stubs `.logic.ts`** for any command without one (throwing `apply`, `detect→false`,
  stub `DESCRIBE`) so a freshly-swapped domain compiles/boots; never overwrites real logic.
- **Dynamic command routes** — generated commands mount from the codegen registry
  (`registry.generated.ts` now carries handler + route); the 4 hand-listed SAP routes were removed.

Proven: tsc clean · **105/105 tests** · happy path 34 events · SAP routes mount dynamically and
serve over HTTP · swap dry-run on a **different domain** (healthcare Patient/Appointment) correctly
flags all 16 Ericsson tables as permanently-dropped + the 2 new as created, with roles/events/
linearOrder fully model-derived — then restored byte-clean.

**The deterministic "except" boundary** (what a swap does NOT auto-generate — the AI/hand bucket,
listed by the swap warning): `*.logic.ts` bodies, `src/{bc}/queries.ts`, `simulator/{runner,
stepper}.ts`, `events/derived.ts`, `events/bus.ts` `resolveDemandId` (still demand-specific), and
`web/app.js` panels. These are statically imported on the boot path, so completing a real swap to
a new domain still requires regenerating/removing them — that's the next increment (pack-loader +
generalized scope resolver + the queries/widget generators from Parts 4/5).

**Next:** generalize the boot path (pack-loader so deleting old BC files doesn't break boot) +
`bus.ts` scope resolver from the model, OR Increment 2 (model write-path).

### Increment 1d — STATUS: DONE (2026-06-14) — live model apply (drop/create tables on swap)

Goal: swapping the model rebuilds everything LIVE — drop/create projection tables in-process, no
`prisma generate`, no restart — with a loader. Insight (user's): projection tables are disposable,
so manage them with raw SQL decoupled from Prisma's typed client.

- **Raw-SQL projection store** `src/twin/projection-store.ts` — model-driven CREATE/DROP TABLE +
  generic row ops (find/insert/update with optimistic version) via `$executeRawUnsafe`/
  `$queryRawUnsafe`. `applyModelTables()` drops every projection table (keeps EventLog) and creates
  the current model's entity tables. In-process, synchronous, no restart.
- **`base.ts` → projection store** — the generic base command now persists via raw SQL (not typed
  prisma delegates), so a freshly-applied model's tables are usable immediately. `resolveBinding`
  is async + checks the raw table exists.
- **Live apply** `src/twin/apply.ts` + `POST /api/model/apply` + `GET /api/model/apply-status` —
  reloads ontology, writes a fresh overlay (clears stale keys), drops/recreates tables; a tiny
  status object backs the loader.
- **Generic command route** `POST /commands/:bc/:name` — dispatches ANY model command via the base
  command (role + required-field checks from the model), so a swapped model is runnable with ZERO
  codegen/restart. Static (generated/authored) routes take precedence.
- **Stale overlay made non-fatal** (model.ts) — a leftover overlay no longer blocks a swapped model
  from loading; `staleOverlayKeys` surfaced at `/sim/registry-status`.
- **Model-driven labels** — `ontology.title` / `rootAggregate` (+ overlay `title`/`rootAggregate`
  overrides) exposed via `/sim/meta`; the dashboard header/buttons/footer/tab-title follow the model.
- **Frontend loader** `web/app.js` — full-screen overlay while fetching + rebuilding; "⤓ Fetch
  model" now fetches+applies, new "⟳ Rebuild" applies the already-loaded model (for manual
  workflow.json swaps); polls apply-status for live phase text.
- **`/sim` simulator guard** — the Ericsson-wired stepper returns a clean 422 (not a 500) on a
  non-Ericsson model.

Proven on the live IAM (Identity & Access) model: apply dropped 16 Ericsson tables + created 6 IAM
tables in-process; `RegisterAccount` ran via the generic route (status seeded from exampleData,
event logged, wrong role → 403); page + loader + apply-status all work. Ericsson regression: tsc
clean, 105/105 tests, happy path 34 events.

### Increment 1e — STATUS: DONE (2026-06-14) — model-generic simulator (dashboard runs any model)

Goal: the dashboard's "+ New" / step-through / detail work for ANY loaded model, not just Ericsson.

- **Event scope override** `src/events/bus.ts` — `setScopeOverride`/`withScope(id, fn)`; `emit()` uses
  it (else `resolveDemandId`). The generic sim runs a whole "run" with the root-instance id pinned, so
  events group under it in EventLog (like Ericsson per-demand scoping) without the hardcoded FK-walk.
- **Generic simulator** `src/twin/sim.ts` — `genericNewInstance` (create the root aggregate via its
  create-command, scoped), `genericStep` (walk `linearOrder`, synthesize each command's args from
  exampleData + an **FK-by-name heuristic** `xxxId`→instance-of-`Xxx`, inject the run's id for
  update-shaped events, dispatch via the generic base command, soft-fail one step on error),
  `genericListInstances`, `genericInstanceDetail`, `genericCurrentStep`, `isEricssonModel()`.
- **`/sim` routes branched** — `/sim/demands` (GET+POST), `/sim/next`, `/sim/current-step`,
  `/sim/run-all`, `/sim/reset` use the generic sim when `!isEricssonModel()`; new `/sim/instance/:id`;
  `/sim/meta` carries an `ericsson` flag. Ericsson path unchanged.
- **Generic dashboard UI** `web/app.js` — when `meta.ericsson===false`: list columns derived from the
  root-aggregate rows; a generic detail view (root card + run event timeline + per-aggregate row
  tables) reusing the `btn-back/next/all/reset` ids so the existing bindings drive it.

Proven on the live IAM model: "+ New" created an Account; Run-all stepped all 8 events (Account
created→confirmed→logged-in, then User/Org/Project/TeamMember/Workflow created and **FK-linked** by
the heuristic); list + detail render generically. Ericsson regression: tsc, 105/105 tests, happy path
34 events.

**Fix (2026-06-15):** raw-SQL projection tables are namespaced with a `gen_` prefix
(`src/twin/projection-store.ts`) so they can NEVER collide with Prisma-managed tables. Before this,
`applyModelTables` dropped/recreated tables like `Demand`/`Project` as raw-SQL tables (TEXT
`createdAt`), corrupting Prisma's DateTime reads (P2023) and colliding when a generic model reused a
Prisma table name. Now `Demand` (Prisma) and `gen_Demand` (raw-SQL projection) are distinct; callers
pass the logical entity name and the store maps to `gen_<name>`. Also: the dashboard ✕ now uses a
dedicated `POST /sim/delete` + `genericDeleteInstance` which deletes the root row DIRECTLY by id (not
only via the event log), so items always delete even if their events are missing/mismatched.

**Limits (honest):** generic stepping synthesizes plausible data, not authored business linkage —
`status` never advances (base never guesses lifecycle), and FK linking is name-heuristic only. For
faithful behavior, author a command's `.logic.ts`. The whole IAM workflow now runs from the
dashboard; richer per-aggregate detail/forms are future polish.

### Increment 1c — STATUS: DONE (2026-06-14) — generic base command (no more throwing stubs)

Goal: a brand-new command with no authored `.logic.ts` should WORK (not throw) by falling back to a
deterministic base that uses the command's attributes + the entity's `exampleData`. Design hardened
by a 3-stance + adversarial-synthesis workflow (`generic-base-command-design`).

- **`src/commands/base.ts`** — `genericApply/genericDetect/genericDescribe(commandName, …)`, reading
  the LIVE ontology by command name on every call (hot-reload-correct). **Create-vs-update** is
  decided by hard evidence: a row for `args.id` → UPDATE; "command carries id" is the primary shape
  signal; the DAG-root test is only a tie-breaker (it mis-classifies updates like OrderMaterial whose
  sole predecessor belongs to another aggregate). **CREATE** builds a full row (args → columns,
  remaining required columns from `exampleData[0]` type-coerced, id generated if absent), **seeds
  `status` from `exampleData[0]`** (the canonical initial state; required everywhere → NOT-NULL would
  else fire); an unfillable required column → soft `DomainError` (422), never a raw NOT-NULL 500.
  **UPDATE** patches only the command's own non-id/non-status fields under an optimistic lock and
  **never advances `status`** (lifecycle transitions stay authored logic). Everything emits via the
  existing `emit()`, so log/fan-out/scope are identical to authored commands (unknown aggregate →
  `demandId` null, no crash).
- **Generator change** — `emit.ts` `logicStubContent` now writes a thin **delegating** stub
  (`return genericApply(COMMAND, ctx)`), not a throwing one. Authoring a real `.logic.ts` (importing
  nothing from base) cleanly overrides it; the generator never overwrites an existing logic file.

Proven by integration test (temporary `Clinic`/`Patient` domain, then restored byte-clean): a
brand-new `RegisterPatient` (no id, no status supplied) created a Patient with `status="REGISTERED"`
seeded from exampleData, auto-id, emitted `PatientRegistered`; `AssignWard` updated `ward` with a
version bump and **left status untouched**; detect flipped true; an update on a missing id raised
`NotFoundError` (no phantom create); exactly one row existed. 13/13 assertions. Full suite still
105/105, tsc clean, happy path OK.

**Net:** "drop in a new command, no AI" → it WORKS (create/update + emit) instead of throwing; the
AI/hand `.logic.ts` is now an *enhancement* (guards, transitions, cross-aggregate effects), not a
prerequisite for the command to function.

---

## Reality check vs the kernel+packs goal (2026-06-15) — read before Part 2

The §1 "Kernel + Packs" target is **NOT yet realized**. Current state:

- **No `src/packs/` directory exists.** Bounded contexts are still flat dirs at `src/` root
  (`helix/`, `prim/`, `sap/`, …) — the original layout. No `Pack` interface, no `loadPacks()`.
- **No pack has all its layers.** Per-pack `adapter/`, `widgets/`, `ingestion/`, `pack.manifest.json`
  do not exist anywhere. Only a global `.qlerify/codegen.commands.json`.
- **Only SAP Purchase Order uses the command seam** (`.gen.ts`+`.logic.ts` with `detect`/`DESCRIBE`,
  4 commands). The other 6 bounded contexts are **1,564 lines of hand-written domain logic** with no
  seam (Helix: 0 `apply`/`detect`/`DESCRIBE`).
- **Widgets:** only *global* runtime-interpreted rendering in `web/app.js` — no per-pack widget files.

### The architecture EVOLVED — what a "pack" is for changed
Increment 1c's **generic base command** means a model **runs with zero generated files** (validate →
upsert from example data → emit, straight from the model). So packs are no longer required to *run* a
system — they're the **optional authored layer**: faithful logic (`.logic.ts`), the adapter, and
custom widgets, used when the generic default isn't enough. SAP PO is the one pilot of that layer.

### What exists toward the goal
- ✅ Kernel codegen engine (`src/kernel/codegen/`): introspect → emit `.gen`/`.logic` + manifest.
- ✅ Generic runtime (`src/commands/base.ts` + `src/twin/`): runs any model generically.
- ✅ One command-seam pilot (SAP PO).
- ❌ `src/packs/{bc}/` organization, `Pack` interface, `loadPacks()`.
- ❌ adapter / widgets / ingestion layers (Parts 2/4/5).
- ❌ 6 of 7 BCs not converted to the seam.

### Next major iteration: Part 2 — Adapters = the first real pack
Building the adapter layer for ONE system end-to-end is what should **force `src/packs/{bc}/`, the
`Pack` interface, and `loadPacks()` into existence** — making Part 2 the first complete pack. Helix and
the others migrate into that structure incrementally afterward.
- **Prerequisite / first sub-step:** the code→model WRITE-PATH. `src/ontology/sync.ts` is PULL-ONLY
  today (MCP `get_workflow`); the adapter model-correction loop (firstName vs first-name) needs MCP
  `update_*` write tools with review-then-apply + conflict handling.
- **Canonical example:** the IAM/"Identity & Access" model maps to AWS Cognito user-creation (the
  original example): introspect Cognito → propose field mapping → generate adapter → test → correct
  the model. Adapter design detail is in §"Part 2 — Adapters" above (SourceAdapter interface
  introspect/mapping/pull/push/healthcheck; FDE AI loop in the chat-agent harness; `mode:
  simulated|recorded|live`).

### Related milestone (after Part 2/3): retire the Ericsson dual-track
The Ericsson domain is hand-coded (1,564 lines + `isEricssonModel()` branching in 11 places + the
28-step `stepper` + the typed Prisma schema + the 105 tests) — it's the **faithful reference app**, not
debt to rush. End-state: Ericsson becomes `workflow.json` + authored `.logic.ts` (the SAP-PO pattern,
extended), the generic engine runs it, and `isEricssonModel()` + the bespoke stepper disappear. Costs:
(a) needs authored `.logic.ts` to stay faithful (Part 3); (b) moving Ericsson off typed Prisma onto the
raw-SQL `gen_` store means rebuilding the relational read-models. A deliberate later increment.

---

## Part 2 (refined, 2026-06-15) — Adapters = the first real pack

Refines §3 Part 2 / Part 2a and the "Next major iteration" reality-check note, after a
design+adversarial workflow against the user's notes (wizard / catalog / connectors / credentials /
load-limits / simulated-vs-real). **Decisions this session (Staffan):**

- **(a) Ericsson stays the committed, tested baseline.** A CRM model had been swapped into the working
  tree (uncommitted) — `npm test` was red and `codegen.json` (still `Hardware Development Flow 2`,
  `cfb69e…`) pointed at a different workflow than the loaded one. Reverted to Ericsson: suite green,
  `codegen.json` identity consistent with the loaded model again.
- **(b) First real adapter = SAP → Purchase Orders (OData).** It reuses the one BC that already has the
  command seam (the SAP PO `.gen`/`.logic` pilot), so the first end-to-end adapter vertical stays
  *inside the green Ericsson model* with no test/codegen disruption. The canonical field-mismatch shifts
  from `firstName` to SAP naming (`PurchasingDocument`/`NetPriceAmount`/`Supplier` vs the model's
  `poNumber`/`price`/`vendor`). **AWS Cognito / "load users" (the original note-8 example) becomes a
  catalog recipe + a later target**, reachable once the test suite is made model-agnostic so an identity
  model can run live.
- **(c) Write-path is ALIAS-FIRST.** Adapters normalize source field names in their own `fieldMap` on
  pull (data flows, *no* model mutation); the code→model MCP push (`update_*` + review + conflict guard)
  is built **later as a one-click "rename in the model?" escalation**, not a Part 2 prerequisite. This
  reverses the earlier "build the write-path first" lock *for Part 2 only* — it is now safe to build
  whenever, because `codegen.json` matches the loaded model. The escalation is what keeps the
  *informs-the-model* differentiator; alias keeps ingestion unblocked.

Notes 1–4 are already shipped (verified): easy model update (`sync.ts fetchLatestModel` +
`model.ts reloadOntology/onOntologyReload`); clear old tables + create new (`projection-store.ts
applyModelTables` drops/recreates every `gen_<Entity>`); immediate simulation (`twin/sim.ts
genericNewInstance/genericStep`). Net-new effort is notes 5–10.

**INVARIANT — Part 2 is strictly ADDITIVE:** packs are *added*; no BC dir is deleted, no static boot
import (`routes.ts` Ericsson imports lines ~20–37) is removed, no command call-site is edited. So the
demo stays green throughout, and `loadPacks()` must use **dynamic `import()`** (never a static boot
import) to avoid the dangling-import trap. Ericsson retirement (§"retire the dual-track") is explicitly
OUT of Part 2.

### Sub-step sequencing (each keeps the demo green, independently testable)

**2.1 — Provenance substrate (FIRST; §4 #5).** Before any real pull, every fact carries provenance so
synthetic data can never read as real. `Provenance = { mode: 'simulated'|'recorded'|'live', adapter?,
at? }` (`src/twin/provenance.ts`). Adapter *mode* (config) is per-adapter/per-BC in `_app_meta`
(`adapterModes`, default `simulated` for any BC without an adapter); the *stamp* is **per-event**, so
"which **steps** are real vs simulated" (note 10) falls out for free even for a single-BC model.
Stamped at the single chokepoint `emit()`: `ev.provenance ?? provenanceFor(def.boundedContext)` —
back-fills the entire existing demo as `simulated` truthfully with **zero command-call-site edits**.
Storage = two additive columns, **no new tables, no RawEvent/BusinessEvent split (that stays Part 5)**:
`EventLog.provenance String?` (event-stream truth → timeline) + a `_provenance TEXT` platform column on
every `gen_` table (current-state truth → detail cards), added in `createTableSql` beside
`version`/`createdAt`/`updatedAt`. `/sim/meta` gains a `provenance` block (per-BC `{mode, adapter, at,
eventCount}` + `liveStepCount`/`totalSteps`). UI reuses the `PHASE_TONE`/`DERIVED` patterns:
`simulated` = diagonal-hatch tint + muted **SIM** chip (colorblind-safe); `recorded` = solid sky
**REC**; `live` = solid emerald **LIVE** — on timeline, detail cards, last-event caption, dashboard
rows, plus a legend + "X of N steps live" rollup. Switching a BC's mode never rewrites history.
*Det:* the stamp + columns + meta + UI. *AI:* none.

**2.2 — Pack skeleton + `SourceAdapter` + `SimulatedAdapter` + `loadPacks()`.** The increment that
forces `src/packs/{bc}/` + the `Pack` interface into existence. `SourceAdapter = { id, kind, mode } +
introspect / mapping / pull / push / healthcheck`; `pull()` returns rows **keyed by model entity**
(already field-mapped) so the generic base command (`commands/base.ts`) + `store.insert()` consume them
unchanged. `SimulatedAdapter` is the default impl and **reuses the simulator's own row synthesis**
(extract `synthesizeRow(entity, ont, seed)` from `sim.ts` — simulated-pull and sim stay one impl).
Sidecar `.qlerify/adapters/<id>.json` (`{ id, kind, boundedContext, targetEntity, phase, mode,
connectionOptionId, credentialsRef, fieldMap, limits, lastPullAt, fixturesDir }`); `credentialsRef` is a
KEY, never the secret. `loadPacks.ts` globs `src/packs/*/pack.manifest.json` and **dynamically
`import()`s** each pack, called fail-soft beside the existing generated-command side-effect import and
re-run on `onOntologyReload`. **Cut from the original plan:** *no per-adapter `.gen.ts`/`.logic.ts`
codegen in v1* — a registry-object `SimulatedAdapter` proves the `Pack` interface with a fraction of the
surface; the two-file codegen seam is reintroduced only when a real connector *body* (live SAP OData
calls) is authored. *Det:* interface, `applyFieldMap`, secret-resolution stub, `withScope` push
envelope, `loadPacks`. *AI:* field-map pairs (later, pull/push body).

**2.3 — Catalog (note 6) + wizard (notes 5,7,8).** Static `RECIPES` catalog
(`src/packs/_catalog/recipes.ts`, read-only, `reusableAsIs:false`): SAP-OData deep + thin REST + CSV
stubs. Each `SourceRecipe` carries `options[]` (choose-one connection methods) + `credentials[]` with
`whereToFind` text the agent narrates **verbatim**, plus sample fixtures (runs simulated with zero
creds) and a `remoteSchema` carrying the intentional naming mismatch that seeds the correction loop.
`copyCatalogEntry(kind,{bc,id})` forks a recipe into a live sidecar (`simulated`) + `src/packs/<bc>/`
and **immediately re-validates the inherited `fieldMap` against THIS model** (staleness check, like
`staleOverlayKeys`) — copy-then-diverge is the default. **Wizard runs IN the existing
confirmation-gated chat harness** — no new state machine; phase lives in the sidecar (`draft →
introspected → mapped → built → tested → populated`, read fresh per tool call → stateless-per-turn).
New model-generic tools on `TOOLS`: `adapter_list_recipes` / `adapter_introspect` (read) +
`adapter_map_fields` / `adapter_build` / `adapter_test` / `adapter_pull` (all `confirmed:true`-gated,
the `handleNextStep` pattern). System prompt gains an "Adapter Wizard Policy" block (hot-reloads via
`onOntologyReload`). Build + test already render as `tool_use` `<details>` blocks → **you see it built
and tested for free.** Thin in-app surface: a "Connect a system" button + a progress rail that seeds
the chat and mirrors `phase` from `/api/adapters/:id`. **One required change from the review:** the
single credential step gets a **real password input in the rail** — never a secret typed into a chat
turn.

**2.4 — "Test on the fly" = the mode ladder as oracle (Part 2a).** `adapter_test` needs no live system;
each rung is its own oracle: **simulated** — synthesize rows, assert every `required` field on
`targetEntity` is fillable + types coerce (zero creds); **recorded** — one real `healthcheck()` +
1-page `pull()` captured to `.qlerify/adapters/<id>/fixtures/`, diffed against the model shape (a
mismatch → an alias proposal, optionally the write-path escalation); **live** — only after recorded
passes. **Fold-in creative: the GWT acceptance criteria ARE the oracle** — replay the pull through the
generic base command and assert each fired event's `acceptanceCriteria` holds, rendering a green/red
checklist *derived from the model* (criteria already on every `OntologyEvent` + already in the system
prompt; `genericDetect` already yields happened/evidence). The ladder IS the wizard's forward progress;
`adapter_test` flips `mode` on success.

**2.5 — Coherent loading (note 9) — simulated coherence FIRST.** The review's correction: for Part 2
the coherence you actually *see* is **simulated-data** coherence, not live pagination — today `sim.ts`
builds every row from `exampleData[0]`, so synthesized rows are identical. v1 = **deterministic
seeded-RNG cross-FK coherence** (a synthesized PurchaseOrder links to a real synthesized Vendor/Project
via the `xxxId` FK convention + `relatedEntity` passthrough that `SchemaField` currently drops) + a flat
per-entity `limit`. The full breadth-first **load-plan executor** (root-anchored FK fan-out, per-source
`pageSize`/`limit`/`joinKey`, cursors/watermarks in `_app_meta`, resumable + idempotent) is real but
defers to the **live/recorded** pulls — it's a production data-pipeline, premature for synthesized rows.
When it lands, `applyModel` must also clear `adapter:*` meta keys so a model swap can't resume stale
cursors. *Det:* seeded synth, `relatedEntity` passthrough, the later executor. *AI:* none.

**Deferred — code→model write-path (the escalation; locked decision §4 #1, now Part 2-later).** Built
when we want the model to *learn*: `ModelCorrection` op-algebra → `proposeCorrections` (pure preview,
field-level before/after, exact MCP payload) → conflict guard (`409 STALE_MODEL` vs the live model hash)
→ batched `update_*` → re-`fetchSpecification()` (Qlerify owns the bytes; `workflow.json` stays a
verbatim round-trip) → `appendVersion(provenance: 'adapter-sync')` → `materialize()` + `reloadOntology`.
**Prerequisite the review flagged: `codegen.json` identity must track the LOADED model, not a pinned
constant** (it now matches because we're on Ericsson; revisit if/when an identity model is the live one).

### Creative ideas (note 11)

**Fold in:** GWT acceptance criteria as the adapter's test oracle (the model IS the spec; 2.4) ·
synthesized **storyline backfill** — a simulated adapter pours a believable *history* (backdated
`DRAFT→ORDERED→RECEIVED` across instances via `genericStep` + `clock.ts`) so a freshly-connected model
"breathes" before any credential; real pulls flip slices amber→green — **hard dependency: EventLog
idempotency / per-stream unique constraint (§4 #2) must land first, else re-running the backfill
double-fires the whole history** · field-mismatch → one-click model suggestion (the write-path
escalation).

**My additions:** provenance **on the process-DAG diagram** (live/sim/stale + last-pull freshness on
each step → the model diagram doubles as an ops dashboard) · **adapter-from-a-curl/screenshot** (paste a
`curl`/API-doc/screenshot → the agent drafts introspect + fieldMap + pull body via the vision/agent
harness; lowers the note-7 "new connector" barrier).

**Optional:** mode-ladder **reconciliation diff** ("47 simulated, 44 matched real on email, 3 differ" —
cheap because sim + live share the `gen_` shape).

**Park (features in their own right):** counterfactual model fork (branch model+data, what-if, diff,
merge) · crypto-shredding PII at `emit()` — *must* precede the first real-PII live pull regardless
(Increment 5).

### Open questions still to resolve (non-blocking)
- **Provenance granularity** — resolved: *mode* per-BC, *stamp* per-event (per-step legibility for free).
- **Correction default** — resolved: alias by default, rename as the one-click escalation (don't drift
  the canonical diagram to every source's naming).
- **EventLog idempotency** — guard (sidecar `lastPullAt` + id-keyed projection upsert) is enough for
  simulated/recorded; the §4 #2 unique constraint becomes a HARD dependency the moment storyline-backfill
  (high-volume replay) is built.
- **Credential storage** — env-var `CredentialResolver` (dev) for Part 2; a minimal encrypted
  `.qlerify/adapters/<id>.secret` (master key, mirroring the MCP-creds pattern) if live demo needs it;
  KeyVault proper stays Part 5.

### Part 2.3 (refined, 2026-06-15) — Per-BC adapter workbench + AI-codegen-and-run (catalog demoted)

User redirected 2.3 away from a catalog-first chat wizard: give **each bounded context a dedicated page**
(`#bc/<Name>`, index `#bcs`) to configure its adapter (endpoints/credentials), verify the connection,
get AI troubleshooting on a failing endpoint, see data-update history, test the adapter, **let AI WRITE
the adapter and run/test it live (user-friendly Lambda)**, see commands+queries in action, see raw
ingestion, and see raw data interpreted as events. Rationale (Staffan): with every attribute in the
model, AI writes bespoke integration code, so off-the-shelf recipes (the catalog) are demoted to optional
seed material. **Security stance (Staffan, locked):** the PoC runs behind an enterprise firewall,
single-tenant → accept **in-process execution of AI-generated code now**, with a credible path to higher
security later. Designed via a design+adversarial workflow that **empirically tested two runtime claims
under tsx**.

**Strictly additive:** new module + new routes + ONE guarded `loadPacks` branch + a new `web/app.js`
render branch. Ericsson `#` and `#demand/<id>` untouched; demo stays green.

**Build order (HARD gate):**
- **Slice 1 — page shell + simulated happy path (ZERO AI / credentials / dynamic import).** Proves
  routing/state/render additivity + the data sink end-to-end against the existing `sap-purchase-order`
  simulated adapter. De-risks the only thing likely to break the green demo, in isolation.
- **Slice 2 — the AI-codegen-and-run crux**, dropped into a host that already works.
- Post-crux polish (drift self-heal, golden-fixture diff, Connection Doctor, GWT contract probe,
  raw→events AI narration) stays parked until the crux loop works on one adapter.

**The page (Slice 1).** Facade `src/http/bc-routes.ts` (mounted by `registerRoutes`), all PROJECTIONS over
existing substrate (`ontologyView` filtered by BC, `listAdapters`, `provenanceMeta.byContext[bc]`, the
`gen_` store, `EventLog`, the command registry) — no new tables; one optional `endpoint?` on
`AdapterConfig`. `:bc` validated vs `getOntology().boundedContexts` (404 `UNKNOWN_BC`). Routes:
`GET /api/bc` (index), `GET /api/bc/:bc` (overview), `POST /api/bc/:bc/adapter/:id/verify` (healthcheck),
`POST .../test` (dry-run `pull()` + field-diff, NO insert), `GET .../raw` (gen_<Entity> rows w/
`_provenance`), `GET .../history`. `web/app.js`: `#bcs` + `#bc/<Name>` routing before the dashboard
fallback; `bcListView` + `bcWorkbenchView` (tabs Overview / Connection / Test / Raw / Commands+Queries /
Raw-as-Events); a header nav link. The existing `POST /api/adapters/:id/pull` is the "ingest for real"
sink. *Det:* all of Slice 1. *AI:* none.

**The crux — AI writes AND runs the adapter (Slice 2).** `.gen`/`.logic` discipline. HOST (hand-written)
`createAuthoredAdapter(cfg)` in `src/packs/adapters/authored.ts` implements the full `SourceAdapter`; BODY
(AI-authored) ONE file exporting `async fetchRows(ctx: AdapterRunContext)`. The body sees ONLY a
capability-restricted `ctx` (`ctx.fetch` = native fetch wrapped with ~8s AbortController timeout + size
cap + secret redaction + trace; `ctx.secret` resolved at run via `envCredentialResolver`; `ctx.entity`;
`ctx.limit`) — never `process.env`/raw fetch/`prisma`/`fs`. Returned rows wrap into
`RowsByEntity[targetEntity]` → existing `ingestPull` consumes unchanged. AI authoring reuses `ai.ts` as
`src/packs/codegen/adapter-ai.ts`.

Execution model = **in-process dynamic import** (the proven `loadPacks` seam), with two NON-NEGOTIABLE
fixes the adversarial pass verified under tsx:
- **FIX 1 (cache-bust): the `?v=<mtimeMs>` query trick DOES NOT WORK under tsx** — tsx keys its transpile
  cache by file PATH and ignores the query, so a regenerate would silently run STALE code. So: write each
  regeneration to a **UNIQUE FILE PATH** (`<id>.<contentHash>.logic.ts`) and import that; track the
  "current body path" in the sidecar. Bonus: regenerate is idempotent (same hash → skip) + audit trail.
- **FIX 2 (enforcement, not just prompt): a ~15-line static DENY-SCAN** of the generated body before its
  first import (reject `child_process`/`node:fs`/`process.env`/`eval`/disallowed imports), AND **register
  authored adapters LAZILY** (import the body inside `pull()`/`healthcheck()`, NEVER at `loadPacks` boot)
  so a bad/hostile/syntactically-broken body can never reach the boot path or the green demo — only its own
  panel errors. Plus: code shown in the viewer + explicit human click before first run; regenerate is
  confirmation-gated (the 3-layer invariant); test-live = a non-persisting `pull({limit:1})` graded
  against the model's required-fields/types BEFORE any real `ingestPull`.

**Path to higher security (honest).** The capability-ctx + deny-scan + lazy-register + confirmation-gate is
the minimum-viable LOCAL-dev posture (accepted for the firewalled PoC). Hosted/shared needs real isolation:
a per-adapter `worker_threads` (or subprocess) runner with no inherited env, an egress allow-list, the
secret passed over the channel. NOTE (verified): this is **NOT a zero-change flag-flip** — a worker can't
load `.ts` without its own tsx bootstrap; the adapter CONTRACT (`ctx`/`fetchRows`) is unchanged but the
runner is real work. Credentials: env-only now (the secret POSTed once to set `process.env[credentialsRef]`,
only the KEY stored in the sidecar); encrypted `.qlerify/adapters/<id>.secret` behind `envCredentialResolver`
is the next increment (zero call-site change).

**Raw + raw-as-events (viewer; real Part 5 split deferred).** Raw panel = `gen_<Entity>` rows. Raw-as-events
= each row through the codegen `detect()` predicate (read-only, emits nothing), with a model required-field
heuristic fallback (clearly labeled) for non-codegen BCs.
