// Per-bounded-context workbench routes (Part 2.3, Slice 1). Every route here is a
// PROJECTION over substrate that already exists (the ontology, the adapter
// registry, the provenance meta, the gen_ projection store, the EventLog) — no new
// tables, no new source of truth. Strictly additive: mounted from registerRoutes,
// the dashboard + /sim routes are untouched. Slice 1 carries ZERO AI,
// credentials, or dynamic code execution — the AI-codegen-and-run crux is Slice 2.

import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { isHandledError } from "../errors.js";
import { eventLogOrgWhere } from "../platform/tenancy/event-scope.js";
import { getOntology, type EntitySchema, type OntologyEvent } from "../ontology/model.js";
import { eventsForBc, entitiesForBc, valueObjectsForBc, defaultEntityForBc } from "../ontology/bc-helpers.js";
import { listAdapters, getAdapter } from "../packs/registry.js";
import { applyFieldMap } from "../packs/types.js";
import { readDoc, readChat, writeChat, deleteChat, connectorChatId, appendNote } from "../packs/connector/journal.js";
import { provenanceMeta } from "../twin/provenance.js";
import { computeSystemsHealth } from "../twin/systems-health.js";
import * as store from "../twin/projection-store.js";

/** Per-bounded-context event counts (feeds the provenance rollup). */
async function eventCounts(): Promise<Record<string, number>> {
  const rows = await prisma.eventLog.groupBy({ by: ["boundedContext"], _count: { _all: true } });
  const out: Record<string, number> = {};
  for (const r of rows) out[r.boundedContext] = r._count._all;
  return out;
}

function slimEvent(e: OntologyEvent) {
  return {
    key: e.key, name: e.name, ref: e.ref, role: e.role,
    boundedContext: e.boundedContext, aggregateRoot: e.aggregateRoot,
    commandName: e.commandName, phase: e.phase, derived: e.derived,
  };
}

