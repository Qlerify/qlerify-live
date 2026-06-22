// Per-bounded-context workbench routes (Part 2.3, Slice 1). Every route here is a
// PROJECTION over substrate that already exists (the ontology, the adapter
// registry, the provenance meta, the gen_ projection store, the EventLog) — no new
// tables, no new source of truth. Strictly additive: mounted from registerRoutes,
// the Ericsson dashboard + /sim routes are untouched. Slice 1 carries ZERO AI,
// credentials, or dynamic code execution — the AI-codegen-and-run crux is Slice 2.

import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { isHandledError } from "../errors.js";
import { getOntology, type EntitySchema, type OntologyEvent } from "../ontology/model.js";
import { listAdapters, getAdapter } from "../packs/registry.js";
import { applyFieldMap } from "../packs/types.js";
import { provenanceMeta } from "../twin/provenance.js";
import * as store from "../twin/projection-store.js";

/** Per-bounded-context event counts (feeds the provenance rollup). */
async function eventCounts(): Promise<Record<string, number>> {
  const rows = await prisma.eventLog.groupBy({ by: ["boundedContext"], _count: { _all: true } });
  const out: Record<string, number> = {};
  for (const r of rows) out[r.boundedContext] = r._count._all;
  return out;
}

function eventsForBc(bc: string): OntologyEvent[] {
  return getOntology().events.filter((e) => e.boundedContext === bc);
}

/** Entities a BC owns = the aggregate roots of its events. */
function entitiesForBc(bc: string): EntitySchema[] {
  const roots = new Set(eventsForBc(bc).map((e) => e.aggregateRoot).filter(Boolean));
  return getOntology().entities.filter((e) => roots.has(e.name));
}

/** The entity whose raw rows the workbench shows by default (the first aggregate
 * root in the BC's events). */
function defaultEntityForBc(bc: string): string | null {
  return eventsForBc(bc).map((e) => e.aggregateRoot).find(Boolean) ?? null;
}

/** Value objects referenced by this BC's entities — listed as their own populatable
 * "tables" in the explorer (a connector can fill a value object as its own table). */
function valueObjectsForBc(bc: string): EntitySchema[] {
  const o = getOntology();
  const names = new Set<string>();
  for (const e of entitiesForBc(bc)) {
    for (const f of e.fields) if (f.relatedEntity && o.valueObject(f.relatedEntity)) names.add(f.relatedEntity);
  }
  return [...names].map((n) => o.valueObject(n)).filter((v): v is EntitySchema => !!v);
}

function slimEvent(e: OntologyEvent) {
  return {
    key: e.key, name: e.name, ref: e.ref, role: e.role,
    boundedContext: e.boundedContext, aggregateRoot: e.aggregateRoot,
    commandName: e.commandName, phase: e.phase, derived: e.derived,
  };
}

function serializeAdapter(a: ReturnType<typeof listAdapters>[number]) {
  return { id: a.id, kind: a.kind, boundedContext: a.boundedContext, targetEntity: a.targetEntity, mode: a.mode };
}

/** Grade a pulled batch against the model entity: per-required-field coverage,
 * type mismatches, and extra unmapped keys. The test-live oracle (no insert). */
const PLATFORM_COLS = new Set(["id", "version", "createdAt", "updatedAt", "_provenance"]);
function diffRows(rows: Array<Record<string, unknown>>, entity: EntitySchema) {
  const fieldByName = new Map(entity.fields.map((f) => [f.name, f] as const));
  const declared = new Set(entity.fields.map((f) => f.name));
  const requiredStatus = entity.required.map((name) => {
    const present = rows.length > 0 && rows.every((r) => r[name] !== undefined && r[name] !== null && r[name] !== "");
    const f = fieldByName.get(name);
    const typeOk = !f?.dataType || rows.every((r) => matchesType(r[name], f.dataType));
    return { field: name, dataType: f?.dataType, present, typeOk, ok: present && typeOk };
  });
  const extraKeys = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) if (!declared.has(k) && !PLATFORM_COLS.has(k)) extraKeys.add(k);
  return {
    rowCount: rows.length,
    requiredStatus,
    extraFields: [...extraKeys],
    ok: requiredStatus.every((s) => s.ok),
  };
}

function matchesType(value: unknown, dataType?: string): boolean {
  if (value === undefined || value === null) return true; // coverage handled separately
  switch ((dataType ?? "string").toLowerCase()) {
    case "number":
    case "integer":
    case "float":
    case "decimal":
      return typeof value === "number" || (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)));
    case "boolean":
      return typeof value === "boolean" || value === 0 || value === 1 || value === "true" || value === "false";
    default:
      return true;
  }
}

