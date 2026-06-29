// The generic base command — the deterministic fallback that makes a brand-new
// command WORK the moment the model defines it, with zero AI. When a command has
// no authored {cmd}.logic.ts, the generator writes a thin stub that delegates
// here (see kernel/codegen/emit.ts logicStubContent). The base reads the LIVE
// ontology by command name on every call, so it is hot-reload-correct.
//
// What it does (design: workflow generic-base-command-design, 2026-06-14):
//   • CREATE vs UPDATE is decided by hard evidence — a row for args.id means
//     UPDATE; "the command carries an id" is the primary shape signal; the
//     DAG-root test is only a tie-breaker for the id-given-but-missing case.
//   • CREATE builds a full, valid row: command args mapped onto entity columns,
//     remaining REQUIRED columns filled from the entity field's exampleData[0]
//     (type-coerced), id generated if absent, and `status` seeded from its
//     exampleData[0] (the canonical initial state). Unfillable required column →
//     soft DomainError (422), never a raw NOT-NULL 500.
//   • UPDATE patches only the fields the command carries, with an optimistic
//     lock; it NEVER advances `status` — lifecycle transitions are exactly the
//     authored .logic.ts (e.g. order-material's DRAFT→ORDERED).
//   • Everything emits through the existing emit(), so the event log, fan-out and
//     scope resolution are byte-identical to authored commands.
//
// Authoring a real {cmd}.logic.ts cleanly replaces this (the generator never
// overwrites an existing logic file).

import { prisma } from "../db.js";
import { emit } from "../events/bus.js";
import { DomainError, NotFoundError } from "../errors.js";
import { newId } from "../util/ids.js";
import { getOntology, type Ontology, type OntologyEvent, type EntitySchema } from "../ontology/model.js";
import * as store from "../twin/projection-store.js";
import type { CommandContext, DetectInput, DetectResult } from "./runtime.js";

// ---------------------------------------------------------------------------
// Binding + small helpers
// ---------------------------------------------------------------------------

interface Binding {
  ont: Ontology;
  event: OntologyEvent;
  entity: EntitySchema;
  table: string;
}

/** Resolve the model binding for a command + its projection table. Re-derived on
 * every call (no module-load cache) so a hot-reloaded model is honored. The table
 * is a raw-SQL projection (twin/projection-store), so a freshly-applied model is
 * usable with no codegen / restart. Throws DomainError if a piece is missing. */
async function resolveBinding(commandName: string, eventRef?: string): Promise<Binding> {
  const ont = getOntology();
  // Prefer the EXACT event the caller named (the simulator steps through events,
  // not commands). Several events can share one command — e.g. two "Approval
  // process completed" steps both bound to UpdateStatus — so resolving by command
  // name alone always picks the first, and firing the second would re-emit the
  // first (the stepped run wedges, never advancing). The plain command path passes
  // no eventRef and keeps the first-event-by-command fallback.
  const byRef = eventRef ? ont.eventByRef(eventRef) : undefined;
  const event =
    (byRef && byRef.commandName === commandName ? byRef : undefined) ??
    ont.events.find((e) => e.commandName === commandName);
  if (!event) throw new DomainError(`no model event binds command "${commandName}"`);
  const entity = ont.entity(event.aggregateRoot);
  if (!entity) throw new DomainError(`command "${commandName}" aggregate "${event.aggregateRoot}" is not a known entity`);
  const table = store.tableFor(entity);
  // Lazily create the projection table in the ACTIVE workflow's namespace if it
  // doesn't exist yet. Each workflow's data plane is built on demand (idempotent),
  // so a fresh workflow — which has no system-style model "apply" path — gets its
  // tables on first write. The system workflow's tables already exist from apply,
  // so this is a no-op for the demo.
  await store.ensureTable(entity);
  return { ont, event, entity, table };
}

const PLATFORM = new Set(["version", "createdAt", "updatedAt"]);

/** True when this event is the first to touch its own aggregate in the follows
 * DAG (no transitive predecessor shares its aggregateRoot) — the create-shape
 * tie-breaker. */
function isCreateEvent(event: OntologyEvent, ont: Ontology): boolean {
  const seen = new Set<string>();
  const stack = [...event.predecessors];
  while (stack.length) {
    const k = stack.pop()!;
    if (seen.has(k)) continue;
    seen.add(k);
    const pe = ont.eventByKey(k);
    if (!pe) continue;
    if (pe.aggregateRoot === event.aggregateRoot) return false;
    stack.push(...pe.predecessors);
  }
  return true;
}

