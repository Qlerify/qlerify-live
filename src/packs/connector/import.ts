// Import counterpart of export.ts — recreates connectors from a portable
// "qlerify-connector-export" envelope in the ACTIVE workflow. Per-entry, never
// all-or-nothing: each connector imports or is skipped with a reason, so one
// conflict doesn't sink a whole backup. Conflict policy:
//   - id already used by a connector IN THIS WORKFLOW → skip (re-importing a
//     backup must not duplicate);
//   - id used by anything else (foreign workflow's sidecar, a pack adapter —
//     sidecar ids are a global file namespace) → import under "<id>-2", "-3", …
//     rather than skip, which would leak the existence of a foreign connector;
//   - target table already fed by another connector here → skip (I1, same rule
//     as create/re-point);
//   - target table missing from the model → import as ORPHANED. That is the
//     Connectors tab's first-class recovery state (re-point or delete), and it
//     is what makes cross-environment sharing work when models differ.
// Tenancy is restamped from the request context (the envelope carries none) and
// ids are re-slugged — an id becomes a sidecar FILENAME, so a hostile file must
// not traverse paths. phase is recomputed from what actually imports (code →
// built, none → draft): the source's phase may claim test/ingest states this
// environment hasn't earned. Credential VALUES are never in an envelope; the
// outcome echoes credentialKeys so the operator knows what to re-enter.

import { getOntology } from "../../ontology/model.js";
import { currentWorkflowId, currentOrgId } from "../../platform/tenancy/context.js";
import { getAdapter, registerAdapter } from "../registry.js";
import { listSidecars, writeSidecar } from "../sidecar.js";
import { createConnectorAdapter, resolveTargetSchema } from "../adapters/connector.js";
import { writeModule, writeRuleFile, installDeps, scanImports, type InstallResult } from "./runtime.js";
import { appendNote } from "./journal.js";
import { BEHAVIORS, connectorInWorkflow, regenerateConnectorSummary } from "./orchestrate.js";
import { ruleScan } from "./rules.js";
import {
  CONNECTOR_EXPORT_FORMAT, CONNECTOR_EXPORT_VERSION,
  type ConnectorExportEnvelope, type ConnectorExportEntry,
} from "./export.js";
import type { AdapterConfig, TriggerRule } from "../types.js";
import type { ProvMode } from "../../twin/provenance.js";

/** Hard cap on entries per upload. An entry is cheap to fabricate (~60 bytes)
 * and each import does real disk + registry work, so an uncapped envelope is a
 * resource-exhaustion vector on this shared process. Far above any real backup. */
export const MAX_IMPORT_ENTRIES = 200;

/** Ids become sidecar/module FILENAMES: re-slug (path safety) and cap the length
 * (filename components max out at 255 bytes; leave room for our suffixes). */
function slug(s: string): string {
  return (s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "connector").slice(0, 80);
}

/** Validate an uploaded envelope. Throws with an operator-readable message —
 * the route maps it to a 400. Entry-level problems are NOT rejected here; they
 * surface as per-entry skips so the rest of the file still imports. */
export function parseConnectorExport(body: unknown): ConnectorExportEnvelope {
  const b = body as Partial<ConnectorExportEnvelope> | null;
  if (!b || typeof b !== "object") throw new Error("not a JSON object");
  if (b.format !== CONNECTOR_EXPORT_FORMAT) {
    throw new Error(`not a connector export file (expected format "${CONNECTOR_EXPORT_FORMAT}")`);
  }
  if (b.version !== CONNECTOR_EXPORT_VERSION) {
    throw new Error(`unsupported export version ${JSON.stringify(b.version)} (this server reads version ${CONNECTOR_EXPORT_VERSION})`);
  }
  if (!Array.isArray(b.connectors)) throw new Error("missing connectors array");
  if (b.connectors.length > MAX_IMPORT_ENTRIES) {
    throw new Error(`too many connectors (${b.connectors.length}) — this server imports at most ${MAX_IMPORT_ENTRIES} per file`);
  }
  return b as ConnectorExportEnvelope;
}