function serializeAdapter(a: ReturnType<typeof listAdapters>[number]) {
  // The doc (summary + update notes) rides along so the explorer's Configure
  // Adapter sidebar can show it with no extra request. null when none recorded.
  return { id: a.id, kind: a.kind, boundedContext: a.boundedContext, targetEntity: a.targetEntity, mode: a.mode, doc: readDoc(a.id) };
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
      eventCount: eventsForBc(o, bc).length,
      entityCount: entitiesForBc(o, bc).length,
      adapterCount: adapters.filter((a) => a.boundedContext === bc).length,
      provenance: prov.byContext[bc] ?? { mode: "simulated", eventCount: 0 },
    }));
  });

  // Health board — every bounded context's entities + value objects with a
  // derived 4-state connection status (no adapter / wired-but-empty / simulated /
  // live). Pure projection over the ontology + adapter registry + gen_ row counts;
  // no AI, credentials, or writes. Registered as a STATIC route so it wins over
  // the "/api/bc/:bc" param route below.
  app.get("/api/bc/health", async () => computeSystemsHealth());

  // Overview — the BC's events, entities, commands, adapters, provenance.
  app.get("/api/bc/:bc", async (req, reply) => {
    const bc = resolveBc((req.params as any).bc);
    if (!bc) return reply.code(404).send({ error: "UNKNOWN_BC", message: `no bounded context "${(req.params as any).bc}"` });
    const o = getOntology();
    const events = eventsForBc(o, bc);
    const cmdNames = new Set(events.map((e) => e.commandName).filter(Boolean));
    const commands = o.commands.filter((c) => cmdNames.has(c.name));
    const prov = (await provenanceMeta(o.boundedContexts, o.events, await eventCounts())).byContext[bc];
    return {
      name: bc,
      events: events.map(slimEvent),
      entities: entitiesForBc(o, bc),
      valueObjects: valueObjectsForBc(o, bc),
      commands,
      adapters: listAdapters().filter((a) => a.boundedContext === bc).map(serializeAdapter),
      provenance: prov ?? { mode: "simulated", eventCount: 0 },
      defaultEntity: defaultEntityForBc(o, bc),
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
      // getOntology() is inside the try so a workflow with no model yet yields a
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
    const entity = (req.query as any)?.entity || defaultEntityForBc(getOntology(), bc);
    if (!entity) return { entity: null, rows: [], tableMissing: true };
    const limit = Math.max(1, Math.min(500, Number((req.query as any)?.limit ?? 50)));
    if (!(await store.tableExists(entity))) return { entity, rows: [], tableMissing: true };
    return { entity, rows: await store.findMany(entity, limit), tableMissing: false };
  });

  // Clear — delete every row in one gen_ table AND the simulated events derived
  // from those rows. The event store is a best-effort simulation OF the static
  // data (twin/derive.ts), not an independent source of truth, so when the rows
  // go the events rooted at this aggregate go with them — otherwise the
  // timeline/dashboard would keep showing events whose source data is gone. The
  // table itself and the connectors are kept. Both deletes are scoped to the
  // active workflow/org. Value objects are no aggregate's root, so the event
  // delete is correctly a no-op for them.
  app.post("/api/bc/:bc/clear", async (req, reply) => {
    const bc = resolveBc((req.params as any).bc);
    if (!bc) return reply.code(404).send({ error: "UNKNOWN_BC" });
    const entity = String((req.body as any)?.entity ?? "");
    if (!entity) return reply.code(400).send({ error: "NO_ENTITY", message: "entity required" });
    const o = getOntology();
    const inBc =
      entitiesForBc(o, bc).some((e) => e.name === entity)
      || valueObjectsForBc(o, bc).some((v) => v.name === entity);
    if (!inBc) return reply.code(400).send({ error: "UNKNOWN_ENTITY", message: `"${entity}" is not a table in ${bc}` });
    if (!(await store.tableExists(entity))) return { entity, deleted: 0, eventsDeleted: 0, tableMissing: true };
    const deleted = await store.clearTable(entity);
    const { count: eventsDeleted } = await prisma.eventLog.deleteMany({
      where: { aggregateRoot: entity, ...eventLogOrgWhere() },
    });
    // Journal the clear onto the history of every connector targeting this table,
    // mirroring how ingestPull records a "Fetch rows" so both actions show in the
    // builder's notes timeline. No-op when no connector feeds the table.
    for (const a of listAdapters().filter((a) => a.boundedContext === bc && a.targetEntity === entity)) {
      appendNote(a.id, "cleared", `Cleared ${deleted} row(s) and ${eventsDeleted} derived event(s) from ${entity}.`);
    }
    return { entity, deleted, eventsDeleted, tableMissing: false };
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

  // ---- Connector-builder chat history, persisted per (system, table) --------
  // Keyed by slug(bc-target) so a thread survives reloads and exists before the
  // connector is created. The /chat turn endpoint stays stateless; the client
  // loads on table-select and saves after each turn.
  app.get("/api/bc/:bc/connector-chat", async (req, reply) => {
    const bc = resolveBc((req.params as any).bc);
    if (!bc) return reply.code(404).send({ error: "UNKNOWN_BC" });
    const target = String((req.query as any)?.target ?? "");
    if (!target) return reply.code(400).send({ error: "NO_TARGET", message: "target required" });
    const id = connectorChatId(bc, target);
    const chat = readChat(id);
    return { id, messages: chat?.messages ?? [], updatedAt: chat?.updatedAt ?? null };
  });

  app.put("/api/bc/:bc/connector-chat", async (req, reply) => {
    const bc = resolveBc((req.params as any).bc);
    if (!bc) return reply.code(404).send({ error: "UNKNOWN_BC" });
    const body = (req.body ?? {}) as any;
    const target = String(body.target ?? (req.query as any)?.target ?? "");
    if (!target) return reply.code(400).send({ error: "NO_TARGET", message: "target required" });
    if (!Array.isArray(body.messages)) return reply.code(400).send({ error: "NO_MESSAGES", message: "messages[] required" });
    const id = connectorChatId(bc, target);
    writeChat(id, body.messages);
    return { ok: true, id };
  });

  app.delete("/api/bc/:bc/connector-chat", async (req, reply) => {
    const bc = resolveBc((req.params as any).bc);
    if (!bc) return reply.code(404).send({ error: "UNKNOWN_BC" });
    const target = String((req.query as any)?.target ?? "");
    if (!target) return reply.code(400).send({ error: "NO_TARGET", message: "target required" });
    deleteChat(connectorChatId(bc, target));
    return { ok: true };
  });
}
