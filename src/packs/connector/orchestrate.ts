// Connector lifecycle orchestration (Part 2.4). The thin layer the chat tools (and
// any HTTP route) call to drive the Lovable-style loop: create a connector for a
// system + kind, store its credentials, build/repair its code with AI, and remove
// it. Test + ingest reuse the standard SourceAdapter path (the connector adapter is
// a normal registry entry), so they live in tools.ts / ingest.ts unchanged.

import { getOntology } from "../../ontology/model.js";
import { currentWorkflowId, currentOrgId } from "../../platform/tenancy/context.js";
import { getAdapter, registerAdapter, unregisterAdapter } from "../registry.js";
import { readSidecar, writeSidecar, deleteSidecar, listSidecars } from "../sidecar.js";
import { createConnectorAdapter, resolveTargetSchema } from "../adapters/connector.js";
import { generateConnectorModule, describeConnector, proposeDateRoles, timestampFields, PLATFORM_TIMESTAMP_COLS } from "./codegen.js";
import {
  writeModule, readModule, writeCredentials, readCredentials, credentialKeys, moduleExists,
  installDeps, deleteConnectorFiles, type InstallResult,
} from "./runtime.js";
import {
  appendNote, setConnectorSummary, deleteChat, deleteDoc, connectorChatKey,
} from "./journal.js";
import type { AdapterConfig } from "../types.js";

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "connector";
}

/** Owning tenant for a connector, from the request context. Null off-request
 * (boot / tests) — those connectors are adopted by model membership instead. */
export function connectorOwner(): { workflowId: string | null; organizationId: string | null } {
  try {
    return { workflowId: currentWorkflowId(), organizationId: currentOrgId() };
  } catch {
    return { workflowId: null, organizationId: null };
  }
}

/** Does this connector sidecar belong to the given workflow? A stamped owner is
 * authoritative; a legacy (unstamped) connector is adopted by the workflow whose
 * live model defines its target table. */
export function connectorInWorkflow(cfg: AdapterConfig, workflowId: string | null): boolean {
  if (cfg.kind !== "connector") return false;
  if ((cfg.workflowId ?? null) === workflowId) return true;
  return !cfg.workflowId && !!resolveTargetSchema(cfg.targetEntity);
}

/** Every connector in the active workflow's scope. The Connectors tab's source. */
export function connectorsInWorkflow(workflowId: string | null): AdapterConfig[] {
  return listSidecars().filter((s) => connectorInWorkflow(s, workflowId));
}

/** The connector (if any) already populating `target` in `workflowId` — the
 * one-connector-per-table invariant, enforced at create and re-point. */
export function connectorForTarget(target: string, workflowId: string | null, exceptId?: string): AdapterConfig | undefined {
  return listSidecars().find((s) =>
    s.kind === "connector" && s.targetEntity === target && s.id !== exceptId && connectorInWorkflow(s, workflowId));
}

/** Deterministic doc summary from metadata alone — the fallback when the AI
 * describer is unavailable (no key) or errors, so a description always exists. */
function fallbackSummary(cfg: AdapterConfig, keys: string[]): string {
  const access = keys.length ? `authenticates with ${keys.join(", ")}` : "no credentials configured";
  const ep = cfg.endpoint ? ` at ${cfg.endpoint}` : "";
  return `Connector populating ${cfg.targetEntity} in ${cfg.boundedContext}${ep}; ${access}.`;
}

/** (Re)generate the connector's doc summary with the AI and store it. Reads the
 * connector's current code + config so the description reflects the source system,
 * target table, credential/access method, and any filters/sort/limits actually in
 * the code. Best-effort: any failure falls back to a deterministic summary. Pass
 * `codeOverride` right after a build to avoid a redundant disk read. */
