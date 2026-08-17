// Connector lifecycle orchestration (Part 2.4). The thin layer the chat tools (and
// any HTTP route) call to drive the Lovable-style loop: create a connector for a
// system + kind, store its credentials, build/repair its code with AI, and remove
// it. Test + ingest reuse the standard SourceAdapter path (the connector adapter is
// a normal registry entry), so they live in tools.ts / ingest.ts unchanged.

import { getOntology } from "../../ontology/model.js";
import { periodKeyOf, periodFormatExample } from "../../twin/period.js";
import { cycleLinkFields, foreignKeyFields } from "../../twin/correlate.js";
import * as store from "../../twin/projection-store.js";
import { currentWorkflowId, currentOrgId } from "../../platform/tenancy/context.js";
import { getAdapter, registerAdapter, unregisterAdapter } from "../registry.js";
import { readSidecar, writeSidecar, deleteSidecar, listSidecars } from "../sidecar.js";
import { createConnectorAdapter, resolveTargetSchema } from "../adapters/connector.js";
import {
  generateConnectorModule, describeConnectorStructured, proposeDateRoles, timestampFields, PLATFORM_TIMESTAMP_COLS,
  type RelatedSchema,
} from "./codegen.js";
import type { EntitySchema } from "../../ontology/model.js";
import {
  writeModule, readModule, writeCredentials, readCredentials, credentialKeys, moduleExists,
  installDeps, scanImports, deleteConnectorFiles, type InstallResult,
} from "./runtime.js";
import {
  appendNote, setConnectorSummary, deleteChat, deleteDoc, connectorChatKey,
} from "./journal.js";
import type { AdapterBehavior, AdapterConfig } from "../types.js";

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
  try {
    const d = await describeConnectorStructured({
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
    // Only replace stored facets when the describe actually returned structured
    // JSON; a prose fallback keeps the prior facets (an empty {filters:[]} would
    // silently erase a real "Filters" manifest section the code still enforces).
    setConnectorSummary(id, d.summary, d.structured ? { filters: d.filters, ...(d.incremental ? { incremental: d.incremental } : {}) } : undefined);
  } catch {
    // Deterministic fallback keeps a summary present; stale facets are replaced
    // only by a successful describe, never wiped by a failed one.
    setConnectorSummary(id, fallbackSummary(cfg, keys));
  }
}

interface CreateConnectorInput {
  boundedContext: string;
  /** Entity or value-object name the connector populates. */
  target: string;
  id?: string;
  behavior?: AdapterBehavior;
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
    behavior: input.behavior ?? "sync",
    phase: "draft", mode: "live", workflowId, organizationId,
  };
  writeSidecar(cfg);
  registerAdapter(createConnectorAdapter(cfg));
  const behaviorNote = cfg.behavior === "sync" ? "" : ` It ${cfg.behavior === "actuator" ? "performs actions in another system" : "computes its rows"}.`;
  appendNote(id, "created", `Created connector targeting ${input.target} (${targetKind}) in ${bc}.${behaviorNote}`);
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

/** Schemas of the kinds the target's fields point at via `relatedEntity`, deduped.
 * Threaded into codegen so fabricated values for those fields come from the
 * related item's example values (the model's allowed vocabulary), not lookalikes
 * the code author invents. Exported for tests. */
export function relatedSchemasFor(target: EntitySchema): RelatedSchema[] {
  const o = getOntology();
  const out: RelatedSchema[] = [];
  const seen = new Set<string>();
  for (const f of target.fields) {
    if (!f.relatedEntity || seen.has(f.relatedEntity)) continue;
    seen.add(f.relatedEntity);
    const entity = o.entity(f.relatedEntity);
    const schema = entity ?? o.valueObject(f.relatedEntity);
    if (schema) out.push({ name: f.relatedEntity, kind: entity ? "entity" : "valueObject", schema });
  }
  return out;
}

/** The target table's lifecycle events (linear order) with their GWTs — what
 * the connector-builder prompt and the trigger-rule compiler both ground on.
 * Empty for value-object targets (events root on entities only). */
export function eventsForTarget(targetName: string): Array<{
  key: string; name: string; commandName: string; acceptanceCriteria: string[];
  siblings?: string[]; coupledTo?: string;
}> {
  const o = getOntology();
  const rooted = o.linearOrder()
    .map((k) => o.eventByKey(k))
    .filter((e) => !!e && e.aggregateRoot === targetName && !!e.commandName);
  return rooted.map((e) => {
    const siblings = rooted
      .filter((s) => s!.key !== e!.key && s!.commandName === e!.commandName)
      .map((s) => s!.name);
    return {
      key: e!.key,
      name: e!.name,
      commandName: e!.commandName,
      acceptanceCriteria: e!.acceptanceCriteria,
      ...(siblings.length ? { siblings } : {}),
      ...(e!.coupledTo ? { coupledTo: o.eventByKey(e!.coupledTo)?.name ?? e!.coupledTo } : {}),
    };
  });
}

interface BuildConnectorResult {
  deps: string[];
  install: InstallResult;
  bytes: number;
  targetKind: "entity" | "valueObject";
  /** Wall-clock ms of the whole build (codegen + npm install + summary LLMs). */
  durationMs: number;
}

/** Author (or repair) the connector's code with AI, install whatever npm packages
 * it imports, write the module, and re-register the adapter. Stop-and-show: this
 * does NOT run or ingest — the caller tests it next. */
export async function buildConnector(id: string, instructions?: string, errorReport?: string): Promise<BuildConnectorResult> {
  const t0 = Date.now();
  const cfg = readSidecar(id);
  if (!cfg) throw new Error(`no connector "${id}"`);
  const target = resolveTargetSchema(cfg.targetEntity);
  if (!target) throw new Error(`target "${cfg.targetEntity}" is not in the loaded model`);
  const targetKind: "entity" | "valueObject" = cfg.targetKind ?? (getOntology().entity(cfg.targetEntity) ? "entity" : "valueObject");
  const instr = (instructions ?? cfg.instructions ?? "").trim();

  // Cycle facts from the model (twin/period.ts): the author AI is told about
  // recurring cycles ONLY when the model declares them — as the cycle table
  // itself (a period-named composite key) or as a child linked into one.
  const pk = targetKind === "entity" ? periodKeyOf(target) : null;
  const childLinks = targetKind === "entity" ? cycleLinkFields(target.name, getOntology()) : [];
  // Event-chain (FK) facts, also from the model: fields that chain this table's
  // rows into a parent aggregate's case by id equality (twin/correlate.ts).
  // Cycle-claimed fields are excluded — the cycle sections own their guidance —
  // and each parent's REAL id values are sampled from the projection store so
  // the author AI sees the exact format the chain will be matched against.
  const cycleClaimed = new Set(childLinks.flatMap((l) => l.subjectFields.map((p) => p.child)));
  const fkLinks: Array<{ field: string; target: string; targetIdExamples: string[]; parentIsCycle?: boolean }> = [];
  if (targetKind === "entity") {
    for (const fk of foreignKeyFields(target.name, getOntology())) {
      if (cycleClaimed.has(fk.name)) continue;
      const targetIdExamples = (await store.tableExists(fk.target))
        ? (await store.findMany(fk.target, 3)).map((r) => String(r.id ?? "")).filter(Boolean)
        : [];
      const parent = getOntology().entity(fk.target);
      fkLinks.push({
        field: fk.name, target: fk.target, targetIdExamples,
        ...(parent && periodKeyOf(parent) ? { parentIsCycle: true } : {}),
      });
    }
  }
  const targetEvents = targetKind === "entity" ? eventsForTarget(target.name) : [];
  const gen = await generateConnectorModule({
    target, targetKind, behavior: cfg.behavior, instructions: instr,
    credentialKeys: credentialKeys(id), endpoint: cfg.endpoint, errorReport,
    related: relatedSchemasFor(target),
    ...(cfg.discoveredFields?.length ? { discoveredFields: cfg.discoveredFields } : {}),
    workflowTables: [...getOntology().entities, ...getOntology().valueObjects].map((e) => e.name),
    ...(targetEvents.length ? { events: targetEvents } : {}),
    ...(fkLinks.length ? { fkLinks } : {}),
    ...(pk
      ? {
          cycle: {
            subjectFields: pk.subjectFields,
            periodField: pk.periodField,
            granularity: pk.granularity,
            periodExample: periodFormatExample(pk.granularity),
          },
        }
      : {}),
    ...(childLinks.length
      ? {
          cycleChild: childLinks.map((l) => ({
            target: l.target,
            pairs: l.subjectFields,
            granularity: l.granularity,
            periodExample: periodFormatExample(l.granularity),
          })),
        }
      : {}),
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
  // Re-read the sidecar before writing: the LLM/npm awaits above leave a long
  // window in which a concurrent pull may have stamped lastPullAt — base the
  // write on the freshest copy so that stamp isn't clobbered.
  const latest = readSidecar(id) ?? cfg;
  const next: AdapterConfig = {
    ...latest, kind: "connector", targetKind, phase: "built", instructions: instr, deps: gen.deps,
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
  const durationMs = Date.now() - t0;
  appendNote(
    id,
    errorReport ? "repaired" : "built",
    errorReport
      ? `Repaired connector code after an error (${gen.code.length} bytes${depsNote}).`
      : `Built connector code (${gen.code.length} bytes${depsNote}).`,
    { durationMs },
  );
  return { deps: gen.deps, install, bytes: gen.code.length, targetKind, durationMs };
}

interface SaveConnectorCodeResult {
  deps: string[];
  install: InstallResult;
  bytes: number;
}

/** Persist operator-edited connector code (the Connectors "Code" tab). Mirrors the
 * tail of buildConnector — install whatever the code now imports, write the module,
 * refresh the sidecar's dep list + phase, re-register the adapter, and regenerate
 * the summary — but skips AI codegen: the operator's text IS the source. Stop-and-
 * show: it does NOT run or ingest; the caller tests it next (adapter_dry_run). */
export async function saveConnectorCode(id: string, code: string): Promise<SaveConnectorCodeResult> {
  const cfg = readSidecar(id);
  if (!cfg) throw new Error(`no connector "${id}"`);
  if (typeof code !== "string") throw new Error("code must be a string");
  const deps = scanImports(code);
  // Install first so a missing-package failure is reported now, not as a cryptic
  // "Cannot find package" on the next pull. The module is written regardless so a
  // failed install still leaves the operator's edit on disk to repair.
  const install = await installDeps(deps);
  writeModule(id, code);
  // Fresh read before write (see buildConnector): don't clobber a lastPullAt
  // stamped by a pull that ran during the npm install above.
  const next: AdapterConfig = { ...(readSidecar(id) ?? cfg), kind: "connector", phase: "built", deps };
  writeSidecar(next);
  registerAdapter(createConnectorAdapter(next));
  // Keep the description in step with the hand-edited code (best-effort; falls back
  // to a deterministic summary if the AI call fails or no key is configured).
  await regenerateConnectorSummary(id, code);
  const depsNote = deps.length ? `, deps: ${deps.join(", ")}` : "";
  appendNote(id, "edited", `Edited connector code by hand (${code.length} bytes${depsNote}).`);
  return { deps, install, bytes: code.length };
}

interface ConnectorInfo {
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

// --- Source-field discovery (the introspect() seam, made real) ---------------
// Sample the LIVE source through the built connector and record which fields it
// actually exposes — the union of row keys, an inferred dataType, one truncated
// example value each. Persisted on the sidecar (discoveredFields) so the next
// build prompt maps the source's real shape instead of guessing, and served by
// the adapter's introspect().

const DISCOVER_SAMPLE_ROWS = 5;
const DISCOVER_SAMPLE_CHARS = 120;

/** Field names whose sample VALUES are never recorded (name + inferred type
 * only): discovery persists samples to the sidecar and replays them into every
 * later build prompt, so a secret-bearing source field must not ride along.
 * Advisory, like the run-trace redaction — a secret under an innocuous name
 * still passes; this catches the conventional names. */
const SECRET_FIELD_RE = /(token|secret|passw|api[-_]?key|apikey|credential|private[-_]?key|authorization|bearer|ssn|session[-_]?id)/i;

/** Infer the field list from sampled source rows. Pure (unit-testable): keys in
 * first-seen order; the dataType comes from the first non-null value (nested
 * structure reads as "json"); the sample is JSON-encoded and truncated so a
 * long value can't bloat the sidecar or the build prompt — and omitted entirely
 * for secret-named fields. */
export function inferDiscoveredFields(rows: Array<Record<string, unknown>>): Array<{ name: string; dataType?: string; sample?: string }> {
  const byName = new Map<string, { name: string; dataType?: string; sample?: string }>();
  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      let f = byName.get(k);
      if (!f) { f = { name: k }; byName.set(k, f); }
      if (v === null || v === undefined || f.dataType !== undefined) continue;
      f.dataType =
        typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number")
        : typeof v === "boolean" ? "boolean"
        : typeof v === "object" ? "json"
        : "string";
      if (!SECRET_FIELD_RE.test(k)) f.sample = JSON.stringify(v).slice(0, DISCOVER_SAMPLE_CHARS);
    }
  }
  return [...byName.values()];
}

export interface DiscoverSourceResult {
  /** Rows in the sample the fields were observed on. */
  sampled: number;
  fields: Array<{ name: string; dataType?: string; sample?: string }>;
  /** Discovered names that match a model field (already land as columns). */
  modelFields: string[];
  /** Discovered names beyond the model — preserved in `_raw` at ingest. */
  extraFields: string[];
}

/** Run the connector against the live source with a small limit and persist the
 * observed field shape. Executes connector code — callers gate it exactly like
 * a dry run (ownership + connector capability + kill-switch). */
export async function discoverSourceFields(id: string): Promise<DiscoverSourceResult> {
  const cfg = readSidecar(id);
  const adapter = getAdapter(id);
  if (!cfg || !adapter) throw new Error(`no connector "${id}"`);
  const { rows } = await adapter.pull({ limit: DISCOVER_SAMPLE_ROWS });
  const sample = rows[cfg.targetEntity] ?? [];
  if (!sample.length) throw new Error("the source returned no rows to sample — nothing to discover (an incremental connector with no new items returns []; discovery needs a pull that yields rows)");
  const fields = inferDiscoveredFields(sample);
  const target = resolveTargetSchema(cfg.targetEntity);
  const declared = new Set((target?.fields ?? []).map((f) => f.name));
  // The model/extra split must mirror what INGEST will do, and ingest partitions
  // AFTER applying the sidecar fieldMap — so classify each raw source name by
  // the name it LANDS under. discoveredFields keep the raw source names (the
  // shape the build prompt maps FROM).
  const fieldMap = await adapter.mapping();
  const landedName = (n: string) => fieldMap[n] ?? n;
  const modelFields = fields.map((f) => f.name).filter((n) => declared.has(landedName(n)));
  const extraFields = fields.map((f) => f.name).filter((n) => !declared.has(landedName(n)));
  // Fresh-read → write, like every other sidecar mutator. Only a draft advances
  // to the reserved "introspected" phase — discovery after build/test/populate
  // must not regress the ladder.
  const latest = readSidecar(id) ?? cfg;
  const next: AdapterConfig = {
    ...latest,
    discoveredFields: fields,
    discoveredAt: new Date().toISOString(),
    ...(latest.phase === "draft" ? { phase: "introspected" as const } : {}),
  };
  // No re-registration needed: the registered adapter's introspect() fresh-reads
  // the sidecar, and nothing pull() consumes changed.
  writeSidecar(next);
  appendNote(id, "note", `Discovered ${fields.length} source field(s) from a ${sample.length}-row sample — ${modelFields.length} map to ${cfg.targetEntity}, ${extraFields.length} extra (preserved in _raw at ingest).`);
  return { sampled: sample.length, fields, modelFields, extraFields };
}

/** Read the connector's current source (for "show me the code"). */
export { readModule as readConnectorCode } from "./runtime.js";

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
