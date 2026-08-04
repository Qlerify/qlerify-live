# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Qlerify Live is a **model-driven runtime**: it takes a Qlerify event-storming/DDD model (an event DAG with commands, aggregates, entities, roles, and Given/When/Then acceptance criteria) and runs it as a live, multi-tenant app — routes, validation, role checks, projection tables, a digital twin, and a UI — with **no per-system build step**. Editing the model hot-reloads behaviour *in-process*; it is live *reconfiguration*, not live *reload*.

Read `ARCHITECTURE.md` for the canonical design narrative and `MULTI-TENANT.md` for the tenancy/authz design. `README.md` is unusually complete and kept current — consult it before asking the user about setup, config, or endpoints.

## Commands

```bash
npm run dev          # tsx watch src/server.ts — the dev server (runs setup first if needed)
npm test             # vitest run — full suite
npx vitest run tests/twin/derive.test.ts          # a single test file
npx vitest run -t "derives create event"          # tests matching a name
npm run test:watch   # vitest watch mode
npm run setup        # idempotent first-run: writes .env, PLATFORM_ENCRYPTION_KEY, prisma generate + db push
npm run db:push      # apply schema.prisma (NO migrations — see below)
npm run db:reset     # delete prisma/dev.db and recreate schema
npm run codegen      # regenerate deterministic .gen.ts scaffolds from the model
npm run codegen:ai   # (re-)author the .logic.ts regions with AI
npm run swap         # swap to a new model (previews projection-table drop/create)
```

Server listens on `http://localhost:3001`. First `npm run dev` auto-runs setup; no `.env` editing needed. There are **zero organizations** on a fresh install — sign in as the seeded superuser (password in `.qlerify/superadmin.local.txt`), create an org → workspace → workflow (a workflow must be created with a model).

## Critical conventions (these will trip you up)

- **The app runs under `tsx` directly from `src/` in every environment — there is no compiled `dist/` in production.** `npm run build`/`npm start` exist but are *not* the deploy path; the kernel, pack loader, and codegen resolve paths relative to `src/` and dynamically import `.ts` files. Don't "fix" the code to depend on a build step.
- **ESM imports use `.js` specifiers that point at `.ts` files** (`moduleResolution: "Bundler"`). Write `import { x } from "./foo.js"` even though the file is `foo.ts`. Match the surrounding style.
- **Schema changes use `prisma db push`, never `prisma migrate`.** There is no migrations directory. Prisma manages only the control plane + `EventLog`; domain tables are created at runtime as raw-SQL `gen_<Entity>` tables. **Never run `db push` against a populated DB** — it drops the runtime `gen_` tables. Additive control-plane columns are applied at boot by idempotent `ALTER`s in `src/platform/db/schema-upgrade.ts` (`ensureSchemaUpgrades`) — add new columns there, not via a migration.
- **The `gen_` table prefix is a hard safety boundary.** A model swap creates/drops only `gen_`-prefixed tables, so it can never touch a Prisma-managed table. Never name a Prisma table `gen_*`.
- **Throw the typed errors in `src/errors.ts`** (`DomainError`→422, `AuthError`→403, `UnauthenticatedError`→401, `NotFoundError`→404, `NoActiveWorkflowError`/`ModelNotLoadedError`→409, `LlmError`→502) rather than hand-rolling status codes. `src/server.ts`'s error handler maps them; the frontend branches on the `code`. Anything else bubbles to 500.
- **Never surface a raw AI-provider error to the user** — wrap it as `LlmError` (see `friendlyLlmError` in `src/llm/anthropic.ts`); the raw provider response is logged server-side only.

## Architecture

Two-tier: **Kernel** (deterministic platform, written once, model-generic) + **Packs** (optional authored layer, one per bounded context / source system).

- **Kernel** — `src/ontology/` (live model loader `model.ts` + code↔model `sync.ts`), `src/events/` (in-process bus + `EventLog` write chokepoint), `src/kernel/codegen/` (model→code), `src/commands/` (generic model-driven command runtime `base.ts` + registry), `src/twin/` (the digital twin). A generic engine runs **any** model with zero generated files.
- **Packs** — `src/packs/<bc>/`, discovered and mounted by `loadPacks()` at boot and on every model reload via **fail-soft dynamic import** (a broken pack can never crash boot). A pack bundles a `SourceAdapter` behind the stable interface in `src/packs/types.ts`.

**The codegen seam** (`src/kernel/codegen/`): every generator emits two files —
- `{x}.gen.ts` — deterministic scaffold derived purely from the model, **always overwritten**.
- `{x}.logic.ts` — AI-/hand-authored region (`apply()` + `detect()` + `DESCRIBE`), **preserved** across regeneration.

A regen manifest of content hashes decides what to regenerate; `.gen.ts` is always re-emitted, the AI is re-invoked only when the model's Given/When/Then actually drifted. Drift is surfaced, never auto-applied. This deliberately avoids AST tooling to keep clean git diffs in a no-build repo.

