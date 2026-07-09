// Model-generic simulator. Drives ANY loaded model: create a root-aggregate
// instance, then step through the events in linearOrder, invoking each event's
// command via the generic base command. A "run" is scoped by its root instance
// id (set on the bus so emitted events group under it, per run).
//
// Arg synthesis is best-effort from the model: ids and FK-shaped fields
// (`xxxId`) are linked to instances already created in the run; everything else
// comes from the entity field's exampleData (or a name-based placeholder). It
// won't reproduce hand-authored business linkage perfectly, but it makes a
// freshly-swapped model runnable end-to-end with zero code.

import { prisma } from "../db.js";
import { newId } from "../util/ids.js";
import { withScope } from "../events/bus.js";
import { provenanceFor } from "./provenance.js";
import { currentOrgId, currentWorkflowId, isSystemWorkflow } from "../platform/tenancy/context.js";
import { eventLogOrgWhere } from "../platform/tenancy/event-scope.js";
import { DomainError } from "../errors.js";
import { getOntology, type Ontology, type OntologyEvent, type EntitySchema } from "../ontology/model.js";
import { genericApply } from "../commands/base.js";
import { fkTargetEntity } from "./correlate.js";
import * as store from "./projection-store.js";

/** A stable signature of the loaded model — used as the "which model does the
 * transactional data belong to" marker. Changes when the bounded context or the
 * entity set changes (i.e. a genuine model switch). */
export function dataModelSignature(): string {
  const o = getOntology();
  return o.primaryBoundedContext + "|" + o.entities.map((e) => e.name).sort().join(",");
}

/** Whether a rebuild (apply) is needed before the model can run cleanly. True
 * when the transactional data belongs to a DIFFERENT model (a switch → clean
 * slate), or when the loaded model's projection tables are missing / drifted.
 * The UI uses this to auto-rebuild on a model change instead of a manual button. */
export async function rebuildNeeded(): Promise<boolean> {
  // Non-system workflows use their own lazily-created, per-workflow gen_ tables and
  // a fixed CAS model version — they never need the system's global drop/recreate
  // rebuild (which also resets shared state). The dashboard creates a workflow's
  // tables on first "+ New".
  if (!isSystemWorkflow()) return false;
  // Model switch: the data in the tables is from a previously-loaded model, so a
  // clean-slate rebuild is needed. Null marker = data unclaimed yet.
  const dataModel = await store.getMeta("dataModel");
  if (dataModel !== null && dataModel !== dataModelSignature()) return true;
  const ont = getOntology();
  const existing = new Set(await store.listProjectionTables());
  for (const e of ont.entities) {
    if (!existing.has(e.name)) return true; // entity has no projection table
    const cols = await store.tableColumns(e.name);
    if (e.fields.some((f) => !cols.has(f.name))) return true; // a field column is missing
  }
  return false;
}

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

/** The event that creates the workflow's root aggregate (e.g. AccountRegistered).
 * Command-less events are inert markers, so prefer a command-bearing one. */
function rootCreateEvent(ont: Ontology): OntologyEvent {
  const root = ont.rootAggregate;
  const all = ont.linearOrder().map((k) => ont.eventByKey(k)!);
  const ordered = all.filter((e) => e.commandName);
  return (
    ordered.find((e) => e.aggregateRoot === root && isCreateEvent(e, ont)) ||
    ordered.find((e) => e.aggregateRoot === root) ||
    ordered[0] ||
    all[0]
  );
}

/** "userId" → "User" when an entity of that name exists (FK-by-name heuristic,
 * case-insensitive so "gprId" → "GPR"; shared with case correlation). */
function fkAggregateFor(field: string, ont: Ontology): string | undefined {
  return fkTargetEntity(field, ont);
}

function placeholder(field: string): string {
  if (/email/i.test(field)) return `${newId("u").slice(0, 14)}@example.com`;
  if (/password|secret/i.test(field)) return "Passw0rd!";
  if (/name/i.test(field)) return "Sample";
  if (/phone/i.test(field)) return "+1-555-0100";
  return `${field}-${newId("").slice(0, 6)}`;
}

/** Coerce a stored-as-string example to its declared type so embedded rows read
 * naturally (numbers as numbers, booleans as booleans). */
function coerceExample(v: unknown, dataType?: string): unknown {
  switch ((dataType ?? "string").toLowerCase()) {
    case "number":
    case "integer":
    case "float":
    case "decimal": {
      const n = Number(v);
      return Number.isFinite(n) ? n : v;
    }
    case "boolean":
      return v === true || v === "true" || v === "1";
    default:
      return v;
  }
}

/** One example row from a related schema, taking each field's idx-th example
 * (falling back to the first). Skips the surrogate `id`: embedded rows are
 * value-shaped (e.g. a cart item, an invoice line), not separately addressable. */