// --- envelope value sanitizers -----------------------------------------------
// The allow-list fixes WHICH fields survive; these fix their TYPES. A sidecar is
// trusted downstream (buildConnector calls .trim() on instructions outside any
// try; mode is stamped onto ingested rows' provenance) — a hand-crafted envelope
// must not plant values the closed unions/consumers can't digest.

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function provMode(v: unknown): ProvMode {
  return v === "simulated" || v === "recorded" || v === "live" ? v : "live";
}

function dateRoles(v: unknown): { created?: string; updated?: string } | undefined {
  if (!v || typeof v !== "object") return undefined;
  const created = str((v as Record<string, unknown>).created);
  const updated = str((v as Record<string, unknown>).updated);
  return created || updated ? { ...(created ? { created } : {}), ...(updated ? { updated } : {}) } : undefined;
}

function fieldMap(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k] = val;
  }
  return Object.keys(out).length ? out : undefined;
}

function discoveredFields(v: unknown): Array<{ name: string; dataType?: string; sample?: string }> | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: Array<{ name: string; dataType?: string; sample?: string }> = [];
  for (const item of v.slice(0, 200)) {
    if (!item || typeof item !== "object") continue;
    const name = str((item as Record<string, unknown>).name);
    if (!name) continue;
    const dataType = str((item as Record<string, unknown>).dataType);
    const sample = str((item as Record<string, unknown>).sample);
    out.push({
      name: name.slice(0, 200),
      ...(dataType ? { dataType: dataType.slice(0, 40) } : {}),
      ...(sample !== undefined ? { sample: sample.slice(0, 200) } : {}),
    });
  }
  return out.length ? out : undefined;
}

function limits(v: unknown): { pageSize?: number; limit?: number } | undefined {
  if (!v || typeof v !== "object") return undefined;
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
  const pageSize = num((v as Record<string, unknown>).pageSize);
  const limit = num((v as Record<string, unknown>).limit);
  return pageSize !== undefined || limit !== undefined
    ? { ...(pageSize !== undefined ? { pageSize } : {}), ...(limit !== undefined ? { limit } : {}) }
    : undefined;
}

export interface ImportOutcome {
  id: string;
  /** Set when the envelope's id was taken and the connector imported renamed. */
  originalId?: string;
  targetEntity: string;
  status: "active" | "orphaned";
  phase: "draft" | "built";
  /** Field NAMES the operator must re-enter — values are never in an export. */
  credentialKeys: string[];
  install?: InstallResult;
  /** Trigger-rule outcome, when the entry carried rules. Rules failing the
   * deny-scan (or malformed) are dropped per-rule with a reason, never imported
   * blind — rule code runs IN-PROCESS at derive time. */
  rules?: { imported: number; skipped: Array<{ eventKey: string; reason: string }> };
}

export interface ImportSkip { id: string; reason: string; message: string; }

export interface ImportResult { imported: ImportOutcome[]; skipped: ImportSkip[]; }

/** One directory scan's worth of state, maintained in memory as entries land —
 * per-entry rescans would make a large import O(N²) in synchronous disk reads
 * on this shared event loop. `occupied` mirrors connectorForTarget for the
 * destination workflow. */
interface ImportIndex {
  workflowId: string;
  organizationId: string;
  sidecarIds: Set<string>;
  /** targetEntity → connector id, for connectors IN the destination workflow. */
  occupied: Map<string, string>;
  /** ids of connectors already in the destination workflow. */
  inWorkflow: Set<string>;
}

function buildIndex(workflowId: string, organizationId: string): ImportIndex {
  const sidecarIds = new Set<string>();
  const occupied = new Map<string, string>();
  const inWorkflow = new Set<string>();
  for (const s of listSidecars()) {
    sidecarIds.add(s.id);
    if (connectorInWorkflow(s, workflowId)) {
      inWorkflow.add(s.id);
      occupied.set(s.targetEntity, s.id);
    }
  }
  return { workflowId, organizationId, sidecarIds, occupied, inWorkflow };
}

