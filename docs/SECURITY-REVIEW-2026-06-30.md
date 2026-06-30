# Security Review — qlerify-live On-Prem (Ericsson, Multi-Tenant)

**Reviewer:** Lead Security Reviewer
**Target:** qlerify-live, on-prem install at Ericsson, highest security bar, multi-tenant
**Branch/commit baseline:** `main` @ `ce8fc2d` (auth-issuance increment)
**Date:** 2026-06-30
**Methodology:** Each finding below survived two-lens adversarial verification (exploit-lens + refute-lens). REFUTED false positives were already dropped. `consensus` is CONFIRMED (both lenses agreed), DISPUTED (split — flagged for maintainer confirmation), or UNVERIFIED.

---

## 1. Executive Summary

qlerify-live cannot be deployed to the Ericsson on-prem multi-tenant environment as-is. The review confirmed **5 CRITICAL** and **12 HIGH** severity issues, plus numerous mediums and lows.

The dominant, deployment-blocking theme is that the **connector / adapter subsystem is architecturally not tenant-isolated and runs untrusted AI-authored code with weak boundaries**:

- A single **process-global, id-keyed** registry, sidecar store, journal, and credential workspace are shared across **all** orgs and workflows. The only authorization on most connector paths (`guardData("connector.edit")`) authorizes the **caller's own** workflow, never the targeted adapter id — a textbook IDOR (CWE-639) repeated across pull, copy-credentials, chat read-tools, code, config, and journal endpoints.
- Two distinct code-execution surfaces (the in-process "authored adapter" body and the subprocess connector) are guarded by a **regex deny-scan that is trivially bypassable** and an **SSRF guard that only wraps `ctx.fetch`**, so authenticated tenants reach **host RCE**, **internal-network SSRF**, and **exfiltration of `PLATFORM_ENCRYPTION_KEY`** — the master key for every org's BYOK secrets.
- Source-system credentials are stored **in cleartext** on the shared volume, while BYOK keys are encrypted — an inconsistent and exploitable secrets-at-rest gap.

Critically, **the connector kill-switch (`QLERIFY_CONNECTORS_ENABLED=false`) does not close all of these.** Several disclosure/tamper paths (connector source read, connector-chat journal, ungated chat read-tools) never call `guardData`, so they survive the switch. And confirmed cross-tenant reads exist completely outside connectors (chat `get_event_log`, the provenance global key). Therefore disabling connectors is a necessary mitigation but **not** a sufficient one.

**Verdict: NO_GO** until the Must-Fix set (Section 5) is remediated and re-verified.

---

## 1a. Decision Log — maintainer decisions (2026-06-30)

The two severity-pivotal DISPUTED findings were resolved by the maintainer:

- **F-18 → BY DESIGN (not a vulnerability).** The intended trust model is: the **organization** is the confidentiality boundary; **workflows within an org share data** and are deliberately not isolated from each other. Within-org cross-workflow reads are therefore intended. The org boundary itself is enforced (verified clean). Follow-up (hardening, not blocking): document that a workflow is NOT a security boundary, and add a regression guard so a future change cannot silently come to rely on workflow-level read isolation.
- **F-17 → ACCEPTED RESIDUAL + compensating control.** Runtime `npm install` of AI-influenced package names is accepted as a documented residual for now (the on-prem host is not yet mirror-locked). Compensating control: connector **building** is restricted to users with explicit **special access** — an ordinary org member can no longer author connector code.

**Scope caveat (do not over-read these):** the connector-build lock-down reduces *who* can reach the connector code-exec / SSRF / npm-install surface, but it does **not** by itself restore tenant isolation. Whether it resolves the connector cross-tenant criticals (F-01–F-05) depends on whether "special access" is a small **cross-tenant-trusted operator set** (resolves them by trust model) or a **per-org grant** (they remain — a builder in org A still reaches org B via the process-global stores) — *this is still open.* And it does not touch the ungated cross-tenant disclosure routes (F-06 read paths, F-08/F-12 connector-chat, F-16 chat read-tools) or the non-connector cross-tenant reads (F-26/F-35 `get_event_log`, F-28 provenance), which any authenticated user reaches with no connector access at all. **Those remain Must-Fix regardless. Verdict stays NO_GO.**

---

## 1b. Remediation Status (2026-06-30, post-review)

A first remediation increment landed and was **adversarially re-verified over three passes** (each finding
confirmed/refuted by independent agents; regressions in earlier fixes were caught and fixed). Build is clean;
130/131 tests pass (the 1 failure is a pre-existing date-flake in `tests/org/portfolio.test.ts`, unrelated).

**✅ REMEDIATED — the cross-tenant connector IDOR family (the dominant blocker):**
- **F-01** (critical) — pull now verifies adapter ownership before running a connector.
- **F-05** (critical) — `copy_connector_credentials` now authorizes the SOURCE connector.
- **F-06** (high) — all ungated disclosure/config/credential routes now require `guardData` + ownership; a new
  `connector.read` action makes the kill-switch cover code disclosure.
- **F-08 / F-12** (high) — connector-chat routes gated; journal key namespaced per workflow (`connectorChatKey`).
- **F-16** (high) — chat connector read-tools tenant-scoped; enumeration tools filtered.
- **F-20** (medium) — verify / test / healthcheck / dry-run gated + ownership-checked (no cross-tenant exec).
- **F-26** (medium) — chat `get_event_log` now folds in `eventLogOrgWhere()`.
- **F-28** (medium) — provenance modes keyed per workflow.
- **F-17** (maintainer decision) — connector AUTHORING gated behind a new `connector.build` → `administer`.
- Plus, found-and-fixed during verification: every adapter ENUMERATION sink (`/api/adapters`, `/api/bc`,
  `/api/bc/:bc`, `/api/bc/health`, the `/clear` journal loop) routed through a single owned-only choke point
  (`listOwnedAdapters`); `resetAdapter` / `adapterCfg` now preserve+stamp the tenant owner; `adapterOwned` fails
  CLOSED on unstamped sidecars; the D7 kill-switch now covers chat read/exec tools + in-process authored bodies;
  foreign-vs-unknown id responses unified (no existence oracle on HTTP or chat).