function exampleRow(schema: EntitySchema, idx: number): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const f of schema.fields) {
    if (f.name === "id") continue;
    const ex = f.exampleData;
    const v = Array.isArray(ex) ? (ex[idx] ?? ex[0]) : ex;
    if (v === undefined) continue;
    row[f.name] = coerceExample(v, f.dataType);
  }
  return row;
}

/** Materialize an object-typed field's value from its `relatedEntity` schema: an
 * array of rows when the field is a collection, else a single object. Returns
 * undefined when there's no related schema to build from (caller falls back to
 * exampleData). This is what turns the model's opaque "Object" placeholder into
 * real underlying rows (cart items, invoice lines, the target-audience segment). */
function objectFieldValue(ef: EntitySchema["fields"][number], ont: Ontology): unknown {
  if ((ef.dataType ?? "").toLowerCase() !== "object" || !ef.relatedEntity) return undefined;
  const sub = ont.entity(ef.relatedEntity) ?? ont.valueObject(ef.relatedEntity);
  if (!sub) return undefined;
  if (!ef.array) return exampleRow(sub, 0);
  // As many rows as there are distinct examples to draw from (cap 3, min 1).
  const n = Math.min(3, Math.max(1, ...sub.fields.map((f) => f.exampleData?.length ?? 1)));
  return Array.from({ length: n }, (_, i) => exampleRow(sub, i));
}

/** Map aggregateRoot → its instance id already created in this run (from the log). */
async function runInstances(scopeId: string): Promise<Map<string, string>> {
  const rows = await prisma.eventLog.findMany({
    where: { caseId: scopeId, ...eventLogOrgWhere() },
    select: { aggregateRoot: true, aggregateId: true },
    orderBy: { occurredAt: "asc" },
  });
  const map = new Map<string, string>();
  for (const r of rows) if (r.aggregateRoot && r.aggregateId) map.set(r.aggregateRoot, r.aggregateId);
  return map;
}