export function registerBcRoutes(app: FastifyInstance): void {
  // Canonicalize a :bc param against the model (case-insensitive). null = unknown.
  function resolveBc(raw: unknown): string | null {
    const target = String(raw ?? "").toLowerCase();
    return getOntology().boundedContexts.find((b) => b.toLowerCase() === target) ?? null;
  }

  // Index — one card per bounded context with its mode + counts.
  app.get("/api/bc", async () => {
    const o = getOntology();
    const prov = await provenanceMeta(o.boundedContexts, o.events, await eventCounts());
    const adapters = listAdapters();
    return o.boundedContexts.map((bc) => ({
      name: bc,
      eventCount: eventsForBc(bc).length,
      entityCount: entitiesForBc(bc).length,
      adapterCount: adapters.filter((a) => a.boundedContext === bc).length,
      provenance: prov.byContext[bc] ?? { mode: "simulated", eventCount: 0 },
    }));
  });

  // Overview — the BC's events, entities, commands, adapters, provenance.
  app.get("/api/bc/:bc", async (req, reply) => {
    const bc = resolveBc((req.params as any).bc);
    if (!bc) return reply.code(404).send({ error: "UNKNOWN_BC", message: `no bounded context "${(req.params as any).bc}"` });
    const o = getOntology();
    const events = eventsForBc(bc);
    const cmdNames = new Set(events.map((e) => e.commandName).filter(Boolean));
    const commands = o.commands.filter((c) => cmdNames.has(c.name));
    const prov = (await provenanceMeta(o.boundedContexts, o.events, await eventCounts())).byContext[bc];
    return {
      name: bc,
      events: events.map(slimEvent),
      entities: entitiesForBc(bc),
      valueObjects: valueObjectsForBc(bc),
      commands,
      adapters: listAdapters().filter((a) => a.boundedContext === bc).map(serializeAdapter),
      provenance: prov ?? { mode: "simulated", eventCount: 0 },
      defaultEntity: defaultEntityForBc(bc),
    };
  });

  // Verify — run the adapter's healthcheck.
  app.post("/api/bc/:bc/adapter/:id/verify", async (req, reply) => {
    const a = getAdapter((req.params as any).id);
    if (!a) return reply.code(404).send({ error: "NOT_FOUND" });
    const at = new Date().toISOString();
    try {
      return { ...(await a.healthcheck()), at };
    } catch (err: any) {
      return { ok: false, detail: err?.message ?? String(err), at };
    }
  });

  // Test — a DRY-RUN pull + field-map diff. Nothing is inserted; "ingest for real"
  // is the existing POST /api/adapters/:id/pull.
  app.post("/api/bc/:bc/adapter/:id/test", async (req, reply) => {
    const a = getAdapter((req.params as any).id);
    if (!a) return reply.code(404).send({ error: "NOT_FOUND" });
    const limit = Math.max(1, Math.min(50, Number((req.body as any)?.limit ?? 5)));
    try {
      // getOntology() is inside the try so a project with no model yet yields a
      // clean ModelNotLoadedError (409) rather than an unhandled throw.
      const entity = getOntology().entity(a.targetEntity) ?? getOntology().valueObject(a.targetEntity);
      if (!entity) return reply.code(400).send({ error: "NO_ENTITY", message: `"${a.targetEntity}" is not an entity or value object in the model` });
      const fieldMap = await a.mapping();
      const { rows } = await a.pull({ limit });
      const mapped = (rows[a.targetEntity] ?? []).map((r) => applyFieldMap(r, fieldMap));
      return { entity: a.targetEntity, mode: a.mode, count: mapped.length, rows: mapped, diff: diffRows(mapped, entity) };
    } catch (err: any) {
      if (isHandledError(err)) return reply.code(err.status).send({ error: err.code, message: err.message });
      return reply.code(400).send({ error: "TEST_FAILED", message: err?.message ?? String(err) });
    }
  });

  // Raw ingestion — verbatim gen_<Entity> rows (incl. _provenance).
  app.get("/api/bc/:bc/raw", async (req, reply) => {
    const bc = resolveBc((req.params as any).bc);
    if (!bc) return reply.code(404).send({ error: "UNKNOWN_BC" });
    const entity = (req.query as any)?.entity || defaultEntityForBc(bc);
    if (!entity) return { entity: null, rows: [], tableMissing: true };
    const limit = Math.max(1, Math.min(500, Number((req.query as any)?.limit ?? 50)));
    if (!(await store.tableExists(entity))) return { entity, rows: [], tableMissing: true };
    return { entity, rows: await store.findMany(entity, limit), tableMissing: false };
  });

  // History — latest data updates per event (count + last timestamp + provenance).
  app.get("/api/bc/:bc/history", async (req, reply) => {
    const bc = resolveBc((req.params as any).bc);
    if (!bc) return reply.code(404).send({ error: "UNKNOWN_BC" });
    const grouped = await prisma.eventLog.groupBy({
      by: ["eventName", "provenance"],
      where: { boundedContext: bc },
      _count: { _all: true },
      _max: { occurredAt: true },
    });
    return grouped
      .map((g) => ({ eventName: g.eventName, provenance: g.provenance, count: g._count._all, lastAt: g._max.occurredAt }))
      .sort((a, b) => String(b.lastAt ?? "").localeCompare(String(a.lastAt ?? "")));
  });
}