Mechanism: a single ownership choke point `src/packs/ownership.ts` (`adapterOwned` / `ownsAdapterId` /
`requireOwnedAdapter` / `listOwnedAdapters`) with a deliberate system/off-request bypass, so boot/sim/tests/demo
are unchanged and isolation is enforced only for real bound tenants.

**🔲 STILL MUST-FIX before deploy — the connector RCE + secrets cluster (needs architecture, not gates):**
- **F-02** (critical) — sandbox grants fs-read over the one shared cleartext-credentials dir → per-tenant workspace.
- **F-03 / F-04** (critical) — in-process AI-authored body behind a bypassable deny-scan → run out-of-process,
  strip `PLATFORM_ENCRYPTION_KEY` from the executor's reach.
- **F-07 / F-11** (high) — connector SSRF: OS-level egress confinement, fail-closed.
- **F-09** (high) — connector credentials encrypted at rest (per-org `secret-box`).
- **Per-`(org,workflow)` id namespacing** — closes the two residual LOW existence oracles (create-time
  `"already exists"`; write-tool wording) that are inherent to the process-global, id-keyed registry.

**Plus the untouched Should-Fix tier** from §5 (F-10 CSP, F-13 session revoke on reset, F-14 offboarding API,
F-15 `/chat` cost, F-19 `mustChangePassword`, F-22 status-pill escape, F-23 MCP SSRF, F-24 non-root container,
F-27 break-glass audit, F-33/F-40 secret handling).

**Verdict remains NO_GO** until the connector RCE + secrets cluster is remediated and re-verified — but the
multi-tenant cross-tenant-access blocker is now closed.

---

## 2. Deployment Verdict — NO_GO

For an Ericsson on-prem multi-tenant install, the operating rule is: **any confirmed pre-auth RCE, cross-tenant data access, or auth-bypass is deployment-blocking.**

This build has multiple **confirmed cross-tenant data-access** findings (F-01, F-02, F-05, F-06, F-08, F-09, F-12, F-16, F-26/F-35, F-28) and **confirmed authenticated code-execution** findings that escalate to cross-tenant master-key disclosure (F-03, F-04). None of the criticals are pre-auth, but cross-tenant data access by any authenticated low-privilege member is squarely in the blocking category for a multi-tenant trust model where tenants do not trust each other.

A `GO_WITH_CONDITIONS` (e.g. "ship with connectors disabled") was considered and rejected because:
1. The connector kill-switch lives inside `guardData`/`runConnector`, so it does **not** disable the ungated disclosure routes (F-06 read paths, F-08, F-12, F-16) — these are reachable cross-tenant even with connectors "off."
2. Cross-tenant reads in F-26/F-35 (`get_event_log`) and F-28 (provenance) are entirely independent of the connector subsystem.
3. The in-process authored-adapter RCE (F-04) and deny-scan bypass (F-03) are gated by `connector.edit` but, combined with the shared master key, are a cross-tenant compromise primitive.

**NO_GO** stands. Re-review is required after the Must-Fix items are fixed.

---

## 3. Findings Table (severity-ordered)

