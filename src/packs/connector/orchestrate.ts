// Connector lifecycle orchestration (Part 2.4). The thin layer the chat tools (and
// any HTTP route) call to drive the Lovable-style loop: create a connector for a
// system + kind, store its credentials, build/repair its code with AI, and remove
// it. Test + ingest reuse the standard SourceAdapter path (the connector adapter is
// a normal registry entry), so they live in tools.ts / ingest.ts unchanged.

import { getOntology } from "../../ontology/model.js";
import { getAdapter, registerAdapter, unregisterAdapter } from "../registry.js";
import { readSidecar, writeSidecar, deleteSidecar } from "../sidecar.js";
import { createConnectorAdapter, resolveTargetSchema } from "../adapters/connector.js";
import { generateConnectorModule } from "./codegen.js";
import {
  writeModule, writeCredentials, readCredentials, credentialKeys, moduleExists,
  installDeps, deleteConnectorFiles, type InstallResult,
} from "./runtime.js";
import type { AdapterConfig } from "../types.js";

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "connector";
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
  const cfg: AdapterConfig = {
    id, kind: "connector", boundedContext: bc, targetEntity: input.target, targetKind,
    phase: "draft", mode: "live",
  };
  writeSidecar(cfg);
  registerAdapter(createConnectorAdapter(cfg));
  return cfg;
}

/** Store the plaintext credentials blob (any shape). Returns the field NAMES. */
export function setConnectorCredentials(id: string, creds: Record<string, unknown>): string[] {
  const cfg = readSidecar(id);
  if (!cfg) throw new Error(`no connector "${id}"`);
  writeCredentials(id, creds);
  return credentialKeys(id);
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
  const next: AdapterConfig = { ...cfg, kind: "connector", targetKind, phase: "built", instructions: instr, deps: gen.deps };
  writeSidecar(next);
  registerAdapter(createConnectorAdapter(next));
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
}

/** Inspect a connector WITHOUT exposing secret values (only credential field
 * names). For the chat doctor / sidebar. */
export function connectorInfo(id: string): ConnectorInfo | null {
  const cfg = readSidecar(id);
  if (!cfg) return null;
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
  };
}

/** Read the connector's current source (for "show me the code"). */
export { readModule as readConnectorCode } from "./runtime.js";
export { readCredentials as readConnectorCredentials } from "./runtime.js";

/** Delete a connector entirely: module + creds + sidecar + registry entry. */
export function removeConnector(id: string): void {
  if (!readSidecar(id) && !moduleExists(id)) throw new Error(`no connector "${id}"`);
  deleteConnectorFiles(id);
  deleteSidecar(id);
  unregisterAdapter(id);
}
