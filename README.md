# Qlerify Live

> **Feed it a Qlerify domain model — get a live, multi-tenant application whose behaviour is continuously re-derived from the model.**

Qlerify Live is a **model-driven runtime**. You give it a [Qlerify](https://qlerify.com) event-storming / DDD model (a domain-event DAG with commands, aggregates, entities, value objects, read models, roles, and Given/When/Then acceptance criteria) and it turns that model into a running app — routes, validation, role checks, database tables, a digital twin, and a UI — **with no per-system build step**.

The thesis: a **process-native** alternative to Palantir. Palantir is *data-native*; Qlerify Live makes the **business process — the event DAG — the source of truth**.

> ⚠️ **Status:** early-stage / proof-of-concept (v0.1.0, `private`). The platform is real and load-bearing (multi-tenancy, auth, PDP, audit, event sourcing), but several subsystems carry documented caveats — see [Security & known caveats](#security--known-caveats) before any production use.

---

## Table of contents

- [The core idea](#the-core-idea)
- [How it works](#how-it-works)
- [Architecture at a glance](#architecture-at-a-glance)
- [Tech stack](#tech-stack)
- [Project layout](#project-layout)
- [Getting started](#getting-started)
- [Configuration](#configuration)
- [npm scripts](#npm-scripts)
- [Testing](#testing)
- [Deployment](#deployment)
- [HTTP API overview](#http-api-overview)
- [The web UI](#the-web-ui)
- [Security & known caveats](#security--known-caveats)
- [Further reading](#further-reading)

---

## The core idea

The headline distinction is **live *reconfiguration*, not live *reload***.

The model is not a one-time codegen input and not a passive data object a few views read. It is treated as **live configuration that the running system continuously re-derives its behaviour from**. Edit the model, hot-reload, and routes, validation, roles, projection tables, and UI widgets all re-materialise **in-process** — no restart, no `prisma generate`.

A generic engine can run **any** model with **zero generated files**: it validates input, upserts rows from each entity's example data, and emits events straight from the model. So a freshly-swapped domain compiles, boots, and runs immediately. Generated and hand-/AI-authored code is then layered on top per bounded context for richer behaviour.

---

## How it works

### 1. Kernel + Packs

A two-tier design:

- **Kernel** (`src/kernel/`, `src/twin/`, `src/events/`, `src/commands/`, `src/ontology/`) — a deterministic platform written **once**, never per-system: ontology loader + hot-reload, event bus + log, codegen engine, the generic model runtime, and the digital twin.
- **Packs** (`src/packs/<bc>/`) — the **optional** authored layer, one per bounded context / source system. A pack bundles a source adapter, command logic, widgets, and ingestion behind a stable `Pack` interface that the kernel discovers and mounts via `loadPacks()` at boot (and on every model reload). Packs are loaded by dynamic import and fail-soft, so a broken pack can never crash boot.

### 2. The codegen split (`.gen.ts` + `.logic.ts`)

Every generator emits into one seam:

- **`{x}.gen.ts`** — a deterministic scaffold, derived purely from the model, **always overwritten**.
- **`{x}.logic.ts`** — an AI- or hand-authored region (`apply()` + `detect()` + `DESCRIBE`), **preserved** across regeneration.

A **regen manifest** of content hashes (`gwtHash` / `schemaHash` / `aiPromptHash`) decides what to regenerate: `.gen.ts` is always re-emitted; the AI is only re-invoked when the model's Given/When/Then actually drifted, so hand-edits survive. **Drift is surfaced, never auto-applied.** This deliberately avoids AST tooling and keeps clean git diffs in a no-build repo.

### 3. Event sourcing reconstructed from data (the "digital twin")

`src/twin/` makes any loaded model immediately runnable. Its spine is two stores:

- **`EventLog`** — an append-only, Prisma-managed table; one immutable row per emitted domain event. This is the source of truth.
- **`gen_<Entity>` projection tables** — disposable, raw-SQL read-models holding current aggregate state, created and dropped **in-process** when a model is applied. (The `gen_` prefix is a hard safety boundary so a model swap can never touch a Prisma-managed table; non-system workflows get per-workflow-namespaced tables.)

From the model alone the twin can:

- **Simulate** a workflow end-to-end, stepping through events and synthesising command args.
- **Simulate from data** — read ingested adapter rows and *derive* which domain events they imply, via model-driven evidence rules (row created? status advanced? new fields set?), then emit them.
- **Correlate cases** across multiple aggregates into a single end-to-end run by following model-declared foreign keys.
- Project **portfolio and systems-health dashboards**.

Every fact carries **provenance** (`simulated` / `recorded` / `live`) and **actor attribution** (`human` / `ai` / `system` / `adapter`), stamped at one `emit()` chokepoint. A model-signature marker drives automatic clean-slate rebuilds when the model genuinely changes.

### 4. Connectors — the mode ladder (simulated → recorded → live)

`src/packs/` lets a workflow pull real data from external systems (SAP, DynamoDB, Postgres, REST, Cognito, Sheets, …) into `gen_<Entity>` tables, where it is turned into domain events. There are three adapter rungs behind one `SourceAdapter` interface:

1. **Simulated** — synthesises model-native rows with **zero credentials**, so a fresh model runs end-to-end immediately.
2. **AI-authored body** — an HTTP-only integration written by Claude, run in-process behind a capability-restricted context + a static deny-scan + an SSRF net-guard.
3. **Full-power connector** — a plain ESM `.mjs` module that may import any npm package and speak any protocol, executed in a **sandboxed child Node process** (out-of-repo workspace, Node permission model, SSRF-guarded `fetch`, optional bubblewrap jail).

AI writes the integration code from a natural-language description of the source, **tests it on the fly**, and **self-heals**: a failed dry-run's error + redacted trace is fed back so the AI rewrites the code until it works. Operators can hand-edit any connector in an in-browser **Monaco** editor. The Given/When/Then acceptance criteria act as the test oracle.

### 5. Multi-tenant control plane

`src/platform/` is the tenancy / identity / authorization / audit spine:

- **Hierarchy:** Customer Account → Organization → Environment (dev/prod) → Workspace → **Workflow** (the per-tenant runtime unit that owns a model + its data plane).
- **Tenant isolation:** `organization_id` is **always derived from the authenticated identity's membership** and bound per-request via `AsyncLocalStorage` — clients can never select their tenant. Isolation is app-enforced through a single fail-closed scoped-store seam (Postgres + RLS is a planned drop-in).
- **Authorization:** an embedded **Policy Decision Point** evaluates, in order, a tenant-boundary check → a mandatory-access-control marking gate → discretionary role/permission inheritance down the containment tree. (The domain `x-role` header is *only* recorded on events; it is **not** the security boundary.)
- **Audit:** an append-only, per-org, SHA-256 hash-chained log; `GET /v1/audit/verify` recomputes the chain.
- **Auth:** scrypt passwords, opaque bearer session tokens, login rate-limiting, admin-issued one-time passwords, and a superuser break-glass mode (audited to the target org).
- **Per-org BYOK:** each org can supply its own Anthropic and Qlerify keys, validated on save and stored **AES-256-GCM encrypted** at rest.

### 6. AI / Claude integration

All Anthropic SDK construction lives behind one seam, `src/llm/anthropic.ts`. Every AI feature resolves its client there, so a per-org key transparently overrides the platform-default `ANTHROPIC_API_KEY`. The default model is **`claude-sonnet-4-6`** (override with `CHAT_MODEL`; effort via `CHAT_EFFORT`, default `medium`); the UI also offers `claude-opus-4-8`, `claude-haiku-4-5`, and `claude-fable-5`. AI powers the chat assistant (process advisor, connector builder, event-log viewer), connector codegen + repair, and the codegen kernel.

---

## Architecture at a glance

```
                         Qlerify domain model (event DAG, GWT, roles…)
                                        │  live config, hot-reloaded
                                        ▼
  ┌──────────────────────────── KERNEL (runs ANY model generically) ────────────────────────────┐
  │  ontology loader · event bus + EventLog · codegen engine · generic command runtime · twin    │
  └──────────────────────────────────────────────────────────────────────────────────────────────┘
        │                         │                          │                          │
        ▼                         ▼                          ▼                          ▼
   PACKS (per BC)        gen_<Entity> tables          EventLog (immutable)        Platform control plane
   adapter/commands/      raw-SQL projections          append-only, event-         orgs · identity · PDP ·
   widgets/ingestion      (rebuilt in-process)         sourced source of truth     audit · BYOK secrets
        │
        ▼
   Source systems  ──(simulated → recorded → live)──▶  ingest → derive domain events → digital twin
```

- **Control plane** (`src/platform/http/control-routes.ts`, `/v1/*`) — auth, tenancy, RBAC, audit, model versioning.
- **Data plane** (`src/http/*`) — model-driven commands, ontology, simulator, adapters/connectors, chat. Fully model-generic: swapping the model swaps the command set, roles, and bounded contexts with **no route edits**.

---

## Tech stack

| Layer        | Choice |
|--------------|--------|
| Language     | TypeScript (ES2022, ESM), run under **tsx** (no compiled `dist/` in production) |
| Runtime      | Node.js **22** (OpenSSL required by Prisma) |
| HTTP         | **Fastify 5** (`@fastify/cors`, `@fastify/static`) |
| Persistence  | **Prisma 5 + SQLite** for the control plane + `EventLog`; **raw SQL** `gen_` tables for model-derived projections |
| AI           | **`@anthropic-ai/sdk`** (Claude) |
| Editor       | self-hosted **Monaco** (served same-origin under a strict CSP) |
| Frontend     | dependency-free **vanilla JS** SPA + Tailwind (Play CDN) — no framework, no bundler |
| Tests        | **Vitest 4** |

---

## Project layout

```
qlerify-live/
├── src/
│   ├── server.ts            # Fastify entrypoint + boot sequence
│   ├── kernel/codegen/      # model → code: generate / ai / swap / introspect / emit / schema / status
│   ├── ontology/            # live model loader (model.ts) + code↔model sync (sync.ts)
│   ├── commands/            # generic model-driven command runtime (base.ts) + registry
│   ├── events/              # in-process event bus + EventLog write chokepoint (bus.ts)
│   ├── twin/                # digital twin: projection-store, sim, derive, correlate, apply, provenance…
│   ├── packs/               # source-system adapters/connectors (Kernel+Packs layer) + AI codegen + sandbox
│   ├── platform/            # multi-tenant control plane: tenancy, authn, pdp, audit, secrets, provisioning
│   ├── llm/                 # Anthropic + Qlerify client seams (per-org BYOK)
│   ├── chat/                # AI assistant agent, tools, system prompt
│   ├── http/                # data-plane routes (commands, sim, bc, adapter, connector, org)
│   └── config/              # feature flags / kill-switches
├── web/                     # the entire frontend: index.html + app.js (vanilla SPA)
├── prisma/                  # schema.prisma (control plane + EventLog only) + dev.db
├── tests/                   # Vitest suite: chat / org / packs / platform / twin + helpers
├── ARCHITECTURE.md          # the canonical design narrative
├── MULTI-TENANT.md          # tenancy/identity/authz design + honest status
├── specification.md         # original product brief
├── Dockerfile · docker-entrypoint.sh · fly.toml   # deployment
└── package.json
```

---

## Getting started

### Prerequisites

- **Node.js 22** and npm
- **OpenSSL** (required by Prisma's query engine)
- An **Anthropic API key** ([console.anthropic.com](https://console.anthropic.com)) for AI features

### Install & run (local dev)

```bash
# 1. install dependencies (keep devDeps — tsx + the Prisma CLI run at runtime)
npm ci

# 2. create your env file and fill it in
cp .env.example .env
#    → set DATABASE_URL to an ABSOLUTE path (see the gotcha below)
#    → set ANTHROPIC_API_KEY

# 3. generate the Prisma client and create the SQLite schema
npx prisma generate
npm run db:push

# 4. start the dev server (tsx watch)
npm run dev
```

The server listens on **http://localhost:3001** by default (`PORT` / `HOST` to override).

> In local dev, leave `NODE_ENV` unset to use the forgeable dev auth shim. The first run seeds a **superuser**; if you don't set `SUPERADMIN_PASSWORD`, a random one is generated and written once to `.qlerify/superadmin.local.txt` (gitignored). A fresh install has **zero organizations** — sign in as the superuser, create the first org, then a workspace, then a workflow (which must be created with a model).

> ⚠️ **`DATABASE_URL` must be an absolute path** (`file:/abs/path/to/qlerify-live/prisma/dev.db`). A relative `file:./dev.db` resolves differently for the Prisma CLI vs. the generated client at runtime, silently splitting reads and writes across two different `.db` files.

---

## Configuration

All configuration is via environment variables (see `.env.example`):

| Variable | Required | Purpose |
|----------|----------|---------|
| `DATABASE_URL` | ✅ | SQLite path — **must be absolute** (see gotcha above) |
| `ANTHROPIC_API_KEY` | ✅ for AI | Platform-default Claude key; per-org keys override it in Org Admin |
| `PLATFORM_ENCRYPTION_KEY` | optional | 32-byte hex (`openssl rand -hex 32`) to encrypt per-org BYOK secrets at rest. Without it, orgs fall back to the platform keys. **Rotating it invalidates stored per-org keys.** |
| `QLERIFY_MCP_URL`, `QLERIFY_MCP_API_KEY` | optional | Platform-default Qlerify MCP creds for "Reload from link". In dev they fall back to `~/.claude.json`. |
| `CHAT_MODEL` | optional | Override the default Claude model (`claude-sonnet-4-6`) |
| `CHAT_EFFORT` | optional | Reasoning effort: `low` / `medium` (default) / `high` |
| `NODE_ENV` | prod | `production` **disables the forgeable dev auth shim** — required for real auth |
| `PORT`, `HOST` | optional | Defaults `3001` / `0.0.0.0` |
| `QLERIFY_CONNECTORS_ENABLED` | optional | Global kill-switch for all connector / AI-codegen / ingest |
| `QLERIFY_DATA_DIR`, `QLERIFY_CONNECTOR_JAIL` | optional | Connector sandbox workspace; `bwrap` enables the bubblewrap OS jail on Linux |

---

## npm scripts

| Script | What it does |
|--------|--------------|
| `npm run dev` | `tsx watch src/server.ts` — dev server with hot reload |
| `npm run build` | `tsc` → `dist/` (exists, but **not** the deploy path) |
| `npm start` | `node dist/server.js` (compiled path; not used in deploy) |
| `npm test` | `vitest run` — one-shot test suite |
| `npm run test:watch` | `vitest` watch mode |
| `npm run db:push` | `prisma db push` — apply schema (no migrations) |
| `npm run db:reset` | delete `prisma/dev.db` and recreate the schema |
| `npm run db:studio` | open Prisma Studio |
| `npm run codegen` | regenerate the deterministic `.gen.ts` scaffolds from the model |
| `npm run codegen:ai` | (re-)author the `.logic.ts` regions with AI |
| `npm run swap` | swap to a new model (with drop/create projection-table preview) |

> **Schema changes use `prisma db push`, never `prisma migrate`** — there is no migrations directory. Domain tables are created at runtime as `gen_` tables. Avoid running `db push` against a populated DB (it drops the runtime `gen_` tables); additive control-plane columns are applied at boot via idempotent `ALTER`s.

---

## Testing

```bash
npm test
```

The suite is **Vitest 4**, ~131 test cases across `tests/{chat,org,packs,platform,twin}`. It runs **serially in a single reused fork** (the runtime is stateful) with a 15s per-test timeout. A `globalSetup` applies additive schema upgrades once **without** dropping the `gen_` projection tables, so tests share the `DATABASE_URL` SQLite file safely.

---

## Deployment

The app runs **under `tsx` directly from `src/`** in all environments — there is intentionally no compiled `dist/` in production (the ontology kernel, pack loader, and codegen resolve paths relative to `src/` and dynamically import `.ts` files).

### Docker

```bash
docker build -t qlerify-live .

docker run -p 3001:3001 \
  -v qlerify-data:/data \
  -e DATABASE_URL=file:/data/dev.db \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  qlerify-live
```

`node:22-slim` base, installs OpenSSL + all deps (devDeps included — `tsx` and the Prisma CLI run at runtime), generates the Prisma client, and bakes in `NODE_ENV=production` (the security boundary that disables the dev auth shim). The entrypoint places the SQLite DB and `.qlerify` model cache on `/data`, applies the schema when its hash changes, then starts the server.

### Fly.io

```bash
# one-time: create the persistent volume
fly volumes create data --size 1 --region arn

# deploy (single machine only!)
fly deploy --ha=false
```

Single always-warm machine + one persistent volume holding the SQLite DB and runtime model cache. **Do not scale beyond one machine** — each machine gets its own volume, which would split state. The Fly health check hits `GET /` (the one auth-exempt static route that returns 200; `/sim/health` would 401 under the deny-by-default tenant plugin).

---

## HTTP API overview

The surface splits cleanly into two planes. Every route is **deny-by-default**; only `/v1/auth/*`, `/vendor/monaco/*`, and the static web shell are public. `organization_id` is always derived from identity, never from client input.

### Control plane — `/v1/*` (`src/platform/http/control-routes.ts`)

| Area | Endpoints (selected) |
|------|----------------------|
| Auth & identity | `POST /v1/auth/login`, `POST /v1/auth/logout`, `GET /v1/whoami`, `POST /v1/account/password` |
| Orgs & BYOK | `GET/POST /v1/organizations`, `PATCH/DELETE /v1/organizations/:id`, `GET/PUT /v1/organizations/:id/anthropic-config`, `…/qlerify-config` |
| Tenancy | `POST /v1/environments`, `POST /v1/workspaces`, `POST/DELETE /v1/workflows[/:id]` |
| RBAC & members | `POST /v1/memberships`, `POST /v1/members/:id/reset-password`, `POST /v1/role-assignments`, `POST /v1/markings` |
| Audit | `GET /v1/audit`, `GET /v1/audit/verify` |
| Model versioning | `PUT /v1/workflow/model`, `GET /v1/workflow/model/status`, `…/content`, `POST …/restore`, `…/reload` |

### Data plane (`src/http/*`)

| Area | Endpoints (selected) |
|------|----------------------|
| Commands | `POST /commands/:bc/:name` (generic dispatch), `GET /api/commands[/status]`, `GET /commands/:bc/:name/describe`, `POST …/detect` |
| Ontology | `GET /api/ontology` |
| Simulator / twin | `GET/POST /sim/cases`, `POST /sim/next`, `/sim/run-all`, `/sim/reset`, `/sim/delete`, `POST /sim/derive`, `/sim/rebuild`, `GET /sim/meta`, `/sim/event-log`, `/sim/flow-aggregate`, `/sim/flow-by-case` |
| Bounded contexts | `GET /api/bc[/:bc]`, `/api/bc/health`, `/api/bc/:bc/raw`, `/row-events`, `POST /api/bc/:bc/clear` |
| Adapters/connectors | `GET /api/adapters[/:id]`, `POST /api/adapters/:id/pull`, `GET/POST /api/connectors[/:id/code]`, `POST /api/connectors/:id/repoint`, `/date-roles`, `/delete`, `POST /api/data/reimport-all` |
| Org dashboard | `GET /org/portfolio`, `GET/PUT /org/mappings` |
| AI assistant | `GET /chat/info`, `POST /chat` |

---

## The web UI

The entire frontend is **two static files** — `web/index.html` (a ~50-line shell) and `web/app.js` (a single vanilla-JS ES module) — with **zero build step**. Tailwind comes from the Play CDN; the backend serves both files directly. Routing is hash-based, and every request carries a bearer token plus `X-Org-Id` / `X-Workflow-Id` headers, so the app is a multi-tenant console.

The mental model is three nested tiers reflected in the breadcrumb: **Organization → Workflow → Section**.

| Route | View |
|-------|------|
| `#org` | Portfolio "control tower" — cross-workflow KPIs, exceptions, bottlenecks, timeliness, AI-activity, freshness (polls every 5s) |
| `#` / `#flow` / `#rows` / `#list` | Workflow overview — merged flow DAG, per-case flow, and case list |
| `#case/<id>` | Case detail — SVG event timeline, branch-split, as-of scrubbing, reconstructed data panels |
| `#model` | Model page — version history, raw `workflow.json`, reload / restore / replace |
| `#bcs[/<system>/<table>]` | Systems explorer — three-pane Systems → Tables → Items console + connector-builder chat |
| `#connectors[/<id>]` | Connectors — inventory, Verify / Test / re-point / delete, and the Monaco code editor |
| `#admin` | Org Admin — members, roles, markings, environments, workspaces, BYOK keys, audit log |

A 420px AI assistant panel (process advisor / connector builder / event-log) slides in across views, sharing the `/chat` backend.

---

## Security & known caveats

The security model is genuinely load-bearing — derived-tenant isolation, a relational PDP, hash-chained audit, encrypted BYOK secrets, no default credentials, and a strict CSP. That said, this is an early-stage system with caveats that are documented honestly in the codebase and in [`docs/SECURITY-REVIEW-2026-06-30.md`](docs/SECURITY-REVIEW-2026-06-30.md):

- **Tenant isolation is app-enforced** (SQLite has no row-level security). The single scoped-store seam is the load-bearing guarantee; Postgres + RLS is the planned drop-in.
- **Connector code is an RCE surface.** Full-power connectors run in a sandboxed subprocess and the in-process AI-authored path is deny-scanned, but the connector/adapter subsystem is **not yet fully tenant-isolated** and connector credentials are stored in plaintext at rest (PoC). Gated by the `connector.build` capability and the `QLERIFY_CONNECTORS_ENABLED` kill-switch.
- **The audit log is tamper-evident, not yet tamper-proof** (WORM + SIEM export are deferred).
- Set `NODE_ENV=production` in any shared/deployed environment — it disables the forgeable dev auth shim.

Review the security doc and the open items before exposing this to untrusted tenants or production data.

---

## Further reading

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — the canonical design narrative (Kernel + Packs, the `.gen`/`.logic` seam, the digital twin, the increment log).
- [`MULTI-TENANT.md`](MULTI-TENANT.md) — the tenancy / identity / authorization design and its honest acceptance status.
- [`specification.md`](specification.md) — the original product brief (data import & storyline reconstruction, AI adapters, crypto-shredding for PII, AI commands + detection).
- [`docs/ORG-LEVEL-DASHBOARD.md`](docs/ORG-LEVEL-DASHBOARD.md) — the org-level portfolio dashboard design.
- [`docs/SECURITY-REVIEW-2026-06-30.md`](docs/SECURITY-REVIEW-2026-06-30.md) — the latest security review.
