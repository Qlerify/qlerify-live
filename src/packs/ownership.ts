// Tenant-ownership gate for the adapter/connector subsystem.
//
// The registry, sidecar store, journal and credential workspace are process-global
// and keyed only by a guessable adapter id (see the connector-tenant-isolation
// gap). Every id-addressed connector/adapter operation therefore MUST verify the
// id belongs to the caller's resolved (org, workflow) before touching it —
// otherwise a member of one org can read/run/copy/exfiltrate another org's
// connector code, credentials and source data (the F-01/F-05/F-06/F-16 IDOR
// family). These helpers are the single choke point for that check.
//
// Deliberate design: the SYSTEM / off-request context (boot, fs.watch, the sim
// runner, tests, module-load) is NOT a tenant — it owns everything, so existing
// non-request flows and the demo are unchanged. Ownership is enforced ONLY for a
// real bound tenant (a request resolved to an org + a real workflow), which is the
// only context where cross-tenant access is possible.

import { readSidecar } from "./sidecar.js";
import { listAdapters } from "./registry.js";
import { currentOrgId, currentWorkflowId, isSystemWorkflow } from "../platform/tenancy/context.js";
import type { AdapterConfig, SourceAdapter } from "./types.js";

/** Thrown when an id-addressed adapter is unknown OR owned by another tenant. The
 * message is identical in both cases so it is not a cross-tenant existence oracle. */
export class AdapterNotOwnedError extends Error {
  readonly code = "NOT_FOUND";
  readonly status = 404;
  constructor(id: string) {
    super(`no adapter "${id}" in this workflow`);
  }
}

/** Does this sidecar belong to the current tenant? A stamped owner must match the
 * resolved (org, workflow) EXACTLY. An UNSTAMPED sidecar is owned by NO real tenant
 * — it fails closed. (Model-membership adoption was removed: it let any tenant whose
 * model merely declares the same entity NAME "adopt" an unstamped connector, which
 * a reset/strip could weaponise into the cross-tenant IDOR this guard exists to
 * prevent. Every tenant-created connector is stamped at creation AND keeps its stamp
 * across reset/rebuild, so a real tenant never legitimately owns an unstamped one;
 * genuine legacy/off-request connectors remain reachable via the system bypass.) */
export function adapterOwned(cfg: AdapterConfig): boolean {
  if (isSystemWorkflow()) return true; // off-request / system context is not a tenant
  let wf: string;
  let org: string;
  try {
    wf = currentWorkflowId();
    org = currentOrgId();
  } catch {
    return false; // a bound org with no active workflow owns nothing (fail closed)
  }
  return cfg.organizationId === org && cfg.workflowId === wf;
}

/** True iff the current tenant may address `id`. The system/off-request context
 * owns everything. A registry adapter with NO sidecar is operator-shipped global
 * code (a code-defined pack adapter), owned by no tenant and accessible to all —
 * it is never another tenant's data (tenant-created connectors ALWAYS have a
 * stamped sidecar while they exist; the first write to a pack adapter stamps it,
 * see author.ts adapterCfg). A sidecar that DOES exist is enforced EXACTLY: a
 * stamped owner must match the resolved (org, workflow); an existing-but-unstamped
 * sidecar is owned by NO tenant and fails closed (model-membership adoption was
 * removed — it was a cross-tenant IDOR vector). Use to GATE registry-addressed
 * operations; non-existence is handled by the subsequent getAdapter/adapterCfg lookup. */
export function ownsAdapterId(id: string): boolean {
  if (isSystemWorkflow()) return true;
  const cfg = readSidecar(id);
  if (!cfg) return true; // global/pack adapter (or unknown id → 404'd downstream)
  return adapterOwned(cfg);
}

/** Resolve a sidecar by id, asserting tenant ownership. Throws AdapterNotOwnedError
 * (→ 404) when the id is unknown or owned by another tenant. Use when the handler
 * needs the cfg AND the ownership guarantee. */
export function requireOwnedAdapter(id: string): AdapterConfig {
  const cfg = readSidecar(id);
  if (!cfg || !adapterOwned(cfg)) throw new AdapterNotOwnedError(id);
  return cfg;
}

/** The registry adapters the current tenant may see — the SINGLE choke point for
 * every adapter ENUMERATION sink (the registry is process-global, so an unfiltered
 * listAdapters() leaks every tenant's connector ids/targets/modes). Use this in
 * place of listAdapters() anywhere the result is returned to or counted for a
 * caller. The system/off-request context sees everything (ownsAdapterId bypass). */
export function listOwnedAdapters(): SourceAdapter[] {
  return listAdapters().filter((a) => ownsAdapterId(a.id));
}