**The digital twin** (`src/twin/`) makes any loaded model immediately runnable. Two stores: the append-only `EventLog` (Prisma table, source of truth, one immutable row per domain event) and disposable `gen_<Entity>` projection tables (raw SQL, rebuilt in-process on model apply). It can `sim` (simulate a workflow), `derive` (read ingested adapter rows and infer which domain events they imply), and `correlate` (join aggregates into an end-to-end run). Every fact is stamped with **provenance** (`simulated`/`recorded`/`live`) and **actor** (`human`/`ai`/`system`/`adapter`) at the single `emit()` chokepoint (`src/twin/provenance.ts`).

**Two HTTP planes, both deny-by-default:**
- **Control plane** — `src/platform/http/control-routes.ts`, `/v1/*`: auth, tenancy, RBAC, audit, model versioning, per-org BYOK.
- **Data plane** — `src/http/*`: model-driven commands, ontology, simulator/twin, adapters/connectors, chat. Fully model-generic — swapping the model swaps the command set, roles, and bounded contexts with no route edits.

Only `/v1/auth/*`, `/vendor/monaco/*`, and the static web shell are public. `registerTenantPlugin` (`src/platform/http/tenant-plugin.ts`) binds tenant context to every request.

**Multi-tenancy** (`src/platform/`): hierarchy Customer Account → Organization → Environment → Workspace → **Workflow** (the per-tenant runtime unit owning a model + data plane). **`organization_id` is always derived from the authenticated identity's membership and bound per-request via `AsyncLocalStorage` — clients can never select their tenant.** Authorization is an embedded Policy Decision Point (`src/platform/pdp/`): tenant-boundary check → mandatory-access marking gate → discretionary role inheritance. The domain `x-role` header is only *recorded* on events; it is **not** the security boundary. Audit (`src/platform/audit/`) is an append-only SHA-256 hash-chained log (`GET /v1/audit/verify` recomputes it).

**LLM integration** (`src/llm/anthropic.ts`): all LLM SDK construction lives behind this one seam — every AI feature resolves its client here, nothing downstream branches. Two axes: **provider** (first-party Anthropic API vs AWS Bedrock, identical `messages.create` surface) and **who decides** via `LLM_SETTINGS_LOCKED` (centrally-managed/locked vs per-org BYOK with `.env` fallback vs per-org-only). Per-org secrets are AES-256-GCM encrypted at rest (`src/platform/secrets/`). Default model `claude-sonnet-4-6` (`CHAT_MODEL`/`CHAT_EFFORT` override). When touching anything Claude/Anthropic/model-related, read the `claude-api` skill first — do not answer model/pricing questions from memory.

**Connectors** — the mode ladder behind one `SourceAdapter`: **simulated** (zero-credential synthetic rows) → **AI-authored HTTP body** (in-process, capability-restricted + static deny-scan + SSRF net-guard, `src/packs/net-guard.ts`) → **full-power connector** (plain ESM `.mjs`, any npm package, run in a sandboxed child Node process, `src/packs/sidecar.ts`). AI writes and self-heals connector code from a natural-language source description, using the GWT criteria as the test oracle. Gated by the `connector.build` capability and the `QLERIFY_CONNECTORS_ENABLED` kill-switch. `credentialsRef` in an `AdapterConfig` is a **key** (env var / vault handle), never the secret itself.

**Frontend** — a **React + TypeScript SPA in `frontend/`**, built with Vite into `frontend/dist` (Tailwind v3, self-hosted — no CDN). **This is the one part of the repo with a build step**: `npm run build:web`, wired into `predev`/`prestart` so it can't be skipped. The server refuses to boot if `frontend/dist/index.html` is missing rather than silently serving something else. `QLERIFY_WEB_UI=legacy` serves the pre-migration vanilla-JS app still in `web/`, kept as a reference and an escape hatch. Hash-based routing (with the Overview tabs carrying their query state after a `?`); every request carries a bearer token plus `X-Org-Id` / `X-Workflow-Id`. A strict CSP (`src/server.ts`) forbids inline scripts — `script-src 'self'` for React, relaxed only on the legacy path; Monaco is self-hosted same-origin under `/vendor/monaco/`.

## Testing

Vitest 4, ~166 cases across 24 files in `tests/{chat,org,packs,platform,twin,llm,supply-chain}`. The suite **runs serially in a single reused fork** (the runtime is stateful — `maxWorkers: 1`, `fileParallelism: false`) with a 15s per-test timeout. `tests/helpers/global-setup.ts` applies additive schema upgrades once **without** dropping the `gen_` tables, so all tests share the one `DATABASE_URL` SQLite file. Write new tests to be order-independent within that shared DB.

## Dependency install-script allowlist

`package.json` has an `allowScripts` field pinning the exact versions of the six packages permitted to run install scripts (prisma ×3, esbuild ×2, fsevents). `tests/supply-chain/allow-scripts.test.ts` fails if the allowlist drifts from `package-lock.json`. **After bumping any of those deps, re-approve the new version** (`npm approve-scripts` on npm ≥ 11.16, or edit the pins by hand) or the test breaks.