| Ref | Severity | Consensus | Title | File | CWE |
|-----|----------|-----------|-------|------|-----|
| F-01 | Critical | CONFIRMED | Cross-tenant data exfiltration via another org's connector (IDOR on pull) | `src/http/routes.ts:287` | CWE-639 |
| F-02 | Critical | CONFIRMED | Cross-tenant credential theft: sandbox grants fs-read over one global secrets dir | `src/packs/connector/runtime.ts:71` | CWE-552/668 |
| F-03 | Critical | CONFIRMED | Deny-scan is a bypassable regex denylist over in-process AI code | `src/packs/codegen/deny-scan.ts:8` | CWE-184/95 |
| F-04 | Critical | CONFIRMED | AI-authored adapter body runs in-process → host RCE + master-key exfil | `src/packs/adapters/authored.ts:42` | CWE-94 |
| F-05 | Critical | CONFIRMED | `copy_connector_credentials` steals another tenant's secret blob (no source check) | `src/packs/connector/orchestrate.ts:147` | CWE-639 |
| F-06 | High | CONFIRMED | Cross-tenant disclosure/tamper of connector source/config/journal/cred (survives kill-switch) | `src/http/adapter-routes.ts:57` | CWE-862/639 |
| F-07 | High | CONFIRMED | Connector SSRF/egress guard non-functional (global fetch / raw sockets) | `src/packs/connector/runtime.ts:160` | CWE-918 |
| F-08 | High | CONFIRMED | Cross-tenant connector-builder chat read/write/delete via global journal key | `src/http/bc-routes.ts:277` | CWE-639 |
| F-09 | High | CONFIRMED | Connector credentials stored unencrypted + copyable cross-tenant | `src/packs/connector/runtime.ts:222` | CWE-312 |
| F-10 | High | CONFIRMED | CSP trusts external CDN + `unsafe-eval`, no SRI → single point of full XSS | `src/server.ts:31` | CWE-829 |
| F-11 | High | CONFIRMED | Connector SSRF guard only wraps `ctx.fetch`; reaches internal/metadata hosts | `src/packs/connector/runtime.ts:169` | CWE-918 |
| F-12 | High | CONFIRMED | Connector-chat routes have no PDP gate + global `slug(bc-target)` key | `src/http/bc-routes.ts:277` | CWE-639 |
| F-13 | High | CONFIRMED | Admin password reset does not revoke live sessions (12h TTL) | `src/platform/provisioning/index.ts:125` | CWE-613 |
| F-14 | High | CONFIRMED | No account-offboarding API (cannot revoke a member short of deleting the org) | `src/platform/http/control-routes.ts:376` | CWE-862 |
| F-15 | High | CONFIRMED | `/chat` unbounded LLM cost: no rate-limit, no body cap, 14× Anthropic fan-out | `src/http/routes.ts:339` | CWE-770 |
| F-16 | High | CONFIRMED | Ungated chat read-tools disclose every tenant's connector code/cred-fields/journal | `src/chat/tools.ts:751` | CWE-1230/285 |
| F-17 | High | **ACCEPTED\*** | Connector runs `npm install` of tenant-influenced package names (\*residual accepted + build locked to special access — maintainer 2026-06-30) | `src/packs/connector/runtime.ts:303` | CWE-1357/829 |
| F-18 | Info | **BY-DESIGN** | Within-org cross-workflow reads (org is the boundary; workflows share data — maintainer-confirmed intended) | `src/platform/authn/index.ts:177` | CWE-639/862 |
| F-19 | Medium | CONFIRMED | `mustChangePassword` never enforced server-side | `src/platform/http/control-routes.ts:200` | CWE-620 |
| F-20 | Medium | CONFIRMED | Connector code execution reachable without `connector.edit` (verify/dry-run/healthcheck) | `src/http/bc-routes.ts:139` | CWE-862 |
| F-21 | Medium | CONFIRMED | Sandbox silently disabled (warning-only) when permission-model flag absent | `src/packs/connector/runtime.ts:60` | CWE-693 |
| F-22 | Medium | CONFIRMED | `status` attribute rendered unescaped (`pill()`) — stored markup injection | `web/app.js:3194` | CWE-79 |
| F-23 | Medium | CONFIRMED | Org-configured Qlerify MCP URL fetched server-side with no allowlist (SSRF) | `src/ontology/sync.ts:65` | CWE-918 |
| F-24 | Medium | CONFIRMED | Production container runs as root with full dev toolchain | `Dockerfile:36` | CWE-250 |
| F-25 | Medium | CONFIRMED | CSP external CDN + `unsafe-eval`; bearer token in localStorage (dup-of F-10/F-31) | `src/server.ts:31` | CWE-829 |
| F-26 | Medium | CONFIRMED | Chat `get_event_log` reads EventLog cross-tenant (missing org/workflow scope) | `src/chat/tools.ts:488` | CWE-639 |
| F-27 | Medium | CONFIRMED | Break-glass (superuser) cross-tenant data-plane reads leave no audit trail | `src/platform/authz.ts:25` | CWE-778 |
| F-28 | Medium | CONFIRMED | Cross-tenant provenance bleed via global `adapterModes` meta key + process cache | `src/twin/provenance.ts:21` | CWE-488/668 |
| F-29 | Medium | CONFIRMED | `mustChangePassword` not enforced (dup-of F-19) | `src/platform/authn/index.ts:115` | CWE-285 |
| F-30 | Medium | CONFIRMED | Unthrottled `/sim/run-all` (500-step) and `/api/data/reimport-all` (full wipe) | `src/http/routes.ts:407` | CWE-770 |
| F-31 | Medium | **DISPUTED** | Session bearer token in localStorage (no HttpOnly cookie) | `web/app.js:199` | CWE-522 |
| F-32 | Medium | **DISPUTED** | Non-atomic model swap (drop/recreate gen_ tables + wipe event log, no txn/lock) | `src/twin/apply.ts:93` | CWE-362 |
| F-33 | Low | CONFIRMED | Superuser password written to data volume in cleartext on every boot | `src/platform/provisioning/index.ts:647` | CWE-256 |
| F-34 | Low | CONFIRMED | Per-subject login throttle enables targeted account-lockout DoS | `src/platform/http/control-routes.ts:178` | CWE-645 |
| F-35 | Low | CONFIRMED | Chat `get_event_log` cross-tenant (dup-of F-26) | `src/chat/tools.ts:487` | CWE-862 |
| F-36 | Low | CONFIRMED | npm argument injection: `-`-prefixed import specifiers reach `npm install` argv | `src/packs/connector/runtime.ts:275` | CWE-88 |
| F-37 | Low | CONFIRMED | Superuser password file has default group/other-readable mode (dup-of F-33) | `src/platform/provisioning/index.ts:646` | CWE-256 |
| F-38 | Low | CONFIRMED | Global error handler returns raw `err.message` on 500 (SQL/internal disclosure) | `src/server.ts:85` | CWE-209 |
| F-39 | Low | CONFIRMED | CI deploy uses unpinned third-party action `@master` with `FLY_API_TOKEN` | `.github/workflows/fly-deploy.yml:32` | CWE-1357 |
| F-40 | Low | CONFIRMED | Live `ANTHROPIC_API_KEY` + `PLATFORM_ENCRYPTION_KEY` in working-tree `.env` | `.env:14` | CWE-312 |
| F-41 | Low | CONFIRMED | `membership.add` audit row omits the acting admin (actor null) | `src/platform/provisioning/index.ts:112` | CWE-778 |
| F-42 | Low | **DISPUTED** | Dev identity-forge shim gated by fail-open `NODE_ENV !== "production"` | `src/platform/authn/index.ts:64` | CWE-1188 |
| F-43 | Low | **DISPUTED** | No HSTS header; app serves plain HTTP, relies on external TLS terminator | `src/server.ts:47` | CWE-319 |
| F-44 | Low | **DISPUTED** | `blobPath()` does not validate hash is hex → path traversal from tampered manifest | `src/platform/ontology-store/content-store.ts:28` | CWE-22 |

> **Duplicate / overlap map:** F-25 ≈ F-10 (and ties to F-31); F-29 ≈ F-19; F-35 ≈ F-26; F-37 ≈ F-33; F-07 ≈ F-11; F-08 ≈ F-12; F-03 ≈ F-04 (two angles on the same in-process AI-code execution boundary). These are listed separately for traceability but should be fixed together.

---

## 4. Per-Finding Detail

### CRITICAL

#### F-01 — Cross-tenant data exfiltration via another org's connector (IDOR on pull)
**What:** The adapter registry is a single process-global `Map<string,SourceAdapter>` keyed only by a guessable adapter id, populated from one shared sidecar dir for all tenants. `POST /api/adapters/:id/pull` calls `guardData("connector.edit")`, which authorizes the **caller's own** active workflow, then `ingestPull(params.id)` dereferences the attacker-supplied global id and runs that connector with **its** stored credentials, inserting the resulting rows into the **caller's** namespace.
**Attack:** Any account self-provisions a throwaway org via `POST /v1/organizations` (becomes owner → `connector.edit` on its own workflow). `GET /api/adapters` (unguarded) enumerates victim org A's connector ids. `POST /api/adapters/sap-order/pull` passes the caller-scoped PDP check but executes org A's connector with org A's SAP credentials, landing org A's records in the attacker's `gen_` tables, then read back via `GET /api/bc/:bc/raw` (or returned inline by `/test` and chat `adapter_dry_run`).
**Why it matters for Ericsson:** Direct cross-tenant exfiltration of another business unit's source-system data, using that unit's own credentials, by any authenticated user. This is the canonical multi-tenant isolation break.
**Fix:** Bind every adapter op to the resolved `(org, workflow)`: namespace the registry/sidecar/workspace, and re-validate the targeted id is owned by `requireTenant().organizationId` + `currentWorkflowId()` before pull/test/run (404 on non-owned id). The correct ownership check (`connectorsInWorkflow(wf).find(c => c.id === id)`) already exists on the Connectors-tab routes and just needs to be applied here.