/** First id not taken by ANY sidecar or registered adapter (global namespace). */
function freeId(want: string, ix: ImportIndex): string {
  const taken = (id: string) => !!getAdapter(id) || ix.sidecarIds.has(id);
  if (!taken(want)) return want;
  for (let n = 2; ; n++) {
    if (!taken(`${want}-${n}`)) return `${want}-${n}`;
  }
}

async function importEntry(entry: ConnectorExportEntry, ix: ImportIndex): Promise<ImportOutcome | ImportSkip> {
  const src = entry?.config;
  const rawId = typeof src?.id === "string" ? src.id : "";
  if (!src || !rawId || typeof src.targetEntity !== "string" || !src.targetEntity) {
    return { id: rawId || "(unknown)", reason: "INVALID_ENTRY", message: "entry has no config.id / config.targetEntity" };
  }
  if (src.kind !== "connector") {
    return { id: rawId, reason: "NOT_A_CONNECTOR", message: `kind "${String(src.kind)}" is not importable — only kind "connector"` };
  }

  const wantId = slug(rawId);
  if (ix.inWorkflow.has(wantId)) {
    return { id: wantId, reason: "CONNECTOR_EXISTS", message: `connector "${wantId}" already exists in this workflow — delete it first to re-import` };
  }
  const id = freeId(wantId, ix);

  const target = src.targetEntity;
  const occupant = ix.occupied.get(target);
  if (occupant) {
    return { id: wantId, reason: "TABLE_OCCUPIED", message: `"${target}" is already populated by connector "${occupant}" in this workflow` };
  }

  const schema = resolveTargetSchema(target);
  const targetKind: "entity" | "valueObject" =
    src.targetKind === "entity" || src.targetKind === "valueObject"
      ? src.targetKind
      : schema ? (getOntology().entity(target) ? "entity" : "valueObject") : "entity";

  const code = typeof entry.code === "string" && entry.code.trim() ? entry.code : null;
  // Deps come from the code that actually imports (source of truth), not the
  // envelope's claim. Install failure still imports — stop-and-show, same as
  // saving hand-edited code: the module is on disk for the operator to repair.
  const deps = code ? scanImports(code) : undefined;
  const install = code ? await installDeps(deps ?? []) : undefined;
  if (code) writeModule(id, code);

  // Trigger rules: per-rule sanitation + the SAME deny-scan the save path runs —
  // this is in-process code, and a hand-crafted envelope is untrusted input. A
  // rejected rule is dropped with a reason; the connector still imports (its
  // event falls back to the static heuristic — visible in the manifest).
  const ruleRecords: TriggerRule[] = [];
  const ruleSkips: Array<{ eventKey: string; reason: string }> = [];
  if (Array.isArray(entry.rules)) {
    for (const r of entry.rules.slice(0, 50)) {
      const eventKey = typeof r?.eventKey === "string" ? r.eventKey.trim() : "";
      const ruleCode = typeof r?.code === "string" ? r.code : "";
      if (!eventKey || !ruleCode.trim()) {
        ruleSkips.push({ eventKey: eventKey || "(unknown)", reason: "missing eventKey/code" });
        continue;
      }
      if (ruleRecords.some((x) => x.eventKey === eventKey)) {
        ruleSkips.push({ eventKey, reason: "duplicate eventKey" });
        continue;
      }
      const scan = ruleScan(ruleCode);
      if (!scan.ok) {
        ruleSkips.push({ eventKey, reason: `deny-scan: ${scan.violations.join(", ")}` });
        continue;
      }
      const written = writeRuleFile(id, eventKey, ruleCode);
      ruleRecords.push({
        eventKey,
        eventRef: str(r.eventRef) ?? `#/domainEvents/${eventKey}`,
        condition: str(r.condition) ?? "",
        gwtHash: str(r.gwtHash) ?? "",
        file: written.file,
        codeHash: written.codeHash,
        builtAt: new Date().toISOString(),
        author: r.author === "ai" ? "ai" : "human",
      });
    }
  }

  const instructions = str(src.instructions);
  const endpoint = str(src.endpoint);
  const connectionOptionId = str(src.connectionOptionId);
  const roles = dateRoles(src.dateRoles);
  const map = fieldMap(src.fieldMap);
  const lim = limits(src.limits);
  const discovered = discoveredFields(src.discoveredFields);
  const discoveredAtStr = str(src.discoveredAt);
  // An unrecognised value is dropped rather than trusted: an import is
  // attacker-influenced input, and a bad string here would read as "not an
  // actuator" everywhere downstream.
  const behavior = BEHAVIORS.find((b) => b === src.behavior);
  const targetSystem = str(src.targetSystem)?.slice(0, 60);
  const cfg: AdapterConfig = {
    id, kind: "connector", boundedContext: str(src.boundedContext) ?? "", targetEntity: target, targetKind,
    ...(behavior ? { behavior } : {}),
    ...(targetSystem ? { targetSystem } : {}),
    phase: code ? "built" : "draft", mode: provMode(src.mode),
    workflowId: ix.workflowId, organizationId: ix.organizationId,
    ...(instructions !== undefined ? { instructions } : {}),
    ...(deps && deps.length ? { deps } : {}),
    ...(roles ? { dateRoles: roles } : {}),
    ...(map ? { fieldMap: map } : {}),
    ...(lim ? { limits: lim } : {}),
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(connectionOptionId !== undefined ? { connectionOptionId } : {}),
    ...(ruleRecords.length ? { triggerRules: ruleRecords } : {}),
    ...(discovered ? { discoveredFields: discovered } : {}),
    ...(discovered && discoveredAtStr ? { discoveredAt: discoveredAtStr } : {}),
  };
  writeSidecar(cfg);
  ix.sidecarIds.add(id);
  ix.inWorkflow.add(id);
  ix.occupied.set(target, id);
  registerAdapter(createConnectorAdapter(cfg));
  const renamed = id !== wantId ? ` (renamed from "${wantId}" — that id was taken)` : "";
  appendNote(id, "created", `Imported from backup targeting ${target} (${targetKind})${renamed}.`);
  // Best-effort description (falls back to a deterministic summary without an AI
  // key). No-op for orphans — resolveTargetSchema gates it internally.
  if (code) await regenerateConnectorSummary(id, code);

  return {
    id, ...(id !== wantId ? { originalId: wantId } : {}),
    targetEntity: target, status: schema ? "active" : "orphaned",
    phase: code ? "built" : "draft",
    credentialKeys: Array.isArray(entry.credentialKeys) ? entry.credentialKeys.filter((k) => typeof k === "string") : [],
    ...(install ? { install } : {}),
    ...(ruleRecords.length || ruleSkips.length ? { rules: { imported: ruleRecords.length, skipped: ruleSkips } } : {}),
  };
}

/** Import every entry of a validated envelope into the active workflow.
 * Sequential on purpose: an entry's occupancy/id checks must see what earlier
 * entries claimed. Per-entry error isolation honors the "one bad entry doesn't
 * sink the backup" contract for unexpected failures too (disk full, fs errors):
 * earlier entries stay imported and the failure is reported as a skip. */
export async function importConnectors(envelope: ConnectorExportEnvelope): Promise<ImportResult> {
  const ix = buildIndex(currentWorkflowId(), currentOrgId());
  const imported: ImportOutcome[] = [];
  const skipped: ImportSkip[] = [];
  for (const entry of envelope.connectors) {
    let r: ImportOutcome | ImportSkip;
    try {
      r = await importEntry(entry, ix);
    } catch (e) {
      const id = typeof entry?.config?.id === "string" ? entry.config.id : "(unknown)";
      r = { id, reason: "IMPORT_FAILED", message: (e as Error)?.message ?? "unexpected error" };
    }
    if ("reason" in r) skipped.push(r);
    else imported.push(r);
  }
  return { imported, skipped };
}