export async function regenerateConnectorSummary(id: string, codeOverride?: string): Promise<void> {
  const cfg = readSidecar(id);
  if (!cfg) return;
  const target = resolveTargetSchema(cfg.targetEntity);
  if (!target) return;
  const keys = credentialKeys(id);
  let summary: string;
  try {
    summary = await describeConnector({
      system: cfg.boundedContext,
      target,
      targetKind: cfg.targetKind ?? (getOntology().entity(cfg.targetEntity) ? "entity" : "valueObject"),
      instructions: (cfg.instructions ?? "").trim(),
      credentialKeys: keys,
      endpoint: cfg.endpoint,
      deps: cfg.deps ?? [],
      mode: cfg.mode,
      code: codeOverride ?? readModule(id) ?? "",
    });
  } catch {
    summary = fallbackSummary(cfg, keys);
  }
  setConnectorSummary(id, summary);
}

export interface CreateConnectorInput {
  boundedContext: string;
  /** Entity or value-object name the connector populates. */
  target: string;
  id?: string;
}

/** Bootstrap a connector for a system + kind. No code yet — build it next. */
export function createConnector(input: CreateConnectorInput): AdapterConfig {
  const o = getOntology();
  const bc = o.boundedContexts.find((b) => b.toLowerCase() === input.boundedContext.toLowerCase());
  if (!bc) throw new Error(`unknown system / bounded context "${input.boundedContext}"`);
  if (!resolveTargetSchema(input.target)) {
    throw new Error(`"${input.target}" is not an entity or value object in the loaded model`);
  }
  const targetKind: "entity" | "valueObject" = o.entity(input.target) ? "entity" : "valueObject";
  const id = slug(input.id || `${bc}-${input.target}`);
  if (getAdapter(id) || readSidecar(id)) throw new Error(`a connector/adapter "${id}" already exists`);
  // One connector per table (within this workflow). Catches the custom-id and
  // legacy-adoption paths the id check alone would miss.
  const { workflowId, organizationId } = connectorOwner();
  const clash = connectorForTarget(input.target, workflowId, id);
  if (clash) {
    throw new Error(`A connector already populates "${input.target}" in this workflow: "${clash.id}". Delete that connector first (Connectors tab → Delete), or choose a different table.`);
  }
  const cfg: AdapterConfig = {
    id, kind: "connector", boundedContext: bc, targetEntity: input.target, targetKind,
    phase: "draft", mode: "live", workflowId, organizationId,
  };
  writeSidecar(cfg);
  registerAdapter(createConnectorAdapter(cfg));
  appendNote(id, "created", `Created connector targeting ${input.target} (${targetKind}) in ${bc}.`);
  return cfg;
}

/** Store the plaintext credentials blob (any shape). Returns the field NAMES. */
export async function setConnectorCredentials(id: string, creds: Record<string, unknown>): Promise<string[]> {
  const cfg = readSidecar(id);
  if (!cfg) throw new Error(`no connector "${id}"`);
  writeCredentials(id, creds);
  const keys = credentialKeys(id);
  appendNote(id, "credentials", `Stored credentials: ${keys.join(", ") || "(none)"}.`);
  // Credentials are the "way of access" — refresh the description once code exists
  // so it reflects the new auth. Before a build there's nothing to describe yet.
  if (moduleExists(id)) await regenerateConnectorSummary(id);
  return keys;
}

/** Reuse another connector's stored credentials for THIS connector — copies the
 * source's credential blob to the destination server-side. The secret VALUES are
 * never returned (only the field names), so they never enter the chat/LLM. For
 * "use the same credentials as the X connector". */
export async function copyConnectorCredentials(fromId: string, toId: string): Promise<string[]> {
  if (fromId === toId) throw new Error("source and destination are the same connector");
  if (!readSidecar(toId)) throw new Error(`no connector "${toId}"`);
  if (!readSidecar(fromId)) throw new Error(`no connector "${fromId}"`);
  const creds = readCredentials(fromId);
  if (!creds || Object.keys(creds).length === 0) throw new Error(`connector "${fromId}" has no stored credentials to copy`);
  writeCredentials(toId, creds);
  const keys = credentialKeys(toId);
  appendNote(toId, "credentials", `Reused credentials from ${fromId}: ${keys.join(", ") || "(none)"}.`);
  if (moduleExists(toId)) await regenerateConnectorSummary(toId);
  return keys;
}