#### F-02 — Cross-tenant credential theft: sandbox grants fs-read over one global secrets dir
**What:** `CONNECTORS_DIR` is a single shared directory holding every connector's **plaintext** `${id}.cred.json`. The run sandbox grants `--allow-fs-read=${CONNECTORS_DIR}` / `--allow-fs-write=${CONNECTORS_DIR}` and runs the child with `cwd: CONNECTORS_DIR`. A connector therefore can `readdirSync('.')` + `readFileSync('<otherId>.cred.json')` **within the permissions the sandbox grants** — no escape needed.
**Attack:** An actor with `connector.edit` in any one workflow authors a connector whose `fetchRows` reads all sibling `*.cred.json` and returns them as rows; `adapter_dry_run` surfaces them as a visible sample — the plaintext AWS keys / DB strings / API tokens of every other tenant. The same fs-write grant lets workflow A overwrite workflow B's module.
**Why it matters:** Mass cross-tenant secret disclosure for any install that uses connectors.
**Fix:** Namespace the workspace per `(org, workflow)` and grant fs-read/write only to that connector's own subdir (or only its module + this run's ctx/cred/result files). Stop using the shared dir as `cwd`. Encrypt credentials at rest and decrypt only the single connector's creds in memory.

#### F-03 / F-04 — In-process AI-authored adapter body behind a bypassable deny-scan → host RCE + master-key exfil
**What:** The "Part 2.3 authored adapter" path dynamic-`import()`s AI-generated code and runs `body.fetchRows(ctx)` **in the main server process** (`authored-runtime.ts` itself states "ctx is a CONVENTION, not a hard sandbox"). The only barrier is `denyScan`, a literal-token regex blocklist that is bypassable in every class: `process?.env`, `process['e'+'nv']`, `globalThis['pro'+'cess']`, `(0,eval)(...)`, `[].constructor.constructor(...)`, and — decisively — `import('child'+'_process')` (dynamic `import()` is **not denied at all**; only `require(`). The real global `fetch` is unguarded, bypassing the `ctx.fetch` SSRF guard.
**Attack:** A `connector.edit` actor steers codegen (via the attacker-controlled `endpoint`/`errorReport` woven verbatim into the prompt) to emit a body that reads `process.env.PLATFORM_ENCRYPTION_KEY` and exfiltrates via global `fetch`, or runs `import('child'+'_process').execSync(...)` for host RCE. The body passes both write-time and load-time deny-scan and executes on the next `/test`, `/pull`, or `/verify`.
**Why it matters:** `PLATFORM_ENCRYPTION_KEY` is the single master key decrypting **every** org's BYOK ciphertext, so this is cross-tenant master-key compromise plus arbitrary host command execution on the Ericsson box — reachable by a mid-privilege authenticated tenant role.
**Fix:** Do not execute AI-authored bodies in-process behind a regex. Run them through the same OS-isolated, secret-stripped subprocess runner the connectors use. Move `PLATFORM_ENCRYPTION_KEY` and other secrets out of `process.env` into a holder the body cannot read. A denylist must never be the boundary for in-process code with secret access.

#### F-05 — `copy_connector_credentials` steals another tenant's secret blob (no source-ownership check)
**What:** `copyConnectorCredentials(fromId, toId)` checks only that both ids exist in the process-global store, then `readCredentials(fromId)` → `writeCredentials(toId, creds)`. The only authorization, the chat-layer `guardData("connector.edit")`, authorizes the **destination** (caller's own workflow); the attacker-supplied `fromId` never reaches the PDP. The handler also lacks a `confirmed:true` gate, so a prompt-injected chat turn can trigger it with no human in the loop.
**Attack:** An editor in org A asks the agent to copy creds from victim org B's connector (id discovered via the ungated `list_connector_credentials`) into A's connector, then builds a connector that echoes `ctx.credentials` into returned rows — recovering org B's literal secret values out of the explorer; or uses them directly against org B's backends.
**Why it matters:** Full plaintext cross-tenant credential theft, prompt-injection-drivable.
**Fix:** Authorize the **source**: deny unless `srcCfg.organizationId === currentOrgId()` and the source is in the caller's workflow. Resolve ids through a tenant-scoped lookup, namespace the stores per `(org, workflow)`, and add a `confirmed:true` gate.

---

### HIGH

#### F-06 — Cross-tenant disclosure/tamper of connector source/config/journal/cred (survives the kill-switch)
**What:** `GET /api/adapters/:id/code` (no `guardData`, no `requireTenant`) returns any tenant's connector source. The connector-chat routes key on a global `slug(bc-target)`. `PUT /api/bc/:bc/adapter/:id/credential` does a process-global `process.env[ref] = secret`. The read paths call no `guardData`, so they are **not** disabled by `QLERIFY_CONNECTORS_ENABLED=false`. (Maintainer-verified nuance: the mutating credential/delete/reset routes **do** call `guardData` and so ARE disabled by the kill-switch — but they still bind only the caller's own workflow, leaving the cross-tenant IDOR when connectors are enabled.)
**Fix:** Add an ownership check (`cfg.organizationId === requireTenant().organizationId` + workflow) to every id-addressed route and chat tool; namespace the on-disk stores; replace the global `process.env[ref]` credential store with the per-org encrypted store; gate read routes behind `guardData` so the kill-switch also covers disclosure.

