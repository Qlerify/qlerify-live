// The Qlerify ontology, loaded at runtime from .qlerify/workflow.json.
//
// This is the single source of truth for the *declarative* layer of the
// domain: the domain-event graph (who follows whom), the role that emits each
// event, the command/aggregate/read-model each event is bound to, and the
// field schemas for commands and entities. Code that used to restate these
// facts (the event registry, role checks, command validation, the chat tools)
// should derive from here instead, so the model and the code cannot drift.
//
// The file is Qlerify's native export, kept verbatim — no flatten/normalize
// step. That export is rooted on one "primary" bounded context (`boundedContext`
// + `domainEvents` + `schemas`) with the rest nested under
// `externalBoundedContexts`. This application treats every bounded context
// equally, so the loader merges the primary and the external ones into one flat
// model: a single event set, a single schema set, each event tagged with the
// bounded context it came from. `$ref`s resolve by their terminal segment, so a
// same-context "#/domainEvents/X" and a cross-context
// "#/externalBoundedContexts/SAP/domainEvents/X" point at the same event.
//
// What is NOT here, because the model does not carry it: the simulator's
// linear 28-step ordering, the 5-act `phase` grouping, and the `derived` flag
// for rules-engine events. Those live as a thin overlay in events/registry.ts.

import { readFileSync, existsSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { currentWorkflowId, isSystemWorkflow } from "../platform/tenancy/context.js";
import { ModelNotLoadedError } from "../errors.js";

const here = dirname(fileURLToPath(import.meta.url));
/** Absolute path to the .qlerify directory holding workflow.json (and the
 * model fetch/version history). Exported so the model-sync module writes to
 * exactly the file this loader reads. */
export const QLERIFY_DIR = join(here, "..", "..", ".qlerify");

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SchemaField {
  name: string;
  description?: string;
  dataType?: string;
  exampleData?: unknown[];
  hideInForm?: boolean;
  /** True when the field holds a collection (array) of `relatedEntity` rows,
   * e.g. an invoice's line items. From the raw model's `array` flag. */
  array?: boolean;
  /** For object-typed fields: the entity / value-object whose schema describes
   * this field's row shape (resolved terminal name of the raw
   * `relatedEntity.$ref`), e.g. CartItem for `cartItems`. */
  relatedEntity?: string;
}

export interface CommandSchema {
  name: string;
  required: string[];
  fields: SchemaField[];
}

export interface EntitySchema {
  name: string;
  description?: string;
  required: string[];
  fields: SchemaField[];
}

export interface QuerySchema {
  name: string;
  [key: string]: unknown;
}

export interface ReadModelRef {
  name: string;
  description?: string;
}

export interface OntologyEvent {
  /** Stable key, e.g. "HardwareDemandCreated". */
  key: string;
  /** Canonical $ref, e.g. "#/domainEvents/HardwareDemandCreated". */
  ref: string;
  /** Human-readable name, e.g. "Hardware Demand Created". */
  name: string;
  /** Role/lane that emits the event, e.g. "Product Manager". */
  role: string;
  /** Aggregate-root entity name, e.g. "Demand". */
  aggregateRoot: string;
  /** Bounded context the event was declared in, e.g. "Sales". */
  boundedContext: string;
  /** Command schema name that triggers the event, e.g. "CreateDemand". */
  commandName: string;
  /** Read models (queries) projected from this event. */
  readModels: ReadModelRef[];
  /** Given/When/Then acceptance criteria, verbatim from the model. */
  acceptanceCriteria: string[];
  /** Keys of the events that must occur before this one (the DAG edges). */
  predecessors: string[];
  // --- Overlay-sourced (non-DDD) facts; see .qlerify/overlay.json ---
  /** Position in the demo's linear walk; undefined → ordered by topology. */
  order?: number;
  /** 5-act grouping the demo UI uses; undefined → 1. */
  phase?: number;
  /** True for rules-engine events emitted automatically (not a user action). */
  derived?: boolean;
}

export interface Ontology {
  version: number;
  /** UI title for the workflow: overlay.title, else the primary bounded context. */
  title: string;
  /** The primary bounded context (the export's root context). */
  primaryBoundedContext: string;
  /** The aggregate the workflow centers on — the root event's aggregate root.
   * Drives the dashboard's per-instance vocabulary (e.g. "Demand" / "User"). */
  rootAggregate: string;
  /** Overlay keys that don't match any current event (stale after a swap). */
  staleOverlayKeys: string[];
  boundedContexts: string[];
  roles: string[];
  events: OntologyEvent[];
  commands: CommandSchema[];
  entities: EntitySchema[];
  /** Value objects (embedded, id-less schemas, e.g. a campaign's TargetAudience).
   * Same shape as an entity; resolved as a related schema for object fields. */
  valueObjects: EntitySchema[];
  queries: QuerySchema[];
  eventByKey(key: string): OntologyEvent | undefined;
  eventByRef(ref: string): OntologyEvent | undefined;
  requireEventByRef(ref: string): OntologyEvent;
  command(name: string): CommandSchema | undefined;
  entity(name: string): EntitySchema | undefined;
  /** A value object by name (the related-schema lookup for object fields). */
  valueObject(name: string): EntitySchema | undefined;
  query(name: string): QuerySchema | undefined;
  boundedContextOf(aggregate: string): string | undefined;
  successorsOf(key: string): string[];
  /** Kahn topological order over the `follows` DAG; throws on a cycle. */
  topologicalOrder(): string[];
  /** Demo linearization: by overlay `order` where present, topology as the
   * tiebreaker / fallback. This replaces the old hardcoded STEP_SEQUENCE. */
  linearOrder(): string[];
}

// ---------------------------------------------------------------------------
// Raw (on-disk) shapes
// ---------------------------------------------------------------------------

interface RawRef {
  $ref: string;
}

interface RawEvent {
  event: string;
  role: string;
  follows?: Array<string | RawRef>;
  command?: RawRef;
  aggregateRoot?: RawRef;
  readModels?: Array<RawRef & { description?: string }>;
  acceptanceCriteria?: string[];
}

/** On-disk field shape. Like SchemaField but `relatedEntity` is a raw `$ref`
 * (normalized to a terminal name by normalizeField). */
interface RawSchemaField {
  name: string;
  description?: string;
  dataType?: string;
  exampleData?: unknown[];
  hideInForm?: boolean;
  array?: boolean;
  relatedEntity?: RawRef;
}

interface RawSchema {
  description?: string;
  required?: string[];
  fields?: RawSchemaField[];
}

interface RawSchemas {
  entities?: Record<string, RawSchema>;
  commands?: Record<string, RawSchema>;
  queries?: Record<string, Record<string, unknown>>;
  valueObjects?: Record<string, RawSchema>;
}

/** A bounded context's contribution: its events and its schemas. The primary
 * context carries these at the top level; each external one nests them. */
interface RawContext {
  domainEvents?: Record<string, RawEvent>;
  schemas?: RawSchemas;
}

interface RawWorkflow extends RawContext {
  version?: number;
  /** Primary bounded-context name in the native export. */
  boundedContext?: string;
  /** Pre-flattened files (legacy) list contexts here instead. */
  boundedContexts?: string[];
  roles?: string[];
  externalBoundedContexts?: Record<string, RawContext>;
}

/** .qlerify/overlay.json — non-DDD facts keyed by domain-event key. */
interface RawOverlay {
  /** Human title for the whole workflow (UI header). Defaults to the primary
   * bounded context when omitted. */
  title?: string;
  /** The aggregate the workflow centers on (drives per-instance UI vocabulary).
   * Defaults to a heuristic (the first root event's aggregate) when omitted. */
  rootAggregate?: string;
  events?: Record<string, { order?: number; phase?: number; derived?: boolean }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Last path segment of a $ref. Works for both same-context and cross-context
 * refs: "#/domainEvents/X" and "#/externalBoundedContexts/SAP/domainEvents/X"
 * both resolve to "X". */
function refTail(ref: string): string {
  const i = ref.lastIndexOf("/");
  return i >= 0 ? ref.slice(i + 1) : ref;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

/** Raw on-disk field → public SchemaField: resolve `relatedEntity.$ref` to its
 * terminal name and carry the `array` flag, dropping nothing else. */
function normalizeField(f: RawSchemaField): SchemaField {
  return {
    name: f.name,
    description: f.description,
    dataType: f.dataType,
    exampleData: f.exampleData,
    hideInForm: f.hideInForm,
    ...(f.array ? { array: true } : {}),
    ...(f.relatedEntity ? { relatedEntity: refTail(f.relatedEntity.$ref) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/** Read the optional overlay sidecar. A missing file is fine (returns {}); a
 * malformed one throws, which (via reloadOntology) leaves the previous model in
 * place — the same fail-soft contract as a malformed workflow.json. */
function readOverlay(qlerifyDir: string): RawOverlay {
  const path = join(qlerifyDir, "overlay.json");
  if (!existsSync(path)) return {};
  return readJson<RawOverlay>(path);
}

export function loadOntology(qlerifyDir: string = QLERIFY_DIR): Ontology {
  const wf = readJson<RawWorkflow>(join(qlerifyDir, "workflow.json"));
  const overlay = readOverlay(qlerifyDir);
  return buildOntology(wf, overlay);
}

/** Build an Ontology from parsed workflow + overlay STRINGS (no fs). The disk
 * loader above and the per-workflow content loader (a workflow's model lives in the
 * content-addressed store, not on disk) both funnel through buildOntology. */
export function loadOntologyFromStrings(workflowJson: string, overlayJson: string | null): Ontology {
  const wf = JSON.parse(workflowJson) as RawWorkflow;
  const overlay = (overlayJson ? JSON.parse(overlayJson) : {}) as RawOverlay;
  return buildOntology(wf, overlay);
}

function buildOntology(wf: RawWorkflow, overlay: RawOverlay): Ontology {
  const overlayEvents = overlay.events ?? {};

  // Every bounded context as an equal (name, contribution) pair: the primary
  // first, then each external one. The primary's name defaults to "Primary"
  // only if the export omits it (it never does in practice).
  const contexts: Array<[string, RawContext]> = [[wf.boundedContext ?? "Primary", wf]];
  for (const [name, ctx] of Object.entries(wf.externalBoundedContexts ?? {})) {
    contexts.push([name, ctx]);
  }

  // Merge each context's events (tagged with its bounded context) and schemas.
  // Primary is merged first; externals layer on top, so an entity's "home"
  // context wins over a reference copy carried by the primary.
  const rawEvents: Array<{ key: string; raw: RawEvent; bc: string }> = [];
  const rawEntities: Record<string, RawSchema> = {};
  const rawCommands: Record<string, RawSchema> = {};
  const rawQueries: Record<string, Record<string, unknown>> = {};
  const rawValueObjects: Record<string, RawSchema> = {};
  for (const [bc, ctx] of contexts) {
    for (const [key, raw] of Object.entries(ctx.domainEvents ?? {})) rawEvents.push({ key, raw, bc });
    Object.assign(rawEntities, ctx.schemas?.entities ?? {});
    Object.assign(rawCommands, ctx.schemas?.commands ?? {});
    Object.assign(rawQueries, ctx.schemas?.queries ?? {});
    Object.assign(rawValueObjects, ctx.schemas?.valueObjects ?? {});
  }

  const commands: CommandSchema[] = Object.entries(rawCommands).map(([name, raw]) => ({
    name,
    required: raw.required ?? [],
    fields: (raw.fields ?? []).map(normalizeField),
  }));
  const entities: EntitySchema[] = Object.entries(rawEntities).map(([name, raw]) => ({
    name,
    description: raw.description,
    required: raw.required ?? [],
    fields: (raw.fields ?? []).map(normalizeField),
  }));
  // Value objects share the entity shape (id-less, embedded). They back object
  // fields via `relatedEntity` (e.g. Campaign.targetAudience → TargetAudience).
  const valueObjects: EntitySchema[] = Object.entries(rawValueObjects).map(([name, raw]) => ({
    name,
    description: raw.description,
    required: raw.required ?? [],
    fields: (raw.fields ?? []).map(normalizeField),
  }));
  const queries: QuerySchema[] = Object.entries(rawQueries).map(([name, raw]) => ({
    name,
    ...raw,
  }));

  const commandByName = new Map(commands.map((c) => [c.name, c]));
  const entityByName = new Map(entities.map((e) => [e.name, e]));
  const valueObjectByName = new Map(valueObjects.map((v) => [v.name, v]));
  const queryByName = new Map(queries.map((q) => [q.name, q]));

  const problems: string[] = [];

  const events: OntologyEvent[] = rawEvents.map(({ key, raw, bc }) => {
    const aggregateRoot = raw.aggregateRoot ? refTail(raw.aggregateRoot.$ref) : "";
    const commandName = raw.command ? refTail(raw.command.$ref) : "";
    const readModels: ReadModelRef[] = (raw.readModels ?? []).map((rm) => ({
      name: refTail(rm.$ref),
      description: rm.description,
    }));
    const predecessors = (raw.follows ?? [])
      .filter((f): f is RawRef => typeof f === "object" && f !== null && "$ref" in f)
      .map((f) => refTail(f.$ref));

    if (!aggregateRoot) problems.push(`event ${key}: missing aggregateRoot`);
    else if (!entityByName.has(aggregateRoot)) problems.push(`event ${key}: aggregateRoot "${aggregateRoot}" is not a known entity`);
    if (!commandName) problems.push(`event ${key}: missing command`);
    else if (!commandByName.has(commandName)) problems.push(`event ${key}: command "${commandName}" is not a known command`);
    for (const rm of readModels) {
      if (!queryByName.has(rm.name)) problems.push(`event ${key}: read model "${rm.name}" is not a known query`);
    }

    const ov = overlayEvents[key];
    return {
      key,
      ref: `#/domainEvents/${key}`,
      name: raw.event,
      role: raw.role,
      aggregateRoot,
      boundedContext: bc,
      commandName,
      readModels,
      acceptanceCriteria: raw.acceptanceCriteria ?? [],
      predecessors,
      ...(ov?.order !== undefined ? { order: ov.order } : {}),
      ...(ov?.phase !== undefined ? { phase: ov.phase } : {}),
      ...(ov?.derived ? { derived: true } : {}),
    };
  });

  const eventByKey = new Map(events.map((e) => [e.key, e]));
  for (const e of events) {
    for (const p of e.predecessors) {
      if (!eventByKey.has(p)) problems.push(`event ${e.key}: predecessor "${p}" does not exist`);
    }
  }
  // Overlay keys that no longer resolve to a model event are IGNORED, not fatal:
  // after a model swap the old overlay is naturally stale, and it must never
  // block the new model from loading. Unknown keys simply don't apply (events
  // fall back to topological order / phase 1); `staleOverlayKeys` surfaces them
  // (e.g. /sim/registry-status) so the overlay can be regenerated via the swap.
  const staleOverlayKeys = Object.keys(overlayEvents).filter((k) => !eventByKey.has(k));

  if (problems.length > 0) {
    throw new Error(`Invalid Qlerify ontology (${problems.length} problem(s)):\n  - ${problems.join("\n  - ")}`);
  }

  const successors = new Map<string, string[]>(events.map((e) => [e.key, []]));
  for (const e of events) {
    for (const p of e.predecessors) successors.get(p)!.push(e.key);
  }

  // aggregate-root → bounded context, derived from the events themselves.
  const aggregateToBc = new Map<string, string>();
  for (const e of events) if (e.aggregateRoot) aggregateToBc.set(e.aggregateRoot, e.boundedContext);

  const roles = wf.roles ?? [...new Set(events.map((e) => e.role))].sort();
  const primaryBoundedContext = contexts[0]?.[0] ?? "Workflow";
  const boundedContexts = contexts.map(([bc]) => bc).sort();
  // An overlay whose event keys don't match this model belongs to a PREVIOUSLY
  // loaded model — its title/rootAggregate overrides are stale and must be
  // ignored (the model-switch "stale labels" bug). Require a MAJORITY of the
  // overlay's keys to resolve: a single shared event key (e.g. ProjectCreated,
  // which can appear in two unrelated models) must NOT make a foreign
  // overlay look like it belongs here.
  const overlayKeys = Object.keys(overlayEvents);
  const matchingKeys = overlayKeys.filter((k) => eventByKey.has(k)).length;
  const overlayForThisModel = overlayKeys.length === 0 || matchingKeys / overlayKeys.length >= 0.5;
  const title = (overlayForThisModel && overlay.title) || primaryBoundedContext;

  function topologicalOrder(): string[] {
    const indegree = new Map(events.map((e) => [e.key, e.predecessors.length]));
    const queue = events.filter((e) => indegree.get(e.key) === 0).map((e) => e.key);
    const order: string[] = [];
    while (queue.length > 0) {
      const k = queue.shift()!;
      order.push(k);
      for (const s of successors.get(k) ?? []) {
        const d = (indegree.get(s) ?? 0) - 1;
        indegree.set(s, d);
        if (d === 0) queue.push(s);
      }
    }
    if (order.length !== events.length) {
      throw new Error("Qlerify ontology has a cycle in the domain-event `follows` graph");
    }
    return order;
  }

  // Fail fast if the graph is not a DAG.
  topologicalOrder();

  // The aggregate the workflow centers on: an explicit overlay.rootAggregate if
  // given, else a heuristic (first root event's aggregate in linear order, then
  // the first event's, then the first entity).
  const rootAggregate =
    (overlayForThisModel && overlay.rootAggregate) ||
    // The aggregate of the FIRST step in the workflow (the entry point), then the
    // first DAG-root event's, then the first entity.
    eventByKey.get(linearOrder()[0] ?? "")?.aggregateRoot ||
    linearOrder().map((k) => eventByKey.get(k)!).find((e) => e.predecessors.length === 0)?.aggregateRoot ||
    entities[0]?.name ||
    "Item";

  function linearOrder(): string[] {
    const topo = topologicalOrder();
    const topoIndex = new Map(topo.map((k, i) => [k, i]));
    return events
      .map((e) => e.key)
      .sort((a, b) => {
        const ea = eventByKey.get(a)!;
        const eb = eventByKey.get(b)!;
        const oa = ea.order ?? Number.POSITIVE_INFINITY;
        const ob = eb.order ?? Number.POSITIVE_INFINITY;
        if (oa !== ob) return oa - ob;
        return topoIndex.get(a)! - topoIndex.get(b)!;
      });
  }

  return {
    version: wf.version ?? 0,
    title,
    primaryBoundedContext,
    rootAggregate,
    staleOverlayKeys,
    boundedContexts,
    roles,
    events,
    commands,
    entities,
    valueObjects,
    queries,
    eventByKey: (key) => eventByKey.get(key),
    eventByRef: (ref) => eventByKey.get(refTail(ref)),
    requireEventByRef: (ref) => {
      const event = eventByKey.get(refTail(ref));
      if (!event) throw new Error(`unknown domain-event ref: ${ref}`);
      return event;
    },
    command: (name) => commandByName.get(name),
    entity: (name) => entityByName.get(name),
    valueObject: (name) => valueObjectByName.get(name),
    query: (name) => queryByName.get(name),
    boundedContextOf: (aggregate) => aggregateToBc.get(aggregate),
    successorsOf: (key) => successors.get(key) ?? [],
    topologicalOrder,
    linearOrder,
  };
}

let cached: Ontology | undefined;

/** A valid but EMPTY ontology — the "no model loaded" baseline (zero events,
 * entities, commands, roles). Returned by the system path when there is no model
 * on disk, so boot, module-load (the event registry, the chat system prompt) and
 * every system-context getOntology() caller keep working instead of crashing.
 * There is no preset/demo model anymore — a workflow's model arrives only via
 * the per-workflow set-model flow (PUT /v1/workflow/model). */
export function emptyOntology(): Ontology {
  return buildOntology({ boundedContext: "Uninitialized", domainEvents: {}, schemas: {}, roles: [] }, {});
}

// --- Per-workflow model resolution -------------------------------------------
// The live model is scoped to the ACTIVE workflow (currentWorkflowId from ALS).
// Every workflow's model content is bound via setWorkflowModel() by the request
// pipeline (the onRequest hook loads it from the content-addressed store BEFORE
// the handler runs, so the sync getOntology() never has to do I/O). The system
// context (no request / boot / module-load) resolves to the empty ontology
// unless a model has been placed on disk (none is, by default).

/** The system-context model. Empty unless a workflow.json happens to be on disk
 * (none is shipped — the preset demo was removed). Memoized for the process. */
function getSystemOntology(): Ontology {
  if (!cached) {
    cached = existsSync(join(QLERIFY_DIR, "workflow.json")) ? loadOntology() : emptyOntology();
  }
  return cached;
}

// workflowId → bound content; parsed Ontology cache keyed by `${workflowId}::${hash}`
// (the hash is immutable, so a cache entry is never stale).
const workflowContent = new Map<string, { workflow: string; overlay: string | null; hash: string }>();
const parsedByKey = new Map<string, Ontology>();
const PARSED_CACHE_MAX = 32;

const WORKFLOW_CONTENT_MAX = 64;

/** Bind a workflow's current model content (called before the handler runs).
 * Bounded LRU-ish so a long-lived process serving many workflows doesn't grow the
 * content map without limit. */
export function setWorkflowModel(workflowId: string, workflow: string, overlay: string | null, hash: string): void {
  if (workflowContent.has(workflowId)) workflowContent.delete(workflowId); // move to most-recent
  workflowContent.set(workflowId, { workflow, overlay, hash });
  while (workflowContent.size > WORKFLOW_CONTENT_MAX) {
    const oldest = workflowContent.keys().next().value;
    if (oldest === undefined) break;
    workflowContent.delete(oldest);
  }
}

/** Evict a workflow's bound model from the in-memory caches (its content binding
 * and any parsed Ontology keyed by it). Called when a workflow is deleted so a
 * stale entry can't linger for a reused id. */
export function forgetWorkflowModel(workflowId: string): void {
  workflowContent.delete(workflowId);
  for (const k of [...parsedByKey.keys()]) {
    if (k.startsWith(`${workflowId}::`)) parsedByKey.delete(k);
  }
}

/** Cache key for the ACTIVE workflow's model — also used by registry.events() so
 * events resolve per workflow. System uses a stable "system" key (its derived
 * caches are cleared on reload). */
export function ontologyCacheKey(): string {
  if (isSystemWorkflow()) return "system";
  const pid = currentWorkflowId();
  const c = workflowContent.get(pid);
  return c ? `${pid}::${c.hash}` : `${pid}::unloaded`;
}

function evictParsed(): void {
  if (parsedByKey.size <= PARSED_CACHE_MAX) return;
  for (const k of parsedByKey.keys()) {
    if (k === "system") continue; // never evict the demo
    parsedByKey.delete(k);
    if (parsedByKey.size <= PARSED_CACHE_MAX) break;
  }
}

/** The live model for the active workflow. System → disk; other workflows → their
 * bound CAS content. A non-system workflow whose content is not loaded throws
 * (never silently serves the demo model — the onRequest hook must bind it). */
export function getOntology(): Ontology {
  if (isSystemWorkflow()) return getSystemOntology();
  const pid = currentWorkflowId();
  const c = workflowContent.get(pid);
  if (!c) throw new ModelNotLoadedError();
  const key = `${pid}::${c.hash}`;
  let o = parsedByKey.get(key);
  if (!o) {
    o = loadOntologyFromStrings(c.workflow, c.overlay);
    parsedByKey.set(key, o);
    evictParsed();
  }
  return o;
}

/** Plain-data projection of the ontology, safe to serialize over HTTP. */
export function ontologyView(ontology: Ontology = getOntology()) {
  return {
    version: ontology.version,
    title: ontology.title,
    primaryBoundedContext: ontology.primaryBoundedContext,
    rootAggregate: ontology.rootAggregate,
    boundedContexts: ontology.boundedContexts,
    roles: ontology.roles,
    events: ontology.events,
    commands: ontology.commands,
    entities: ontology.entities,
    queries: ontology.queries,
  };
}

// ---------------------------------------------------------------------------
// Hot reload — re-read the model when .qlerify/workflow.json changes, without
// restarting the process. Derived snapshots that are captured at import time
// (events/registry.ts EVENTS, chat/system-prompt.ts SYSTEM_BLOCKS) subscribe
// via onOntologyReload and rebuild themselves once the new model is in place.
// ---------------------------------------------------------------------------

const reloadListeners = new Set<() => void>();

/** Register a callback to run after each reload (in registration order, after
 * the new model is swapped in). Returns an unsubscribe function. */
export function onOntologyReload(listener: () => void): () => void {
  reloadListeners.add(listener);
  return () => reloadListeners.delete(listener);
}

/** Re-read the model from disk and swap it in. If the file is mid-write or
 * invalid, loadOntology throws and the previous model is left untouched. */
export function reloadOntology(): Ontology {
  const next = loadOntology(); // throws → `cached` unchanged
  cached = next;
  for (const listener of reloadListeners) listener();
  return next;
}

interface WatchLogger {
  info?(...args: unknown[]): void;
  error?(...args: unknown[]): void;
}

let watching = false;

/** Watch .qlerify for changes to workflow.json and hot-reload on change.
 * Idempotent and opt-out via ONTOLOGY_WATCH=off. Watching the directory (not
 * the file) survives atomic-rename saves and re-downloads. Writes are debounced
 * so a multi-event save reloads once, and a failed parse keeps the old model. */
export function startOntologyWatch(log?: WatchLogger): void {
  if (watching || process.env.ONTOLOGY_WATCH === "off") return;
  watching = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  watch(QLERIFY_DIR, (_event, filename) => {
    if (filename && filename !== "workflow.json" && filename !== "overlay.json") return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        reloadOntology();
        log?.info?.("ontology hot-reloaded from .qlerify/workflow.json");
      } catch (err) {
        log?.error?.({ err }, "ontology reload failed — keeping previous model");
      }
    }, 150);
  });
}