export interface BuildConnectorResult {
  deps: string[];
  install: InstallResult;
  bytes: number;
  targetKind: "entity" | "valueObject";
}

/** Author (or repair) the connector's code with AI, install whatever npm packages
 * it imports, write the module, and re-register the adapter. Stop-and-show: this
 * does NOT run or ingest — the caller tests it next. */
export async function buildConnector(id: string, instructions?: string, errorReport?: string): Promise<BuildConnectorResult> {
  const cfg = readSidecar(id);
  if (!cfg) throw new Error(`no connector "${id}"`);
  const target = resolveTargetSchema(cfg.targetEntity);
  if (!target) throw new Error(`target "${cfg.targetEntity}" is not in the loaded model`);
  const targetKind: "entity" | "valueObject" = cfg.targetKind ?? (getOntology().entity(cfg.targetEntity) ? "entity" : "valueObject");
  const instr = (instructions ?? cfg.instructions ?? "").trim();

  const gen = await generateConnectorModule({
    target, targetKind, instructions: instr,
    credentialKeys: credentialKeys(id), endpoint: cfg.endpoint, errorReport,
  });
  // Install first so a missing-dep failure is reported here, not as a cryptic
  // "Cannot find package" at run time. The module is written regardless so the
  // operator/AI can inspect and repair it.
  const install = await installDeps(gen.deps);
  writeModule(id, gen.code);
  // Infer which columns hold the source's creation vs last-modified timestamp so
  // derive can stamp create/update events with real dates. Preserve an existing
  // (possibly operator-overridden) mapping; only infer when none is set yet, so a
  // repair turn never silently clobbers a deliberate choice. Best-effort.
  let dateRoles = cfg.dateRoles;
  if (!dateRoles?.created && !dateRoles?.updated) {
    try {
      const proposed = await proposeDateRoles({ target, instructions: instr, code: gen.code });
      if (proposed.created || proposed.updated) dateRoles = proposed;
    } catch { /* leave roles unset; derive falls back to its first-date-field heuristic */ }
  }
  const next: AdapterConfig = {
    ...cfg, kind: "connector", targetKind, phase: "built", instructions: instr, deps: gen.deps,
    ...(dateRoles?.created || dateRoles?.updated ? { dateRoles } : {}),
  };
  writeSidecar(next);
  registerAdapter(createConnectorAdapter(next));
  if (dateRoles?.created || dateRoles?.updated) {
    appendNote(id, "built", `Timestamp roles inferred: created=${dateRoles.created ?? "—"}, updated=${dateRoles.updated ?? "—"}.`);
  }
  // Let the AI describe the freshly built connector (system, table, access method,
  // and any filters/sort/limits in the code). Runs on every build AND repair, so
  // the description stays in sync with the code.
  await regenerateConnectorSummary(id, gen.code);
  const depsNote = gen.deps.length ? `, deps: ${gen.deps.join(", ")}` : "";
  appendNote(
    id,
    errorReport ? "repaired" : "built",
    errorReport
      ? `Repaired connector code after an error (${gen.code.length} bytes${depsNote}).`
      : `Built connector code (${gen.code.length} bytes${depsNote}).`,
  );
  return { deps: gen.deps, install, bytes: gen.code.length, targetKind };
}

export interface ConnectorInfo {
  id: string;
  boundedContext: string;
  target: string;
  targetKind: "entity" | "valueObject";
  endpoint: string | null;
  hasCode: boolean;
  credentialKeys: string[];
  deps: string[];
  phase: string;
  /** The source's creation/last-modified timestamp columns, or null if none set. */
  dateRoles: { created?: string; updated?: string } | null;
  /** Candidate timestamp columns on the target schema — the override picker's options. */
  dateFields: string[];
}