function commandHasId(commandName: string, ont: Ontology): boolean {
  const c = ont.command(commandName);
  if (!c) return false;
  return (c.required ?? []).includes("id") || c.fields.some((f) => f.name === "id");
}

type Coerced = { ok: true; value: unknown } | { ok: false };

/** Coerce a raw value to the column's type. Keys off the ENTITY field dataType
 * because exampleData is stored as strings even for numeric columns. Returns
 * ok:false (rather than throwing) so the caller can mark a field unfillable and
 * refuse the insert instead of writing garbage. */
function coerce(raw: unknown, dataType?: string): Coerced {
  switch ((dataType ?? "string").toLowerCase()) {
    case "number":
    case "integer": {
      const n = Number(raw);
      return Number.isFinite(n) ? { ok: true, value: Math.trunc(n) } : { ok: false };
    }
    case "float":
    case "decimal": {
      const n = Number(raw);
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false };
    }
    case "boolean":
      return { ok: true, value: raw === true || raw === "true" || raw === "1" };
    case "object":
      return { ok: true, value: typeof raw === "string" ? raw : JSON.stringify(raw) };
    default:
      return { ok: true, value: String(raw) };
  }
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

async function classify(
  commandName: string,
  args: Record<string, unknown>,
  b: Binding,
): Promise<"create" | "update"> {
  const id = typeof args.id === "string" && args.id ? args.id : null;
  if (id) {
    const existing = await store.findById(b.table, id);
    if (existing) return "update"; // also makes a re-supplied id idempotent (no double create)
    if (isCreateEvent(b.event, b.ont)) return "create";
    throw new NotFoundError(`${b.entity.name} ${id} not found`);
  }
  // No id supplied.
  if (isCreateEvent(b.event, b.ont)) return "create";
  throw new DomainError(`cannot locate aggregate to update for "${commandName}": no id supplied`);
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

export async function genericApply<TArgs extends Record<string, unknown>>(
  commandName: string,
  ctx: CommandContext<TArgs>,
): Promise<unknown> {
  const b = await resolveBinding(commandName, ctx.eventRef);
  const args = ctx.args as Record<string, unknown>;
  const mode = await classify(commandName, args, b);
  return mode === "create" ? doCreate(b, args, ctx.role) : doUpdate(b, args, ctx.role);
}

async function doCreate(b: Binding, args: Record<string, unknown>, role: string): Promise<unknown> {
  const { entity, table } = b;
  const required = new Set(entity.required ?? []);
  const id = typeof args.id === "string" && args.id ? args.id : newId(entity.name.toLowerCase().slice(0, 8));
  const data: Record<string, unknown> = {};
  const unfillable: string[] = [];

  for (const f of entity.fields) {
    const name = f.name;
    if (name === "id") {
      data.id = id;
      continue;
    }
    const provided = args[name] !== undefined;

    // status: seed the canonical initial state from exampleData[0] when not
    // supplied; NEVER guess a transition (that is authored logic).
    if (name === "status" && !provided) {
      const ex = f.exampleData?.[0];
      if (ex === undefined) {
        if (required.has(name)) unfillable.push(name);
        continue;
      }
      const c = coerce(ex, f.dataType);
      if (c.ok) data[name] = c.value;
      else if (required.has(name)) unfillable.push(name);
      continue;
    }

    if (provided) {
      const c = coerce(args[name], f.dataType);
      if (c.ok) data[name] = c.value;
      else if (required.has(name)) unfillable.push(name);
      continue;
    }

    // Not provided: fill REQUIRED columns from exampleData; omit optional ones.
    if (required.has(name) && !PLATFORM.has(name)) {
      const ex = f.exampleData?.[0];
      if (ex === undefined) {
        unfillable.push(name);
        continue;
      }
      const c = coerce(ex, f.dataType);
      if (c.ok) data[name] = c.value;
      else unfillable.push(name);
    }
  }

  if (unfillable.length > 0) {
    throw new DomainError(
      `cannot create ${entity.name}: required field(s) [${unfillable.join(", ")}] have no value (no arg, no usable exampleData)`,
    );
  }

  let row: any;
  try {
    row = await store.insert(table, data);
  } catch (e: any) {
    if (/UNIQUE constraint/i.test(String(e?.message))) throw new DomainError(`${entity.name} ${id} already exists`);
    throw e;
  }
  await emitFor(b, row, args, role);
  return row;
}

async function doUpdate(b: Binding, args: Record<string, unknown>, role: string): Promise<unknown> {
  const { entity, table, event, ont } = b;
  const id = args.id;
  if (typeof id !== "string" || !id) throw new DomainError(`${event.commandName} requires an id`);
  let row: any = await store.findById(table, id);
  if (!row) throw new NotFoundError(`${entity.name} ${id} not found`);

  // Patch only the command's own non-id, non-status fields that are real
  // entity columns. status is never set here (lifecycle = authored logic).
  const command = ont.command(event.commandName);
  const entityCols = new Map(entity.fields.map((f) => [f.name, f.dataType]));
  const changes: Record<string, unknown> = {};
  for (const f of command?.fields ?? []) {
    if (f.name === "id" || f.name === "status") continue;
    if (!entityCols.has(f.name)) continue;
    if (args[f.name] === undefined) continue;
    const c = coerce(args[f.name], entityCols.get(f.name));
    if (c.ok) changes[f.name] = c.value;
  }

  if (Object.keys(changes).length > 0) {
    try {
      row = await store.update(table, id, changes, Number(row.version ?? 0));
    } catch (e: any) {
      if (/stale write/i.test(String(e?.message))) throw new DomainError(`stale write on ${entity.name} ${id}, retry`);
      throw e;
    }
  }
  // No-change (id-only) command: skip the write + version bump, still emit.
  await emitFor(b, row, args, role);
  return row;
}

async function emitFor(b: Binding, row: any, args: Record<string, unknown>, role: string): Promise<void> {
  const hasStatus = b.entity.fields.some((f) => f.name === "status");
  const payload: Record<string, unknown> = {
    ...args,
    id: row.id,
    ...(hasStatus && row.status !== undefined ? { status: row.status } : {}),
  };
  await emit({ ref: b.event.ref, aggregateId: row.id, role, payload });
}

// ---------------------------------------------------------------------------
// detect
// ---------------------------------------------------------------------------

export async function genericDetect(commandName: string, input: DetectInput): Promise<DetectResult> {
  let b: Binding;
  try {
    b = await resolveBinding(commandName);
  } catch (e: any) {
    return { happened: false, evidence: e?.message ?? "command not resolvable" };
  }
  const { entity, table, event, ont } = b;

  let row: any;
  try {
    row = await store.findById(table, input.id);
  } catch {
    return { happened: false, evidence: `${entity.name} not queryable` };
  }
  if (!row) return { happened: false, evidence: `${entity.name} ${input.id} not found` };

  // Create-shaped command: the row existing IS the event.
  if (isCreateEvent(event, ont) || !commandHasId(commandName, ont)) {
    return { happened: true, evidence: `${entity.name} ${input.id} exists (created)` };
  }

  // Update-shaped: prefer the command's distinguishing fields being set.
  const command = ont.command(commandName);
  const entityColNames = new Set(entity.fields.map((f) => f.name));
  const distinguishing = (command?.fields ?? [])
    .map((f) => f.name)
    .filter((n) => n !== "id" && n !== "status" && entityColNames.has(n));
  if (distinguishing.length > 0) {
    const allSet = distinguishing.every((n) => row[n] !== null && row[n] !== undefined);
    return {
      happened: allSet,
      evidence: distinguishing.map((n) => `${n}=${row[n] ?? "∅"}`).join(", "),
    };
  }

  // Id-only command: fall back to the append-only event log.
  const count = await prisma.eventLog.count({ where: { eventRef: event.ref, aggregateId: input.id } });
  return { happened: count > 0, evidence: `${count} ${event.name} event(s) recorded for ${input.id}` };
}

export function genericDescribe(commandName: string): string {
  // Synchronous (called at module load in stubs) — names only, no table check.
  const ont = getOntology();
  const event = ont.events.find((e) => e.commandName === commandName);
  if (!event) return `🌱 ${commandName}: generated default behavior (no authored logic yet).`;
  return (
    `🌱 ${event.name}: generated default behavior (create-or-update ${event.aggregateRoot} from the ` +
    `command's fields + example data, then emit the event). Author the command's .logic.ts to add ` +
    `preconditions, status transitions, or cross-aggregate effects.`
  );
}