#### F-07 / F-11 — Connector SSRF guard is non-functional
**What:** The advertised D4 SSRF guard only wraps `ctx.fetch` (`safeFetch`). The connector module is full-power ESM in the same child and can call the native global `fetch('http://169.254.169.254/...')` or `import('node:net'/'node:http'/'node:dns')` — none of which pass through the guard. The codegen prompt itself instructs the model to "use the global `fetch`." The only real egress jail (bubblewrap) is opt-in, Linux-only, off by default, and not installed in the shipped image (and even when enabled has no `--unshare-net`).
**Attack:** A `connector.edit` editor builds a connector that reads cloud-metadata IAM credentials or scans the internal Ericsson network; results return as explorer rows or in the error trace.
**Why it matters:** Authenticated SSRF into Ericsson's internal network and infra-credential theft, defeating a documented control.
**Fix:** Confine egress at the OS layer (mandatory netns/bwrap with `--unshare-net`, or a default-deny egress proxy with the RFC1918/metadata denylist), fail-closed if unavailable, and stop steering the model to global `fetch`. Resolve-then-connect to a pinned IP to also kill the `safeFetch` DNS-rebind TOCTOU.

#### F-08 / F-12 — Cross-tenant connector-builder chat (read/write/delete) via global journal key, no PDP
**What:** `GET/PUT/DELETE /api/bc/:bc/connector-chat` carry no `guardData` and store the full builder transcript in a process-global dir keyed by `slug(bc-target)` with no org/workflow scoping. `resolveBc` validates only against the caller's own model, and `target` is free-form, so the key space is fully attacker-controllable. The repo's own `.gitignore` notes the log "may contain pasted secrets."
**Attack:** A viewer in org B names a bounded context to collide with org A's slug and reads org A's transcript (including pasted source-system credentials), or overwrites/deletes it, or plants prompt-injection that later feeds codegen.
**Fix:** Add `guardData` to all three handlers and namespace the journal key/file by resolved org+workflow (never from request params). Validate `target` against the live schema.

#### F-09 — Connector credentials cleartext at rest + cross-tenant copy
**What:** Source-system credentials are written as plaintext JSON to the shared volume (`PoC — security deferred`), while BYOK keys are AES-256-GCM encrypted — an inconsistent secrets-at-rest posture. Combined with F-05, a tenant can copy and read another tenant's plaintext secrets entirely via the chat/API.
**Fix:** Encrypt connector credentials at rest with the existing `secret-box` keyed per org; scope ids and storage by `(org, workflow)`; add a same-org check to `copyConnectorCredentials`/`setConnectorCredentials`.

#### F-10 / F-25 — CSP trusts external CDN + `unsafe-eval`, no SRI
**What:** `script-src 'self' 'unsafe-eval' https://cdn.tailwindcss.com`, and `index.html` loads the CDN with no SRI. Since script-src has no `'unsafe-inline'`, this CDN allowance is the **only** path to true in-origin JS execution — i.e. the whole CSP backstop hinges on a public internet-hosted script. The bearer token lives in JS-readable `localStorage` and the CSP has no `form-action`/`navigate-to`, so exfil via top-level navigation is unrestricted.
**Attack:** A CDN/supply-chain compromise or a TLS-intercepting corporate proxy (a realistic on-prem topology) serves malicious JS that reads `ql.token` and exfiltrates it → operator account takeover. Air-gapped installs also cannot fetch the CDN (UI breaks; metadata egress to Cloudflare/Google).
**Fix:** Self-host a precompiled Tailwind CSS asset; drop `'unsafe-eval'` and the external origin so script-src becomes `'self'`; add `form-action 'self'`. For the highest-bar profile, ship no runtime dependency on a public CDN for executable code.

#### F-13 — Admin password reset does not revoke the target's live sessions
**What:** `issueMemberCredential()` rotates the hash and sets `mustChangePassword` but never revokes `PlatSession` rows. `resolveSession` only checks missing/revoked/expired (12h TTL), so a stolen token stays valid for up to 12h after a "containment" reset. The self-service path correctly calls `platSession.updateMany({revokedAt})` — the admin path conspicuously omits it.
**Fix:** In `issueMemberCredential`, revoke the target's live sessions in the same transaction.

#### F-14 — No account-offboarding API
**What:** The control plane exposes only add/grant verbs — no `DELETE /v1/memberships`, no identity-deactivation, no `DELETE /v1/role-assignments`, no admin session-revoke. The `status:'active'` gates that would lock out a departed user are dead code from the API's perspective. The only full cutoff is deleting the entire org.
**Why it matters:** A departed/compromised contractor's membership, roles, and (per F-13) live session cannot be individually revoked — unacceptable for an enterprise on-prem deployment. (Refute-lens note: per-request re-checks mean flipping the DB field would cut access on next request, so the gap is precisely "no API to flip those fields"; severity is high given the high-security bar.)
**Fix:** Add org-admin-gated, audited routes to remove membership, deactivate identity, and revoke role assignments — each also revoking live sessions and scoped to the caller's org.

#### F-15 — `/chat` unbounded LLM cost / cross-tenant AI degradation
**What:** `POST /chat` has no PDP gate, no body cap beyond Fastify's 1 MiB default, and no rate limit; each request fans out to up to 14 Anthropic calls (`max_tokens 4096`). Even a viewer drives the full loop (denied write tools return `is_error`, which keeps the loop alive). Orgs without BYOK share the platform `ANTHROPIC_API_KEY`, so one tenant's abuse exhausts the shared quota for all no-BYOK tenants.
**Fix:** Add per-identity/per-org throttling + a chat capability gate, a small per-route body limit, a `messages[]`/token cap, and per-org spend budgets; apply a tighter quota (or require BYOK) for platform-default-key callers.

#### F-16 — Ungated chat read-tools disclose every tenant's connector code/cred-fields/journal
**What:** `list_connector_credentials`, `view_connector_code`, `get_connector_history`, `get_adapter_config`, `check_adapter_credential` are not in `TOOL_WRITE_ACTIONS`, so `runTool` never calls `guardData`. They read the process-global stores with no org/workflow filter, returning any tenant's connector source, credential field-names, presence booleans, and journals — also the enumeration primitive that weaponizes F-05. Deterministic `slug` ids permit blind targeting.
**Fix:** Route these tools through the same `connectorsInWorkflow(currentWorkflowId())` scoping as the Connectors tab (404 on non-owned id); treat connector reads as `workflow.read` scoped to the owning workflow; namespace the on-disk stores.