/** Inspect a connector WITHOUT exposing secret values (only credential field
 * names). For the chat doctor / sidebar. */
export function connectorInfo(id: string): ConnectorInfo | null {
  const cfg = readSidecar(id);
  if (!cfg) return null;
  const target = resolveTargetSchema(cfg.targetEntity);
  return {
    id: cfg.id,
    boundedContext: cfg.boundedContext,
    target: cfg.targetEntity,
    targetKind: cfg.targetKind ?? "entity",
    endpoint: cfg.endpoint ?? null,
    hasCode: moduleExists(id),
    credentialKeys: credentialKeys(id),
    deps: cfg.deps ?? [],
    phase: cfg.phase,
    dateRoles: cfg.dateRoles ?? null,
    dateFields: target ? timestampFields(target) : [],
  };
}

/** The created/updated date-role hints declared by the connector populating
 * `entity` in the active workflow, or undefined. twin/derive.ts consumes these to
 * stamp create-kind events with the source's creation date and update-kind events
 * with its last-modified date. Best-effort: off-request (boot/tests) or no
 * connector → undefined, and derive falls back to its first-date-field heuristic. */
export function dateRolesForEntity(entity: string): { created?: string; updated?: string } | undefined {
  let wf: string | null;
  try { wf = currentWorkflowId(); } catch { wf = null; }
  const cfg = connectorForTarget(entity, wf);
  const roles = cfg?.dateRoles;
  if (!roles || (!roles.created && !roles.updated)) return undefined;
  return roles;
}

/** Operator override of the creation/last-modified timestamp columns. Validates the
 * field names against the target schema (a typo can't silently disable date
 * routing); a null/empty value clears that role. Returns the stored roles. */
export function setConnectorDateRoles(
  id: string,
  roles: { created?: string | null; updated?: string | null },
): { created?: string; updated?: string } {
  const cfg = readSidecar(id);
  if (!cfg) throw new Error(`no connector "${id}"`);
  const target = resolveTargetSchema(cfg.targetEntity);
  // Valid anchors = the schema's own fields plus the always-present platform
  // timestamp columns a connector can populate. Null target (orphaned) → no schema
  // to validate against, so accept any name.
  const valid = target ? new Set<string>([...target.fields.map((f) => f.name), ...PLATFORM_TIMESTAMP_COLS]) : null;
  const clean: { created?: string; updated?: string } = {};
  for (const key of ["created", "updated"] as const) {
    const v = roles[key];
    if (v == null || v === "") continue;
    if (valid && !valid.has(v)) throw new Error(`"${v}" is not a field on ${cfg.targetEntity}`);
    clean[key] = v;
  }
  const next: AdapterConfig = { ...cfg };
  if (clean.created || clean.updated) next.dateRoles = clean;
  else delete next.dateRoles;
  writeSidecar(next);
  registerAdapter(createConnectorAdapter(next));
  appendNote(id, "note", `Timestamp roles set: created=${clean.created ?? "—"}, updated=${clean.updated ?? "—"}.`);
  return clean;
}

/** Read the connector's current source (for "show me the code"). */
export { readModule as readConnectorCode } from "./runtime.js";
export { readCredentials as readConnectorCredentials } from "./runtime.js";

/** Delete a connector entirely: module + creds + sidecar + registry entry, plus
 * its journal (chat history + doc). Also clears the table-keyed chat thread in
 * case the connector used a custom id that differs from slug(bc-target). */
export function removeConnector(id: string): void {
  const cfg = readSidecar(id);
  if (!cfg && !moduleExists(id)) throw new Error(`no connector "${id}"`);
  deleteConnectorFiles(id);
  deleteSidecar(id);
  unregisterAdapter(id);
  deleteChat(id);
  deleteDoc(id);
  if (cfg) deleteChat(connectorChatKey(cfg.boundedContext, cfg.targetEntity));
}
