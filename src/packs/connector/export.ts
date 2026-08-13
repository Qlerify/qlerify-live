// Portable connector export — the envelope served by GET /api/connectors/export
// and /api/connectors/:id/export. Designed for backup and cross-environment
// sharing, so a future import can recreate the connector elsewhere:
//   - tenancy (workflowId/organizationId) is stripped — import restamps it from
//     the request context, and must re-check the one-connector-per-table
//     invariant (TABLE_OCCUPIED) in the destination workflow;
//   - credentialsRef is stripped — it is a DERIVED env key (CRED_<org>_<wf>_<id>),
//     re-derived on import;
//   - credential VALUES never appear: the <id>.cred.json blob is not read here,
//     only credentialKeys() (field names), which tells an import which secrets
//     to prompt for;
//   - config fields are copied by ALLOW-LIST, never `...cfg` spread, so a future
//     AdapterConfig field cannot leak into exports unreviewed (pinned by test).
// Must stay independent of the loaded model (no resolveTargetSchema/getOntology):
// an orphaned connector — target table renamed away — still exports.

import type { AdapterConfig } from "../types.js";
import { readModule, readRuleFile, credentialKeys } from "./runtime.js";

export const CONNECTOR_EXPORT_FORMAT = "qlerify-connector-export";
export const CONNECTOR_EXPORT_VERSION = 1;

/** The portable subset of AdapterConfig. Everything environment- or tenant-
 * specific (workflowId, organizationId, credentialsRef, lastPullAt,
 * lastPullDurationMs, fixturesDir, bodyPath, bodyPromptHash) is deliberately
 * absent. */
export type ExportedConnectorConfig = Pick<AdapterConfig,
  | "id" | "kind" | "boundedContext" | "targetEntity" | "targetKind"
  | "phase" | "mode" | "instructions" | "deps" | "dateRoles"
  | "fieldMap" | "limits" | "endpoint" | "connectionOptionId">;

/** A per-event trigger rule, portable form: the code travels inline; the
 * content-hash file name + builtAt are re-derived on import. gwtHash is the
 * COMPILE-TIME hash — the destination compares it to its own model's GWTs, so
 * drift across environments surfaces as "stale" exactly like local drift. */
export interface ExportedTriggerRule {
  eventKey: string;
  eventRef: string;
  condition: string;
  gwtHash: string;
  author: "ai" | "human";
  code: string;
}

export interface ConnectorExportEntry {
  config: ExportedConnectorConfig;
  /** The connector module source; null when not built yet (draft phase). */
  code: string | null;
  /** Credential FIELD NAMES only — never values. */
  credentialKeys: string[];
  /** Per-event trigger rules (absent when the connector has none). Rules whose
   * module file is missing on disk are dropped — they were already broken. */
  rules?: ExportedTriggerRule[];
}

export interface ConnectorExportEnvelope {
  format: typeof CONNECTOR_EXPORT_FORMAT;
  version: typeof CONNECTOR_EXPORT_VERSION;
  exportedAt: string;
  connectors: ConnectorExportEntry[];
}

export function exportConnectorEntry(cfg: AdapterConfig): ConnectorExportEntry {
  const config: ExportedConnectorConfig = {
    id: cfg.id,
    kind: cfg.kind,
    boundedContext: cfg.boundedContext,
    targetEntity: cfg.targetEntity,
    targetKind: cfg.targetKind,
    phase: cfg.phase,
    mode: cfg.mode,
    instructions: cfg.instructions,
    deps: cfg.deps,
    dateRoles: cfg.dateRoles,
    fieldMap: cfg.fieldMap,
    limits: cfg.limits,
    endpoint: cfg.endpoint,
    connectionOptionId: cfg.connectionOptionId,
  };
  for (const k of Object.keys(config) as (keyof ExportedConnectorConfig)[]) {
    if (config[k] === undefined) delete config[k];
  }
  const rules: ExportedTriggerRule[] = [];
  for (const r of cfg.triggerRules ?? []) {
    const code = readRuleFile(r.file);
    if (code === null) continue;
    rules.push({ eventKey: r.eventKey, eventRef: r.eventRef, condition: r.condition, gwtHash: r.gwtHash, author: r.author, code });
  }
  return {
    config,
    code: readModule(cfg.id),
    credentialKeys: credentialKeys(cfg.id),
    ...(rules.length ? { rules } : {}),
  };
}

export function buildConnectorExport(cfgs: AdapterConfig[]): ConnectorExportEnvelope {
  return {
    format: CONNECTOR_EXPORT_FORMAT,
    version: CONNECTOR_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    connectors: cfgs.map(exportConnectorEntry),
  };
}