#### F-17 — ⚠️ ACCEPTED RESIDUAL + COMPENSATING CONTROL (maintainer decision 2026-06-30)
**Decision:** Runtime `npm install` is accepted as a documented residual risk for now (host not yet mirror-locked). Compensating control: connector **building** is restricted to users with explicit special access (ordinary org members can no longer author connector code). Caveat: this shrinks the attacker population for the connector code-exec / SSRF / install surface but does not by itself restore tenant isolation (see F-01–F-09); its effect on those criticals depends on whether "special access" is a central cross-tenant-trusted operator set or a per-org grant — *still open*.

**Original analysis (retained for record):**
**What:** `buildConnector` runs `npm install` of bare specifiers extracted from AI-generated code, with no allowlist, no version pin, no committed `.npmrc`, and no lockfile — a dependency-confusion / typosquat / version-float surface on the on-prem host. The package's module-load code later executes in the run child.
**Split:** The exploit-lens confirmed the install behavior and the dependency-confusion risk. The refute-lens argued the impact is **not an escalation**: it is gated by `connector.edit` (authenticated, same-org), `--ignore-scripts` + a secret-stripped env block postinstall RCE and secret reads, and the run child's raw-socket capability is already available to the same editor without any supply-chain trick — so it is trusted-operator defense-in-depth, not a privilege break. **Maintainer to confirm** whether the on-prem npm registry is locked to an internal mirror.
**Fix (agreed regardless):** Strict package allowlist + exact version pins + a baked `.npmrc` pointing only at the internal mirror; default connectors OFF for the on-prem profile.

#### F-18 — ✅ RESOLVED — BY DESIGN (maintainer decision 2026-06-30)
**Decision:** The organization is the confidentiality boundary; workflows within an org intentionally share data, so within-org cross-workflow reads are by design — not a vulnerability. The org boundary itself is enforced (verified clean). Follow-up (hardening, not blocking): document that a workflow is NOT a security boundary and add a regression guard so nothing later relies on workflow-level read isolation.

**Original analysis (retained for record):**
**What:** `X-Workflow-Id` is validated only to belong to the caller's org, never that the caller holds a role on **that** workflow. The `workflow.read` permission is defined but never enforced; data-plane read handlers call no PDP and write no audit row. A member with a workflow-scoped role on workflow A can swap the header and read workflow B's event log, business rows, full model JSON, and connector config.
**Split:** The exploit-lens confirmed the mechanism and treats it as a genuine authorization gap (workflow-scoped roles are a real, UI-exposed feature, enforced on writes but not reads). The refute-lens argued this is **intended design** — `action-map.ts` comments state reads "stay membership-scoped (any org member)" to match the org-dashboard read model, and read access is gated by org membership, not workflow role, so no enforced control is bypassed. **The org boundary is enforced in both readings (no cross-org/cross-tenant escape).** Maintainer must confirm whether within-org cross-workflow read isolation is a required property for Ericsson's multi-team-in-one-org posture; if yes, this is a Must-Fix.
**Fix (if required):** Call `guardData("workflow.read")` at the top of every data-plane read handler (wiring up the existing permission and the audit trail), and/or verify the caller has `view` on the workflow's containment chain before binding `X-Workflow-Id`.

---

### MEDIUM

