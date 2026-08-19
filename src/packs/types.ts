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

interface IntrospectResult {
  entity: string;
  fields: Array<{ name: string; dataType?: string; sample?: unknown }>;
}

/** Row ceiling substituted for an "uncapped" pull (`limit: null`). The module
 * body must always see a real number as ctx.limit: generated connector code
 * defends with `ctx.limit ?? <its own fallback>`, so a null would silently
 * shrink a full ingest to that fallback (a 1,000-row module default is how a
 * larger Cognito pool once ingested as exactly 1,000 rows, with no error). */
export const UNCAPPED_PULL_ROWS = 10_000;

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
  /** Fetch a batch, keyed by model entity, already field-mapped. `limit: null`
   * means a full ingest — pull everything the source returns, up to the
   * platform-wide UNCAPPED_PULL_ROWS ceiling. Omitted → the adapter's own
   * conservative default. */
  pull(opts?: { limit?: number | null }): Promise<PullResult>;
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
type AdapterPhase = "draft" | "introspected" | "mapped" | "built" | "tested" | "populated";

export interface AdapterSchedule {
  enabled: boolean;
  everyMinutes: number;
  failures?: number;
  /** Every attempt, unlike lastPullAt which only advances on success. */
  lastAttemptAt?: string;
  disabledReason?: string;
}

/** One AI-compiled (or hand-edited) per-event trigger rule owned by a connector.
 * The rule is a tiny pure predicate module (deny-scanned, zero imports) that
 * decides whether a row implies the event — replacing the kernel's static
 * evidence heuristic for exactly that event (twin/derive.ts, kind "authored").
 * Connector-owned by design: the rule is a build artifact of (the event's GWTs ×
 * this connector's field shape) and dies with the connector; the GWTs in the
 * model remain the durable truth a recreated connector recompiles from. */
export interface TriggerRule {
  /** OntologyEvent.key of the event this rule fires. */
  eventKey: string;
  /** OntologyEvent.ref — what the EventLog stores. */
  eventRef: string;
  /** The operator's natural-language condition the rule was compiled from
   * ("upsell deals over 20 000 USD in the current quarter"). */
  condition: string;
  /** sha256 of the event's acceptanceCriteria at compile time — GWT drift in the
   * model is surfaced (rule marked stale, still runs) by comparing against the
   * live model's hash. */
  gwtHash: string;
  /** Workspace-relative rule module filename (content-hash suffixed: a new
   * version is a NEW path — tsx caches modules by path, same as bodyPath). */
  file: string;
  /** The content hash embedded in `file`. */
  codeHash: string;
  builtAt: string;
  author: "ai" | "human";
  /** Soft-off: skipped at derive time but kept + surfaced (operator toggle, or
   * auto when the event vanished from the model — never silently dropped). */
  disabled?: boolean;
  disabledReason?: string;
}

/** What re-running a connector COSTS — the axis the platform has to behave
 * differently about. `kind` is the source technology (rest / dynamodb / …); this
 * is what the run DOES:
 *   sync      — mirrors a system of record. Re-running is free and changes nothing.
 *   generator — computes its rows (an AI call, a paid API). Re-running costs money.
 *   actuator  — performs an action in another system (creates a deal, sends mail)
 *               and lands the result. Re-running changes the outside world.
 *   extractor — reads an unstructured source (a doc, a sheet) and interprets it
 *               with AI. Re-running is safe but pays for the extraction again.
 * Absent = sync: every connector written before this existed only reads. */
export type AdapterBehavior = "sync" | "generator" | "actuator" | "extractor";

/** Persisted adapter config — `.qlerify/adapters/<id>.json`. `credentialsRef` is a
 * KEY (env var / vault handle), NEVER the secret itself. */
export interface AdapterConfig {
  id: string;
  kind: string;
  behavior?: AdapterBehavior;
  /** The product this connector actually talks to ("Slack", "HubSpot"), when it
   * differs from the bounded context. Every warning names the system it is about
   * to write to, and the bounded context is the MODEL's word for it: a Slack
   * connector modelled under "Notifications" would warn about writing to
   * "Notifications". Set by the assistant at build time, which knows the URL and
   * the credential; absent = the bounded context is already the right name. */
  targetSystem?: string;
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
  /** Wall-clock ms the last successful pull took (written with lastPullAt). */
  lastPullDurationMs?: number;
  schedule?: AdapterSchedule;
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
  /** Which model field carries the source's CREATION timestamp and which carries
   * its LAST-MODIFIED timestamp. A connector populates a current-state snapshot
   * row, which records at most these two real time anchors. Discovered at
   * build time (the source system is where this is known) and operator-overridable.
   * Consumed by twin/derive.ts to stamp create-kind events with `created` and
   * update-kind events with `updated` (falling back to `created`) — real dates
   * instead of ingestion-time `now`. Values are MODEL field names on the target
   * schema; absent → derive uses its first-date-field heuristic (unchanged). */
  dateRoles?: { created?: string; updated?: string };
  /** Per-event trigger rules this connector carries (see TriggerRule). Absent on
   * every pre-existing sidecar — connectors without rules run the static
   * evidence heuristics unchanged. */
  triggerRules?: TriggerRule[];
  /** The SOURCE's observed field shape — the union of row keys from a sampled
   * pull (orchestrate discoverSourceFields), with an inferred dataType and one
   * truncated example value per field. Distinct from the model schema: this is
   * what the source actually exposes. Threaded into the connector build prompt
   * so the author maps real fields instead of guessing, and served by the
   * adapter's introspect(). */
  discoveredFields?: Array<{ name: string; dataType?: string; sample?: string }>;
  /** When the discovery sample was taken (ISO). */
  discoveredAt?: string;
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