function synthesizeArgs(
  event: OntologyEvent,
  ont: Ontology,
  instances: Map<string, string>,
): Record<string, unknown> {
  const command = ont.command(event.commandName);
  const entity = ont.entity(event.aggregateRoot);
  const args: Record<string, unknown> = {};
  for (const f of command?.fields ?? []) {
    const name = f.name;
    if (name === "id") {
      const id = instances.get(event.aggregateRoot);
      if (id) args.id = id; // update existing; else omit so create generates one
      continue;
    }
    const fkAgg = fkAggregateFor(name, ont);
    if (fkAgg) {
      const id = instances.get(fkAgg);
      if (id) { args[name] = id; continue; }
    }
    const ef = entity?.fields.find((x) => x.name === name);
    if (ef) {
      const obj = objectFieldValue(ef, ont);
      if (obj !== undefined) { args[name] = obj; continue; }
    }
    const ex = ef?.exampleData?.[0];
    args[name] = ex !== undefined ? ex : placeholder(name);
  }
  // Update-shaped events (e.g. ConfirmAccount, LogIn) operate on an aggregate the
  // run already created, but their command may not declare an `id` field. Inject
  // the run instance's id so the base command can locate the aggregate to update.
  if (args.id === undefined && !isCreateEvent(event, ont)) {
    const existing = instances.get(event.aggregateRoot);
    if (existing) args.id = existing;
  }
  return args;
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

interface SimStepResult {
  index: number;
  total: number;
  eventRef: string | null;
  eventName: string | null;
  caption: string;
  done: boolean;
  instanceId: string;
}

/** Create a new run: instantiate the root aggregate, scoped to a fresh id. */
export async function genericNewInstance(): Promise<{ id: string; aggregate: string }> {
  const ont = getOntology();
  const event = rootCreateEvent(ont);
  const id = newId(ont.rootAggregate.toLowerCase().slice(0, 8));
  const args = { ...synthesizeArgs(event, ont, new Map()), id };
  // businessAt is derived in emit() from the event's own data, so no clock to set.
  // eventRef pins the EXACT event to record (events can share a command).
  await withScope(id, () => genericApply(event.commandName, { args, role: event.role, eventRef: event.ref }));
  return { id, aggregate: ont.rootAggregate };
}

/** The steppable run sequence: linearOrder minus inert (command-less) markers,
 * which are shown in the diagram but never fired. */
function steppableOrder(ont: Ontology): string[] {
  return ont.linearOrder().filter((k) => ont.eventByKey(k)?.commandName);
}

/** Index of the next steppable event not yet fired for this run. */
export async function genericCurrentStep(instanceId: string): Promise<{ index: number; total: number }> {
  const ont = getOntology();
  const order = steppableOrder(ont);
  const fired = new Set(
    (await prisma.eventLog.findMany({ where: { caseId: instanceId, ...eventLogOrgWhere() }, distinct: ["eventRef"], select: { eventRef: true } })).map((r) => r.eventRef),
  );
  for (let i = 0; i < order.length; i++) {
    const ev = ont.eventByKey(order[i]!)!;
    if (!fired.has(ev.ref)) return { index: i, total: order.length };
  }
  return { index: order.length, total: order.length };
}

/** Events coupled to `key` (root-less satellites that complete with it), then
 * their own satellites in turn — in the order they should fire. */
function coupledSatellites(ont: Ontology, key: string): OntologyEvent[] {
  const out: OntologyEvent[] = [];
  const queue = ont.events.filter((e) => e.coupledTo === key);
  while (queue.length) {
    const sat = queue.shift()!;
    out.push(sat);
    queue.push(...ont.events.filter((e) => e.coupledTo === sat.key));
  }
  return out;
}

/** Record a skip marker so the step advances and the reason stays visible. */
async function logSkippedStep(instanceId: string, event: OntologyEvent, caption: string): Promise<void> {
  await prisma.eventLog.create({
    data: {
      eventName: event.name, eventRef: event.ref, boundedContext: event.boundedContext,
      aggregateRoot: event.aggregateRoot, aggregateId: "", caseId: instanceId,
      role: event.role, payload: JSON.stringify({ skipped: true, error: caption }), businessAt: new Date(),
      provenance: await provenanceFor(event.boundedContext),
      organizationId: currentOrgId(),
      workflowId: currentWorkflowId(),
    },
  });
}

/** Advance one step: fire the next unfired event's command for this run, plus
 * any root-less satellites that complete together with it. */
export async function genericStep(instanceId: string): Promise<SimStepResult> {
  const ont = getOntology();
  const order = steppableOrder(ont);
  const { index, total } = await genericCurrentStep(instanceId);
  if (index >= total) {
    return { index, total, eventRef: null, eventName: null, caption: "(run complete)", done: true, instanceId };
  }
  const event = ont.eventByKey(order[index]!)!;
  const args = synthesizeArgs(event, ont, await runInstances(instanceId));
  let caption: string;
  try {
    // businessAt is derived in emit() from the event's own data. eventRef pins the
    // EXACT event to record — events can share a command (two "Approval process
    // completed" steps both fire UpdateStatus); without it the run would re-emit
    // the first such event and never advance past it.
    await withScope(instanceId, () => genericApply(event.commandName, { args, role: event.role, eventRef: event.ref }));
    caption = `${event.role} → ${event.name}`;
    // Root-less satellites complete in the SAME step, against the same aggregate
    // instance the predecessor just created/updated. Each soft-fails on its own
    // so one bad satellite can't undo the predecessor's success.
    for (const sat of coupledSatellites(ont, event.key)) {
      if (!sat.commandName) continue; // inert marker: shown in the flow, never fired
      try {
        const satArgs = synthesizeArgs(sat, ont, await runInstances(instanceId));
        await withScope(instanceId, () => genericApply(sat.commandName, { args: satArgs, role: sat.role, eventRef: sat.ref }));
      } catch (satErr: any) {
        await logSkippedStep(instanceId, sat, `⚠️ ${sat.name}: ${satErr?.message ?? String(satErr)}`);
      }
    }
  } catch (err: any) {
    // Soft-fail one step so a single un-synthesizable command doesn't wedge the
    // run; record a marker so the step advances and the reason is visible.
    caption = `⚠️ ${event.name}: ${err?.message ?? String(err)}`;
    await logSkippedStep(instanceId, event, caption);
  }
  // `done` reflects ACTUAL progress: satellites firing alongside the predecessor
  // can advance past more than one step in a single call.
  const after = await genericCurrentStep(instanceId);
  return { index, total, eventRef: event.ref, eventName: event.name, caption, done: after.index >= after.total, instanceId };
}

/** Delete one run: its root + every row it created (from the log's aggregateIds)
 * + its event-log entries. This is what the dashboard's ✕ does. */
export async function genericDeleteInstance(instanceId: string): Promise<void> {
  const ont = getOntology();
  // The root row's id IS the instance id — delete it DIRECTLY (not only via the
  // event log), so the item always disappears even if its events are missing or
  // were scoped differently (e.g. rows created before run-scoping, or after a
  // prior reset cleared the log). This is the case that left rows undeletable.
  if (await store.tableExists(ont.rootAggregate)) {
    try { await store.deleteById(ont.rootAggregate, instanceId); } catch { /* ignore */ }
  }
  // Also delete child rows created in this run (from the log's aggregateIds).
  const rows = await prisma.eventLog.findMany({
    where: { caseId: instanceId, ...eventLogOrgWhere() },
    select: { aggregateRoot: true, aggregateId: true },
  });
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r.aggregateRoot || !r.aggregateId) continue;
    const key = `${r.aggregateRoot}:${r.aggregateId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (await store.tableExists(r.aggregateRoot)) await store.deleteById(r.aggregateRoot, r.aggregateId);
    } catch { /* one bad row must not abort the whole delete */ }
  }
  await prisma.eventLog.deleteMany({ where: { caseId: instanceId, ...eventLogOrgWhere() } });
}

/** Clear all runs: every projection row + the whole event log. */
export async function genericDeleteAll(): Promise<void> {
  await prisma.eventLog.deleteMany({ where: eventLogOrgWhere() }); // scoped to the active workflow
  await store.clearAll(); // listProjectionTables is workflow-scoped → clears only this workflow's tables
}

/** Steps on ONE run's own path through the model: the length of the
 * source→sink chain in the `follows` DAG that best matches the run's fired
 * events — most fired events on the chain first, longest chain as the
 * tiebreaker (a run that hasn't committed to a branch yet reads as the longest
 * alternative still open). A branch-less model degrades to the full event
 * count, i.e. the old fixed total. */
export function branchTotal(ont: Ontology, firedRefs: Set<string>): number {
  type Score = { fired: number; len: number };
  const beats = (a: Score, b: Score | undefined) => !b || a.fired > b.fired || (a.fired === b.fired && a.len > b.len);
  // (fired, length) is additive along a chain, so a topological sweep finds the
  // lexicographic-max chain ending at every event in one pass.
  const best = new Map<string, Score>();
  let end: Score | undefined;
  for (const key of ont.topologicalOrder()) {
    const e = ont.eventByKey(key)!;
    let pred: Score = { fired: 0, len: 0 };
    for (const p of e.predecessors) {
      const b = best.get(p);
      if (b && beats(b, pred)) pred = b;
    }
    const score = { fired: pred.fired + (firedRefs.has(e.ref) ? 1 : 0), len: pred.len + 1 };
    best.set(key, score);
    if (ont.successorsOf(key).length === 0 && beats(score, end)) end = score;
  }
  return end?.len ?? ont.linearOrder().length;
}

/** List runs: one row per root-aggregate instance, with progress. */
export async function genericListInstances(): Promise<any[]> {
  const ont = getOntology();
  const table = ont.rootAggregate;
  if (!(await store.tableExists(table))) return [];
  const rows = await store.findMany(table, 200);
  const out: any[] = [];
  for (const row of rows) {
    const id = String(row.id);
    const progressRows = await prisma.eventLog.findMany({ where: { caseId: id, ...eventLogOrgWhere() }, distinct: ["eventRef"], select: { eventRef: true } });
    const last = await prisma.eventLog.findFirst({ where: { caseId: id, ...eventLogOrgWhere() }, orderBy: { occurredAt: "desc" }, select: { eventName: true, occurredAt: true, provenance: true } });
    // Per-run total: steps on THIS run's branch, not the whole model — a case on
    // a 10-step branch reads 7/10, not 7/18. Fired events off the chosen chain
    // (e.g. dangling satellites) could exceed it, so clamp to the fired count.
    const total = Math.max(branchTotal(ont, new Set(progressRows.map((r) => r.eventRef))), progressRows.length);
    out.push({ ...row, progress: progressRows.length, total, lastEvent: last });
  }
  return out;
}

/** Detail of one run: the root row, its events, and rows created across the run. */
export async function genericInstanceDetail(instanceId: string): Promise<any> {
  const ont = getOntology();
  const rootRow = (await store.tableExists(ont.rootAggregate)) ? await store.findById(ont.rootAggregate, instanceId) : null;
  const events = await prisma.eventLog.findMany({ where: { caseId: instanceId, ...eventLogOrgWhere() }, orderBy: { occurredAt: "asc" } });
  // Rows created in this run, grouped by aggregate (from the log's aggregateIds).
  const byAgg: Record<string, any[]> = {};
  const seen = new Map<string, Set<string>>();
  for (const e of events) {
    if (!e.aggregateRoot || !e.aggregateId) continue;
    const ids = seen.get(e.aggregateRoot) ?? seen.set(e.aggregateRoot, new Set()).get(e.aggregateRoot)!;
    if (ids.has(e.aggregateId)) continue;
    ids.add(e.aggregateId);
    if (!(await store.tableExists(e.aggregateRoot))) continue;
    const row = await store.findById(e.aggregateRoot, e.aggregateId);
    if (row) (byAgg[e.aggregateRoot] ??= []).push(row);
  }
  return { instanceId, rootAggregate: ont.rootAggregate, root: rootRow, events, entities: byAgg };
}