- **F-19 / F-29 — `mustChangePassword` not enforced server-side.** The flag is set on issuance and echoed to the SPA but never consulted by any auth gate; a temp/reset credential is usable indefinitely via the JSON API. **Fix:** Reject all routes except change-password/logout for a must-change identity; combine with F-13 session revocation.
- **F-20 — Connector code execution without `connector.edit`.** `/verify` (`healthcheck`), `GET /api/adapters/:id` (inline `healthcheck`), and chat `adapter_dry_run`/`run_adapter_healthcheck` reach `runConnector` with no PDP, unlike `/test` and `/pull`. A viewer can run an existing connector (its credentials), get a credential-validity/egress oracle, and a 2-row data sample. **Fix:** Gate every path that reaches `runConnector`/`fetchRows`/`healthcheck` behind `guardData("connector.edit")`.
- **F-21 — Sandbox silently disabled when the permission-model flag is absent.** `permissionFlag()` returns `null` with only a (production-only) `console.warn`, and `sandboxArgs()` returns `[]`, so the connector child runs with no FS/child_process confinement. The shipped `node:22-slim` image has the model, but an on-prem host on a different/older Node or with experimental flags disabled by policy loses the sandbox with no fail-closed. **Fix:** Fail closed — refuse to run connector code (or hard-disable the subsystem at boot) when neither the permission model nor a bwrap jail is available.
- **F-22 — `status` value rendered unescaped via `pill()`.** Every other `genVal` branch escapes; the status branch interpolates raw. A connector-ingested `status` field of `<form …>` renders a full-viewport credential-harvest overlay in an admin's authenticated DOM (no `form-action`, `style-src 'unsafe-inline'`). Becomes outright stored XSS if the CSP is relaxed. **Fix:** `escapeHtml(text)` in `pill()`; add `form-action 'self'`.
- **F-23 — Qlerify MCP URL server-side SSRF.** The org-configured `qlerifyMcpUrl` override is fetched (at save and on every reload) with no `assertSafeUrl`/allowlist, and non-2xx bodies are reflected to the caller. An org-admin sets it to `169.254.169.254` or an internal service for an SSRF read oracle. **Fix:** Run the override through `assertSafeUrl`/an allowlist, require https, and stop echoing upstream bodies.
- **F-24 — Container runs as root with full dev toolchain.** No `USER` directive; `npm ci` ships `tsx`/Prisma CLI/npm; the connector subsystem spawns `npm`/`node` as uid 0. A chained code-exec bug → root in container (write all tenants' DB/volume, read process env secrets, overwrite `/app`). **Fix:** `USER node`, `chown` `/app` and `/data`, drop the dev toolchain from the runtime image (or drop capabilities / read-only rootfs); ship connectors off.
- **F-26 / F-35 — Chat `get_event_log` reads EventLog cross-tenant.** The lone EventLog read that omits `eventLogOrgWhere()`; a `caseId` from another org/workflow returns that case's event metadata (names, refs, bounded contexts, roles, timestamps). **Fix:** Add `...eventLogOrgWhere()`; add a lint/repository guard forbidding unscoped `eventLog` queries.
- **F-27 — Break-glass cross-tenant reads are unaudited.** Audit rows are written only inside `ensureAllowed`; the entire data plane (`/sim/event-log` with full payload, `/api/bc/:bc/raw`, `/org/portfolio`, …) is reachable by a superuser with no audit row, contradicting the documented "a superuser peeking into another tenant always leaves a trail." **Fix:** Emit a `break_glass.enter` audit row once per request when `actingAsPlatformAdmin` is set, independent of any downstream `ensureAllowed`.
- **F-28 — Cross-tenant provenance bleed.** Adapter mode is persisted under a single flat `_app_meta["adapterModes"]` key (no org/workflow), with a process-global cache, keyed by bounded-context **name**. When two tenants share a BC name, tenant A's `live` connector flips the default provenance globally, mis-stamping tenant B's simulated events as "real" (corrupting B's twin-trust/conformance metric) and leaking A's adapter id/mode/timestamp to B's viewers. **Fix:** Scope the store and cache per `(org, workflow)`, mirroring the correctly-namespaced `orgdash:mappings:<orgId>` store.
- **F-30 — Unthrottled compute/DB exhaustion.** `/sim/run-all` (up to 500 sequential steps) and `/api/data/reimport-all` (full wipe + re-pull all connectors) have PDP gates but no throttle/concurrency guard; an authenticated insider can contend the single SQLite writer and degrade latency for co-tenants. Availability-only, self-scoped data. **Fix:** Per-identity throttle + in-flight concurrency guard; queue these as background jobs; lower the 500/1000 defaults.
- **F-31 — DISPUTED — bearer token in localStorage.** Confirmed by one lens as a defense-in-depth gap that amplifies any XSS/CDN compromise into durable, browser-unbound account takeover; refuted by the other as a standard SPA pattern with no standalone exploit under the current no-`unsafe-inline` CSP. Tied to F-10. **Recommendation:** Move the session to an `HttpOnly; Secure; SameSite` cookie with CSRF protection (hardening, not blocking).
- **F-32 — DISPUTED — non-atomic model swap.** Confirmed as a real availability + crash-integrity race (no transaction, no per-workflow lock, `CREATE TABLE` without `IF NOT EXISTS`, `currentVersionId` advanced before tables are rebuilt). The headline cross-tenant `orgColCache` escalation was **refuted** — gen_ tables are per-workflow so the org stamp is redundant within them. Gated by `organization.administer`. **Fix:** Wrap the swap in a transaction, serialize per workflow, use `IF NOT EXISTS`, flip `currentVersionId` last.

---

### LOW (CONFIRMED)

- **F-33 / F-37 — Superuser password written to the data volume in cleartext on every boot**, even when supplied via `SUPERADMIN_PASSWORD`, with default group/other-readable file mode. Local/backup/sidecar read → full cross-tenant break-glass. **Fix:** Only write in the auto-generated case, mode `0600`, to a non-volume path or stdout-once; never re-persist an operator-supplied secret.
- **F-34 — Targeted login-lockout DoS.** The per-subject throttle is checked before verification and reset only on success, so an attacker who knows a username can keep a victim's bucket full and 429 their correct-password logins. Pre-auth, availability-only, self-healing. **Fix:** Verify first / exempt a correct credential / use escalating delay instead of a hard pre-empt.
- **F-36 — npm argument injection.** `scanImports` passes `-`-prefixed import specifiers straight into `npm install` argv. Low impact today (`--ignore-scripts` appended last; `/`-bearing flags mangled), but brittle. **Fix:** Validate specifiers against a strict package-name regex; use `npm install --`.
- **F-38 — Error handler returns raw `err.message` on 500**, leaking SQL/Prisma/SQLite internal detail (schema identifiers). **Fix:** Generic body for status ≥ 500; log the real message server-side only.
- **F-39 — CI deploy uses `superfly/flyctl-actions/setup-flyctl@master`** (unpinned) in a job holding `FLY_API_TOKEN`. **Fix:** Pin to a full commit SHA; add an environment-protection/approval gate.
- **F-40 — Live `ANTHROPIC_API_KEY` + `PLATFORM_ENCRYPTION_KEY` in the working-tree `.env`.** Git and Docker vectors are clean (ignored + dockerignored + never committed), but the secrets are at rest in cleartext on the dev checkout. **Fix:** Rotate both now; keep secrets in an out-of-tree store; ensure prod values differ from any value that touched a checkout.
- **F-41 — `membership.add` audit row omits the acting admin** (`actorPrincipalId: null`), unlike `role.assign`. Weakens incident-response attribution. **Fix:** Thread `ctx.principal.id` into `addMembership`.

### LOW (DISPUTED — needs maintainer confirmation)

- **F-42 — Dev identity-forge shim gated by fail-open `NODE_ENV !== "production"`.** Confirmed as an insecure default (any non-`"production"` value re-enables the header-forge shim on a non-Docker on-prem boot); refuted as **not currently exploitable** because `devSubjectAllowed` refuses any identity with a password or platform-admin grant, and no passwordless-with-membership identity is produced by shipped code. **Fix (agreed):** Make the gate fail-closed (explicit opt-in flag) and log loudly when the shim is live; document the `NODE_ENV=production` requirement in the on-prem runbook.
- **F-43 — No HSTS header / plain-HTTP app.** Confirmed there is no app-side HSTS and the app listens on plain HTTP; refuted as a reverse-proxy/deploy-layer concern (HSTS must be emitted over HTTPS by the TLS terminator, and the on-prem topology presupposes one). **Fix:** Emit HSTS from the TLS terminator and document an http→https redirect requirement in the deployment runbook.
- **F-44 — `blobPath()` does not validate the hash is hex.** Confirmed traversal mechanics; refuted as not API-reachable (all manifest hashes are server-recomputed sha256-hex; the only injection point is direct blob-file overwrite, which already implies host FS write — a strictly greater capability). **Fix (cheap hardening):** Reject any hash not matching `/^[0-9a-f]{64}$/` at the CAS boundary and validate `manifest.workflowHash`/`overlayHash` before `cas.get`.

---

## 5. Prioritized Remediation Roadmap

### Must-fix-before-deploy (deployment-blocking — 16 findings)
These are the confirmed cross-tenant data-access and authenticated-code-execution issues. The simplest correct sequencing is to **redesign the connector/adapter subsystem for tenant isolation and out-of-process execution**, which closes the bulk of them at the root.

1. **F-01** — bind adapter pull to resolved `(org, workflow)`; validate id ownership.
2. **F-02** — namespace the connector workspace per tenant; never grant fs-read over the shared secrets dir; encrypt creds at rest.
3. **F-03** — stop relying on the regex deny-scan; isolate the authored path out-of-process.
4. **F-04** — run AI-authored bodies in the secret-stripped subprocess runner; remove master-key from in-process `env` reach.
5. **F-05** — authorize the **source** connector in `copyConnectorCredentials`; add a confirm gate.
6. **F-06** — ownership checks + `guardData` on all id-addressed connector routes (so the kill-switch also covers disclosure).
7. **F-07 / F-11** — OS-level egress confinement (mandatory netns/bwrap with `--unshare-net` or egress proxy); fail-closed.
8. **F-08 / F-12** — `guardData` + per-(org,workflow) journal key for connector-chat.
9. **F-09** — encrypt connector credentials at rest; per-tenant id/storage scoping.
10. **F-16** — tenant-scope the chat connector read-tools.
11. **F-20** — gate `/verify`, `GET /api/adapters/:id`, `adapter_dry_run`, `run_adapter_healthcheck`.
12. **F-21** — fail-closed when no sandbox is available.
13. **F-26 / F-35** — add `eventLogOrgWhere()` to chat `get_event_log`.
14. **F-28** — per-tenant scoping of the provenance store + cache.

> **Interim mitigation (not a substitute for the fixes):** set `QLERIFY_CONNECTORS_ENABLED=false`. This closes the connector *execution* paths (F-01 pull-exec, F-02, F-03/F-04 connector RCE path, F-05 build/run, F-07/F-11, F-20) but **does NOT** close the ungated disclosure routes (F-06 read paths, F-08/F-12, F-16) or the non-connector cross-tenant reads (F-26/F-35, F-28). Those must still be fixed before deploy.
>
> **Maintainer decisions (2026-06-30):** F-18 — RESOLVED as by design (the org is the confidentiality boundary; workflows within an org share data). F-17 — runtime `npm install` ACCEPTED as a documented residual; compensating control = restrict connector building to special-access users. Neither is a Must-Fix code change on its own. **However**, the connector cross-tenant criticals (F-01–F-09), the ungated cross-tenant disclosure routes (F-06 / F-08 / F-12 / F-16), and the non-connector cross-tenant reads (F-26 / F-35, F-28) remain Must-Fix regardless of these two decisions. Whether the F-17 build lock-down downgrades F-01–F-05 depends on the still-open question of how widely "special access" is trusted (central operators vs per-org).

### Should-fix-before-deploy (strongly recommended for the high-security bar)
- **F-10 / F-25** — self-host Tailwind; remove `unsafe-eval` + external CDN; add `form-action 'self'`.
- **F-13** — revoke sessions on admin password reset.
- **F-14** — add member offboarding APIs (remove membership / deactivate / revoke role + session revoke + audit).
- **F-15** — throttle + capability-gate + body/token cap `/chat`; per-org spend budgets.
- **F-19 / F-29** — enforce `mustChangePassword` server-side.
- **F-22** — escape the `status` pill.
- **F-23** — allowlist/validate the Qlerify MCP URL; require https.
- **F-24** — non-root container; drop the dev toolchain from the runtime image.
- **F-27** — audit break-glass entry.
- **F-33 / F-37** — stop persisting the superuser password / mode 0600 / generated-only.
- **F-40** — rotate the exposed `.env` secrets.

### Hardening backlog
- **F-30** (throttle/concurrency on run-all/reimport), **F-31** (HttpOnly cookie), **F-32** (atomic model swap), **F-34** (login-lockout tuning), **F-36** (npm arg validation), **F-38** (generic 500 body), **F-39** (pin CI actions), **F-41** (audit actor on membership.add), **F-42** (fail-closed dev shim), **F-43** (HSTS at terminator), **F-44** (hex-validate CAS keys).

---

## 6. What Was Verified Clean / Residual Risk & Assumptions

**Verified clean (good controls observed during review):**
- **Deny-by-default authentication.** The tenant plugin (`tenant-plugin.ts`) rejects unauthenticated requests on all non-public paths (only `/v1/auth/*` and static assets are exempt), so none of the criticals are pre-auth.
- **Org boundary on the PDP.** `authorize()` denies cross-org resources (step-0 org check); `X-Org-Id` is validated against an active membership, not trusted blindly. No confirmed **cross-org** escape exists outside the connector subsystem and the disputed F-18 (which is within-org).
- **Production dev-shim gating.** The forgeable identity shim is disabled when `NODE_ENV=production` (set in the shipped Dockerfile and `fly.toml`) and additionally refuses password-bearing / platform-admin identities (F-42 is a fail-open-default hardening nit, not a live forge in shipped config).
- **BYOK secrets** are AES-256-GCM encrypted at rest via `secret-box` (the inconsistency is that **connector** creds are not — F-09).
- **Projection-store SQL** uses parameterized `$executeRawUnsafe` bindings (no SQL injection found); event-log reads are otherwise consistently scoped via `eventLogOrgWhere()` except the one missed call site (F-26).
- **No committed secrets / no image-baked `.env`** (`.env` is git-ignored, never committed, and dockerignored — F-40 is a working-tree-only exposure).
- **Login rate-limiting** exists for `/v1/auth/login` (the F-34 weakness is its lockout shape, not its absence).

**Residual risk & assumptions:**
- This review is point-in-time against `main` @ `ce8fc2d`. Re-review is required after Must-Fix remediation; verifying the connector redesign in particular needs a fresh pass.
- Findings were verified by code reading and (for the deny-scan/SSRF/permission-model claims) targeted local reproduction, not by a full live exploit against a running multi-tenant instance. The two-lens consensus labels reflect that.
- **DISPUTED findings (F-17, F-18, F-31, F-32, F-42, F-43, F-44)** require maintainer confirmation of intended design or deployment topology before final classification. F-18 in particular is severity-pivotal: if within-org cross-workflow read isolation is required for Ericsson, it is deployment-blocking.
- Exploitability of the connector findings assumes connectors are enabled (default) and in use. The interim kill-switch reduces but does not eliminate exposure (see Section 5).
- The on-prem trust model assumes other tenants and low-privilege members are potential adversaries; that assumption is what makes the authenticated cross-tenant findings deployment-blocking rather than merely high.
