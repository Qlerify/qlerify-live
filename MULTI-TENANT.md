# Multi-Tenant Foundation — Increment 1

This is the lowest layer of the platform: the **tenancy / identity / authorization /
isolation spine** from `multi-tenant-platform-spec.md`, adapted to this codebase.
It is **strictly additive** — the existing single-tenant demo runs unchanged, now
*through* the spine as a seeded **system organization** (no `TENANCY=off` bypass).

## What shipped (`src/platform/*`)

| Area | Module | Spec |
|---|---|---|
| Tenant context (fail-closed, ALS) | `tenancy/context.ts`, `tenancy/scoped-store.ts` | §9, §11 |
| AuthN (org derived from membership, never from input) | `authn/index.ts` + `http/tenant-plugin.ts` | §5, §11 |
| Embedded PDP (MAC-gate → ReBAC) + action map | `pdp/index.ts`, `pdp/action-map.ts` | §6 |
| Append-only, per-org **hash-chained** audit | `audit/index.ts` | §17 |
| Ontology-as-resource + **content-addressed** version store | `ontology-store/*` | §16, §15 |
| Provisioning (org → env/ws/proj + registry + owner) | `provisioning/index.ts` | §10 |
| Control-plane REST (`/v1/*`) | `http/control-routes.ts` | §19 |
| Schema (23 `plat_*` tables, composite FKs) | `prisma/schema.prisma` | §8 |

**Two confirmed decisions:** SQLite now (Postgres+RLS reserved as increment 2's first
task behind the `TenantDataSource` seam); **one org / one region**.

## Model storage at scale (the explicit question)

Thousands→millions of `workflow.json` are stored as a **split store**, not loose files
and not one giant JSON column:

- **Governance metadata in relational rows** — `plat_ontologies` (a `Resource`),
  `plat_ontology_versions`, `plat_ontology_branches`. Cheap to list / search / authorize.
- **Bodies in a content-addressed blob store (CAS)** — `sha256` of a *canonical*
  serialization, sharded `.qlerify/orgs/<org>/blobs/<hh>/<hash>` (→ object storage,
  prefix-per-org, at scale). Org-scoped; **no cross-org dedup** (it would be an
  existence oracle across tenants).
- A **version = the `(workflow.json + overlay.json)` pair** via a manifest blob — fixing
  the embryo's overlay-drop bug. This generalizes `.qlerify/history` + `manifest.json`
  (`current` → `currentVersionId`, `versions[]` → rows, hash → blob key) and adds real
  dedup, integrity, and an immutable-hash parse cache.

## Using it

- **Auth (dev shim):** `Authorization: Bearer <idp-subject>` or `X-Identity-Subject`.
  Optional `X-Org-Id` / `X-Org-Slug` *selects* among an identity's orgs but only indexes
  the membership check — the canonical `organization_id` is the membership row's org.
  **No headers ⇒ the system tenant** (the demo path).
- **Control plane:** `GET /v1/whoami`, `POST /v1/organizations`, `POST /v1/environments`,
  `POST /v1/memberships`, `POST /v1/role-assignments`, `POST /v1/authorize`,
  `GET/PUT /v1/ontologies[/:id[/content]]`, `GET /v1/audit/verify`.
- Tests: `tests/platform/isolation.test.ts` (model-independent).

## Acceptance checklist (spec §20) — honest status

| # | Invariant | Status |
|---|---|---|
| 1 | `organization_id` derived from identity, asserted end-to-end; never from client input | **DONE** (HTTP-proven: spoofed `X-Org-Id` → 403) |
| 2 | Cross-org denied by default at multiple layers | **PARTIAL** — 2 of 3 layers (tenant-context routing + PDP). The **RLS layer is deferred** (SQLite has none); the scoped store is fail-closed app-enforcement |
| 3 | RLS (`FORCE`) on every tenant-owned table; non-`BYPASSRLS` role; `SET LOCAL` | **DEFERRED (critical)** — *impossible on SQLite*. Increment 2's first task; substitute = the single fail-closed `scoped-store` chokepoint |
| 4 | Composite FKs prevent cross-org parenting | **PARTIAL** — real SQLite composite FKs on the org→env→ws→proj chain as defense-in-depth, but **app-validated** for the security invariant until Postgres |
| 5 | MAC gate runs before DAC | **DONE** (tested: a marking the owner lacks denies before role check) |
| 6 | Marking propagation along lineage, monotonic, persisted | **DEFERRED** — direct markings only; lineage propagation is Phase 2 |
| 7 | Human identity global; org access membership-only | **DONE** |
| 8 | Sharing/deletion require `administer`; sharing audited | **DONE** (action map + audit) |
| 9 | Audit append-only, hash-chained | **PARTIAL** — tamper-*evident* (chain verifies/detects). WORM + SIEM export deferred |
| 10 | Same identity/authz model across pooled/bridged/siloed | **DONE for pooled**; bridged/siloed are registry columns only |
| 11 | Failed provisioning leaves a non-routable state | **PARTIAL** — registry has the `status` column; orchestration is minimal |

**Known limitation (named, not hidden):** `events/registry.ts` builds a process-global
`EVENTS` snapshot at module load; once a *second* org loads a *different* model, the bus
resolves events against the active context's model. Inc 1 exercises a single non-system
org's commands, so this is latent; making `EVENTS` fully per-org is an increment-2 item.

## Roadmap

- **Inc 2 (real enforcement):** migrate the data plane (`gen_` + `EventLog`) to Postgres
  15+ with RLS `FORCE` / `SET LOCAL` behind `TenantDataSource`; per-org `EVENTS`; ontology
  metadata → Postgres, CAS bodies → S3/GCS prefix-per-org.
- **Inc 3 (governance):** external ReBAC engine (SpiceDB/OpenFGA) behind `authorize()` with
  outbox + ZedToken; lineage + marking propagation; branching/promotion; BYOK/CMK; bridged
  tenancy; custom roles; SIEM/WORM audit.
- **Inc 4:** siloed tenancy; cross-org federation; quotas/metering; break-glass.
