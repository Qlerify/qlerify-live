// Pack + SourceAdapter interfaces (Part 2.2). A "pack" is one bounded context /
// source system; it bundles the authored layer (adapter today; commands, widgets,
// ingestion later) and is discovered by loadPacks(). The kernel stays
// model-generic; a pack is the OPTIONAL place real-source code lives.
//
// `pull()` returns rows already KEYED BY MODEL ENTITY and already field-mapped, so
// the generic projection store (twin/projection-store) + base command consume them
// unchanged — the adapter is the only thing that knows it talks to SAP/Cognito/etc.

import type { ProvMode } from "../twin/provenance.js";

export type { ProvMode };

/** A pulled batch, grouped by model entity name. */
export type RowsByEntity = Record<string, Array<Record<string, unknown>>>;

/** Source field name → model field name. Applied on pull so the model never has
 * to learn every source's naming (alias-first; the write-path rename is the
 * escalation, not the default). */
export type FieldMap = Record<string, string>;

/** Rename a source row's keys to model field names; unmapped keys pass through. */
export function applyFieldMap(row: Record<string, unknown>, fieldMap?: FieldMap): Record<string, unknown> {
  if (!fieldMap || Object.keys(fieldMap).length === 0) return { ...row };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[fieldMap[k] ?? k] = v;
  return out;
}

export interface IntrospectResult {
  entity: string;
  fields: Array<{ name: string; dataType?: string; sample?: unknown }>;
}

export interface PullResult {
  rows: RowsByEntity;
  count: number;
}

export interface SourceAdapter {
  id: string;
  kind: string; // 'simulated' | 'rest' | 'sap-odata' | 'cognito' | ...
  boundedContext: string;
  targetEntity: string;
  mode: ProvMode;
  /** Discover the source's shape (used by the wizard to propose a field map). */
  introspect(): Promise<IntrospectResult>;
  /** The source→model field map this adapter applies on pull. */
  mapping(): Promise<FieldMap>;
  /** Fetch a bounded batch, keyed by model entity, already field-mapped. */
  pull(opts?: { limit?: number }): Promise<PullResult>;
  /** Push model rows back to the source (envelope; no-op for simulated). */
  push(rows: RowsByEntity): Promise<{ pushed: number }>;
  healthcheck(): Promise<{ ok: boolean; detail?: string }>;
}

export interface Pack {
  /** Bounded context / source-system name. */
  name: string;
  adapters: SourceAdapter[];
}

/** The wizard's forward progress for an adapter (persisted in the sidecar). */
export type AdapterPhase = "draft" | "introspected" | "mapped" | "built" | "tested" | "populated";

/** Persisted adapter config — `.qlerify/adapters/<id>.json`. `credentialsRef` is a
 * KEY (env var / vault handle), NEVER the secret itself. */
export interface AdapterConfig {
  id: string;
  kind: string;
  boundedContext: string;
  targetEntity: string;
  phase: AdapterPhase;
  mode: ProvMode;
  /** Owning tenant — stamped at create from the request context so the Connectors
   * tab and the one-connector-per-table rule are scoped per workflow. Null/absent
   * on legacy sidecars created before scoping; those are adopted by the workflow
   * whose model defines their target table. */
  workflowId?: string | null;
  organizationId?: string | null;
  connectionOptionId?: string;
  credentialsRef?: string;
  fieldMap?: FieldMap;
  limits?: { pageSize?: number; limit?: number };
  lastPullAt?: string;
  fixturesDir?: string;
  // --- AI-authored adapter (Part 2.3, Slice 2) ---
  /** Configured source endpoint (passed to the body as ctx.endpoint). */
  endpoint?: string;
  /** Repo-relative path of the CURRENT generated body. Each regeneration writes a
   * UNIQUE path (content-hash suffix) — the `?v=mtime` cache-bust does NOT work
   * under tsx, so a fresh path is how the host sees new code. */
  bodyPath?: string;
  /** sha256 of the prompt that produced the current body (provenance/drift). */
  bodyPromptHash?: string;
  // --- Full-power connector (Part 2.4) — kind "connector" ---
  /** What `targetEntity` names: a model entity or a value object. Value-object
   * targets become their own gen_<VO> table when populated directly. */
  targetKind?: "entity" | "valueObject";
  /** The operator's latest natural-language description of the source. Persisted so
   * a repair/regeneration turn keeps the original intent. */
  instructions?: string;
  /** npm packages the connector module imports (detected from its imports and
   * installed into the connector workspace at build time). */
  deps?: string[];
}

/** Resolves a credentialsRef to the actual secret. Dev = env var; KeyVault later
 * (Part 5) behind the same interface. The secret never touches a sidecar. */
export interface CredentialResolver {
  resolve(ref: string): Promise<string | undefined>;
}

export const envCredentialResolver: CredentialResolver = {
  async resolve(ref: string) {
    return ref ? process.env[ref] : undefined;
  },
};
