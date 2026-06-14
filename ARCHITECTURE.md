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
