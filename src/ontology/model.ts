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

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const QLERIFY_DIR = join(here, "..", "..", ".qlerify");

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SchemaField {
  name: string;
  description?: string;
  dataType?: string;
  exampleData?: unknown[];
  hideInForm?: boolean;
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
  /** Bounded context the event was declared in, e.g. "Helix". */
  boundedContext: string;
  /** Command schema name that triggers the event, e.g. "CreateDemand". */
  commandName: string;
  /** Read models (queries) projected from this event. */
  readModels: ReadModelRef[];
  /** Given/When/Then acceptance criteria, verbatim from the model. */
  acceptanceCriteria: string[];
  /** Keys of the events that must occur before this one (the DAG edges). */
  predecessors: string[];
}

export interface Ontology {
  version: number;
  boundedContexts: string[];
  roles: string[];
  events: OntologyEvent[];
  commands: CommandSchema[];
  entities: EntitySchema[];
  queries: QuerySchema[];
  eventByKey(key: string): OntologyEvent | undefined;
  eventByRef(ref: string): OntologyEvent | undefined;
  requireEventByRef(ref: string): OntologyEvent;
  command(name: string): CommandSchema | undefined;
  entity(name: string): EntitySchema | undefined;
  query(name: string): QuerySchema | undefined;
  boundedContextOf(aggregate: string): string | undefined;
  successorsOf(key: string): string[];
  /** Kahn topological order over the `follows` DAG; throws on a cycle. */
  topologicalOrder(): string[];
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

interface RawSchema {
  description?: string;
  required?: string[];
  fields?: SchemaField[];
}

interface RawSchemas {
  entities?: Record<string, RawSchema>;
  commands?: Record<string, RawSchema>;
  queries?: Record<string, Record<string, unknown>>;
  valueObjects?: Record<string, unknown>;
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

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export function loadOntology(qlerifyDir: string = QLERIFY_DIR): Ontology {
  const wf = readJson<RawWorkflow>(join(qlerifyDir, "workflow.json"));

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
  for (const [bc, ctx] of contexts) {
    for (const [key, raw] of Object.entries(ctx.domainEvents ?? {})) rawEvents.push({ key, raw, bc });
    Object.assign(rawEntities, ctx.schemas?.entities ?? {});
    Object.assign(rawCommands, ctx.schemas?.commands ?? {});
    Object.assign(rawQueries, ctx.schemas?.queries ?? {});
  }

  const commands: CommandSchema[] = Object.entries(rawCommands).map(([name, raw]) => ({
    name,
    required: raw.required ?? [],
    fields: raw.fields ?? [],
  }));
  const entities: EntitySchema[] = Object.entries(rawEntities).map(([name, raw]) => ({
    name,
    description: raw.description,
    required: raw.required ?? [],
    fields: raw.fields ?? [],
  }));
  const queries: QuerySchema[] = Object.entries(rawQueries).map(([name, raw]) => ({
    name,
    ...raw,
  }));

  const commandByName = new Map(commands.map((c) => [c.name, c]));
  const entityByName = new Map(entities.map((e) => [e.name, e]));
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
    };
  });

  const eventByKey = new Map(events.map((e) => [e.key, e]));
  for (const e of events) {
    for (const p of e.predecessors) {
      if (!eventByKey.has(p)) problems.push(`event ${e.key}: predecessor "${p}" does not exist`);
    }
  }

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
  const boundedContexts = contexts.map(([bc]) => bc).sort();

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

  return {
    version: wf.version ?? 0,
    boundedContexts,
    roles,
    events,
    commands,
    entities,
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
    query: (name) => queryByName.get(name),
    boundedContextOf: (aggregate) => aggregateToBc.get(aggregate),
    successorsOf: (key) => successors.get(key) ?? [],
    topologicalOrder,
  };
}

let cached: Ontology | undefined;

/** Memoized accessor — loads the model once per process. */
export function getOntology(): Ontology {
  if (!cached) cached = loadOntology();
  return cached;
}

/** Plain-data projection of the ontology, safe to serialize over HTTP. */
export function ontologyView(ontology: Ontology = getOntology()) {
  return {
    version: ontology.version,
    boundedContexts: ontology.boundedContexts,
    roles: ontology.roles,
    events: ontology.events,
    commands: ontology.commands,
    entities: ontology.entities,
    queries: ontology.queries,
  };
}
