// HTTP route table. Every command is exposed as a POST under
// /commands/{boundedContext}/{commandName} so the URL itself documents
// the source of truth. Read models are GET under /queries/{name}.
//
// Auth: role taken from `x-role` header; assertRole inside each handler
// enforces the lane→command constraint from the workflow.

import type { FastifyInstance } from "fastify";
import { roleFromRequest, assertRole } from "../auth.js";
import { isHandledError, DomainError } from "../errors.js";
import { genericApply } from "../commands/base.js";
import { kebabCase } from "../kernel/codegen/introspect.js";
import {
  genericNewInstance, genericStep, genericCurrentStep,
  genericListInstances, genericInstanceDetail, genericDeleteInstance, genericDeleteAll, rebuildNeeded,
} from "../twin/sim.js";
import { provenanceMeta } from "../twin/provenance.js";
import { deriveFromData, rebuildFromData } from "../twin/derive.js";
import { listAdapters, getAdapter } from "../packs/registry.js";
import { ingestPull, reingestAll } from "../packs/ingest.js";
import { registerBcRoutes } from "./bc-routes.js";
import { registerAdapterCodeRoutes } from "./adapter-routes.js";
import { registerConnectorRoutes } from "./connector-routes.js";
import { registerOrgRoutes } from "./org-routes.js";

import { prisma } from "../db.js";
import { EVENTS, events, registryError } from "../events/registry.js";
import { ontologyView, getOntology } from "../ontology/model.js";
import { runAgentTurn } from "../chat/agent.js";
import { systemPromptSize } from "../chat/system-prompt.js";
import { TOOLS } from "../chat/tools.js";
import { getCommandByRoute, listRegisteredCommands } from "../commands/registry.js";
import { codegenStatus } from "../kernel/codegen/status.js";
import { eventLogOrgWhere } from "../platform/tenancy/event-scope.js";
import "../commands/registry.generated.js"; // side-effect: registers generated commands

export function registerRoutes(app: FastifyInstance) {
  // Shared command wrapper — auth + error mapping
  function cmd<TArgs, TResult>(handler: (args: TArgs, role: ReturnType<typeof roleFromRequest>) => Promise<TResult>) {
    return async (req: any, reply: any) => {
      try {
        const role = roleFromRequest(req);
        const out = await handler(req.body as TArgs, role);
        return reply.code(200).send(out);
      } catch (err) {
        if (isHandledError(err)) {
          return reply.code(err.status).send({ error: err.code, message: err.message, violations: (err as any).violations });
        }
        req.log.error({ err }, "command failed");
        return reply.code(500).send({ error: "INTERNAL", message: (err as Error).message });
      }
    };
  }

  // -- COMMANDS --
  // Commands are not hand-listed: every command in the loaded model is mounted
  // either from the codegen registry (generated handlers, below) or via the
  // model-driven generic dispatch (the `/commands/:bc/:name` fallback), so this
  // file knows nothing about any specific model's command set.

  // Generated commands — mounted from the codegen registry. Any command produced
  // by src/kernel/codegen (SAP today; whole bounded contexts after a model swap)
  // gets its POST route here automatically, with no edit to this file.
  for (const c of listRegisteredCommands()) {
    app.post(c.route, cmd(c.handler));
  }

  // Generic command dispatch — the fallback for ANY model command that has no
  // generated/authored handler (static routes above take precedence). Resolves
  // the command from the live model by its kebab name and runs it through the
  // generic base command, so a freshly-swapped model is runnable with zero
  // codegen / restart. Role + required-field checks come from the model.
  app.post("/commands/:bc/:name", async (req: any, reply: any) => {
    const name = (req.params as any).name as string;
    const ont = getOntology();
    const event = ont.events.find((e) => e.commandName && kebabCase(e.commandName) === name);
    if (!event) return reply.code(404).send({ error: "NOT_FOUND", message: `no command "${name}" in the loaded model` });
    try {
      const role = roleFromRequest(req);
      assertRole(role, event.role);
      const args = (req.body ?? {}) as Record<string, unknown>;
      const command = ont.command(event.commandName);
      for (const field of command?.required ?? []) {
        const v = args[field];
        if (v === undefined || v === null || v === "") throw new DomainError(`${field} is required`);
      }
      const out = await genericApply(event.commandName, { args, role });
      return reply.code(200).send(out);
    } catch (err) {
      if (isHandledError(err)) return reply.code(err.status).send({ error: err.code, message: err.message });
      req.log.error({ err }, "generic command failed");
      return reply.code(500).send({ error: "INTERNAL", message: (err as Error).message });
    }
  });

  // -- GENERATED COMMANDS: introspection --
  // Backed by the codegen registry (src/commands/registry.generated.ts). These
  // expose the readable command description and the event-detection predicate the
  // model-driven vision asks for, without the HTTP layer knowing the command set.
  app.get("/api/commands", async () =>
    listRegisteredCommands().map((c) => ({
      commandName: c.commandName,
      boundedContext: c.boundedContext,
      route: `/commands/${c.boundedContext.toLowerCase()}/${c.handlerName.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()}`,
      eventRef: c.eventRef,
      role: c.role,
    })),
  );
  // Codegen drift: which generated commands are current vs. need regeneration
  // after a model hot-reload (gwt-drift / schema-drift / missing-in-model).
  app.get("/api/commands/status", async () => codegenStatus());
  // Human-readable description of what a command does and how detection works.
  app.get("/commands/:bc/:name/describe", async (req, reply) => {
    const { name } = req.params as { bc: string; name: string };
    const reg = getCommandByRoute(name);
    if (!reg) return reply.code(404).send({ error: "NOT_FOUND", message: `no generated command "${name}"` });
    return { commandName: reg.commandName, eventRef: reg.eventRef, role: reg.role, describe: reg.DESCRIBE };
  });
  // Run the event-detection predicate: given an aggregate id, has the bound
  // domain event happened? Returns { happened, evidence }.
  app.post("/commands/:bc/:name/detect", async (req, reply) => {
    const { name } = req.params as { bc: string; name: string };
    const reg = getCommandByRoute(name);
    if (!reg) return reply.code(404).send({ error: "NOT_FOUND", message: `no generated command "${name}"` });
    const id = (req.body as any)?.id;
    if (typeof id !== "string" || !id) return reply.code(400).send({ error: "BAD_REQUEST", message: "id required" });
    return reg.detect({ id });
  });

  // -- ONTOLOGY --
  // The live Qlerify model: domain-event DAG, roles, commands, entities,
  // queries. Drives the front-end process graph and any model-aware tooling.
  app.get("/api/ontology", async () => ontologyView());

  // -- SIMULATOR SUPPORT --
  // Health of the event registry vs. the loaded model. When the synced
  // workflow.json doesn't match the simulator's 28-step sequence, EVENTS is
  // empty and `error` carries the mismatch — the frontend renders a banner
  // instead of the process crashing at boot. `registryError` is a live binding,
  // so this reflects the current state after any hot-reload.
  app.get("/sim/registry-status", async () => ({
    ok: registryError == null,
    error: registryError,
    eventCount: events().length,
    // Non-fatal: overlay entries left over from a previous model (regenerate the
    // overlay via the swap to restore curated ordering/phases for those events).
    staleOverlayKeys: getOntology().staleOverlayKeys,
  }));
  app.get("/sim/events", async () => events());
  app.get("/sim/event-log", async (req) => {
    const limit = Number((req.query as any)?.limit ?? 200);
    const caseId = (req.query as any)?.caseId as string | undefined;
    return prisma.eventLog.findMany({
      where: caseId ? { caseId, ...eventLogOrgWhere() } : eventLogOrgWhere(),
      orderBy: { occurredAt: "desc" },
      take: limit,
    });
  });
  app.get("/sim/health", async () => ({ ok: true, ts: new Date().toISOString() }));

  // Model-derived UI labels for the dashboard — so the header/buttons follow the
  // loaded model instead of hardcoded domain strings. Hot-reloads with the model.
  app.get("/sim/meta", async () => {
    const o = getOntology();
    const singular = o.rootAggregate;
    // Per-BC event counts feed the provenance rollup ("X of N steps real").
    const counts = await prisma.eventLog.groupBy({ by: ["boundedContext"], where: eventLogOrgWhere(), _count: { _all: true } });
    const eventCountByContext: Record<string, number> = {};
    for (const c of counts) eventCountByContext[c.boundedContext] = c._count._all;
    // The root aggregate's mandatory attributes (model `required`), minus system
    // fields — the by-case flow labels each row with the first few of these.
    const rootEntity = o.entities.find((e) => e.name === singular);
    const RESERVED_ATTRS = new Set(["id", "version", "createdAt", "updatedAt", "status", "progress", "total", "lastEvent", "dwellSeconds"]);
    const rootMandatoryAttributes = (rootEntity?.required ?? []).filter((a) => !RESERVED_ATTRS.has(a));
    return {
      title: o.title,
      primaryBoundedContext: o.primaryBoundedContext,
      rootAggregate: singular,
      rootAggregatePlural: pluralize(singular),
      rootMandatoryAttributes,
      boundedContextCount: o.boundedContexts.length,
      aggregateCount: new Set(o.events.map((e) => e.aggregateRoot).filter(Boolean)).size,
      eventCount: events().length,
      // True when the projection tables don't match the model yet — the UI
      // auto-rebuilds (with the loader) so no manual "Rebuild" button is needed.
      rebuildNeeded: await rebuildNeeded(),
      // Where each bounded context's data comes from + a per-step real/simulated
      // rollup. Drives the dashboard provenance badges + legend (Part 2.1).
      provenance: await provenanceMeta(o.boundedContexts, o.events, eventCountByContext),
    };
  });
  // Per-run detail (root row + events + rows created in the run) — used by the
  // dashboard detail view.
  app.get("/sim/instance/:id", async (req) => genericInstanceDetail((req.params as any).id));

  // Merged "all cases" flow: per-event firing counts across EVERY case in the
  // active workflow. Drives the aggregate flow view — one counter badge per event
  // = how many times that event fired across all cases. Workflow-scoped like the
  // rest of the simulator reads (eventLogOrgWhere folds in org + workflow).
  app.get("/sim/flow-aggregate", async () => {
    const byRef = await prisma.eventLog.groupBy({
      by: ["eventRef"],
      where: eventLogOrgWhere(),
      _count: { _all: true },
    });
    const counts: Record<string, number> = {};
    let totalFirings = 0;
    for (const r of byRef) {
      counts[r.eventRef] = r._count._all;
      totalFirings += r._count._all;
    }
    // Distinct cases that have any event — the denominator shown in the header
    // and on the scope toggle ("All cases · N").
    const cases = await prisma.eventLog.findMany({
      where: { caseId: { not: null }, ...eventLogOrgWhere() },
      select: { caseId: true },
      distinct: ["caseId"],
    });
    return { counts, totalFirings, totalCases: cases.length };
  });

  // Per-case breakdown of the same firings the flow-aggregate folds together:
  // one entry per case with that case's own ref→count map. Powers the "By case"
  // flow (each case a row through the same steps). Most-recently-active first and
  // capped, so a high-volume workflow doesn't render thousands of rows; the full
  // distinct count is returned as totalCases so the UI can flag truncation.
  app.get("/sim/flow-by-case", async (req) => {
    // Default render cap so a high-volume workflow doesn't push thousands of
    // SVG rows at the browser; pass ?limit=0 (or any non-positive value) to
    // lift it and return every case.
    const q = Number((req.query as any)?.limit ?? 50);
    const ROW_CAP = Number.isFinite(q) && q > 0 ? q : Infinity;
    const rows = await prisma.eventLog.groupBy({
      by: ["caseId", "eventRef"],
      where: { caseId: { not: null }, ...eventLogOrgWhere() },
      _count: { _all: true },
      // Both bounds on the BUSINESS timeline (businessAt), not the recording
      // wall-clock (occurredAt): startAt is the case's first event's business date
      // (the create date), lastAt its most recent. occurredAt is ~ingestion time
      // for replayed/ingested data and would make every case look like it started
      // "just now".
      _min: { businessAt: true },
      _max: { businessAt: true },
    });
    const byCase = new Map<string, { caseId: string; counts: Record<string, number>; firings: number; startAt: string; lastAt: string }>();
    for (const r of rows) {
      const id = r.caseId as string;
      let c = byCase.get(id);
      if (!c) { c = { caseId: id, counts: {}, firings: 0, startAt: "", lastAt: "" }; byCase.set(id, c); }
      c.counts[r.eventRef] = r._count._all;
      c.firings += r._count._all;
      const first = r._min?.businessAt ? new Date(r._min.businessAt).toISOString() : "";
      const last = r._max?.businessAt ? new Date(r._max.businessAt).toISOString() : "";
      if (first && (c.startAt === "" || first < c.startAt)) c.startAt = first;
      if (last > c.lastAt) c.lastAt = last;
    }
    // Most recently active first (by business last-activity).
    const all = [...byCase.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0));
    const capped = ROW_CAP === Infinity ? all : all.slice(0, ROW_CAP);
    return { cases: capped, totalCases: all.length, cap: ROW_CAP === Infinity ? all.length : ROW_CAP };
  });

  // ---------------- Source adapters (Part 2.2) ----------------
  // Registered packs' adapters. Additive + model-generic; the registry is filled
  // by loadPacks() at boot and on every ontology reload.
  app.get("/api/adapters", async () =>
    listAdapters().map((a) => ({
      id: a.id, kind: a.kind, boundedContext: a.boundedContext, targetEntity: a.targetEntity, mode: a.mode,
    })),
  );
  app.get("/api/adapters/:id", async (req, reply) => {
    const a = getAdapter((req.params as any).id);
    if (!a) return reply.code(404).send({ error: "NOT_FOUND" });
    return {
      id: a.id, kind: a.kind, boundedContext: a.boundedContext, targetEntity: a.targetEntity, mode: a.mode,
      introspect: await a.introspect(), mapping: await a.mapping(), health: await a.healthcheck(),
    };
  });
  // Pull a bounded batch into the ingestion (gen_) tables, stamped with the
  // adapter's provenance mode.
  app.post("/api/adapters/:id/pull", async (req, reply) => {
    try {
      const limit = Number((req.body as any)?.limit ?? 10);
      return await ingestPull((req.params as any).id, { limit });
    } catch (err: any) {
      return reply.code(400).send({ error: "PULL_FAILED", message: err?.message ?? String(err) });
    }
  });

  // Reset & reimport — the Systems explorer's global counterpart to the per-table
  // "Delete all rows" + "Fetch rows". Empties every base-data (gen_) table AND the
  // whole event log for the active workflow, then re-pulls every configured
  // connector so the tables repopulate from source (one final derive over the
  // restored data). Workflow/org-scoped; connectors and the model are kept.
  app.post("/api/data/reimport-all", async (req, reply) => {
    const limit = Number((req.body as any)?.limit ?? 1000);
    try {
      await genericDeleteAll();                     // empty all gen_ tables + the event log
      const result = await reingestAll({ limit });  // re-pull every connector, derive once
      return { ok: true, ...result };
    } catch (err: any) {
      return reply.code(400).send({ error: "REIMPORT_FAILED", message: err?.message ?? String(err) });
    }
  });

  // ---------------- Per-BC workbench (Part 2.3) ----------------
  registerBcRoutes(app);
  registerAdapterCodeRoutes(app);
  registerConnectorRoutes(app);

  // ---------------- Organisation portfolio dashboard ----------------
  // The tier above the per-workflow overview: spans every workflow type in the org.
  registerOrgRoutes(app);

  // ---------------- Chat assistant ----------------
  app.get("/chat/info", async () => ({
    model: process.env.CHAT_MODEL ?? "claude-sonnet-4-6",
    effort: process.env.CHAT_EFFORT ?? "medium",
    apiKeyConfigured: !!process.env.ANTHROPIC_API_KEY,
    systemPrompt: systemPromptSize(),
    toolCount: TOOLS.length,
  }));

  app.post("/chat", async (req, reply) => {
    const body = (req.body ?? {}) as { messages?: unknown };
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return reply.code(400).send({ error: "messages[] required, must be non-empty" });
    }
    try {
      const result = await runAgentTurn(body.messages as any);
      // Use JSON.stringify explicitly — Fastify's default serializer was
      // emitting raw 0x0a inside nested string fields in some cases.
      return reply.type("application/json").send(JSON.stringify(result));
    } catch (e: any) {
      req.log.error({ err: e }, "chat turn failed");
      return reply.code(500).send({ error: "INTERNAL", message: e?.message ?? String(e) });
    }
  });

  // List all runs with progress (the dashboard's main query) — the loaded model's
  // root-aggregate instances, via the generic simulator.
  app.get("/sim/cases", async () => genericListInstances());

  // Create a fresh run of the loaded model (instantiates the root aggregate).
  app.post("/sim/cases", async (_req, reply) => {
    try {
      const inst = await genericNewInstance();
      return { id: inst.id, template: { aggregate: inst.aggregate } };
    } catch (err) {
      if (isHandledError(err)) return reply.code(err.status).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  app.get("/sim/current-step", async (req) => {
    const caseId = (req.query as any)?.caseId as string | undefined;
    if (!caseId) return { error: "caseId required" };
    return { ...(await genericCurrentStep(caseId)), caseId };
  });

  app.post("/sim/next", async (req, reply) => {
    const body = (req.body ?? {}) as { caseId?: string };
    if (!body.caseId) throw new Error("caseId required");
    try {
      return await genericStep(body.caseId);
    } catch (err) {
      if (isHandledError(err)) return reply.code(err.status).send({ error: err.code, message: err.message });
      throw err;
    }
  });
  // DELETE — remove a run entirely (the dashboard's ✕): its root row, every row
  // it created, and its event-log entries. Distinct from /sim/reset.
  app.post("/sim/delete", async (req) => {
    const body = (req.body ?? {}) as { caseId?: string };
    if (!body.caseId) throw new Error("caseId required");
    await genericDeleteInstance(body.caseId);
    return { ok: true };
  });

  // RESET — start over / clear (the detail view's Reset button). With a caseId
  // this removes that one run; without one it clears all runs.
  app.post("/sim/reset", async (req) => {
    const body = (req.body ?? {}) as { caseId?: string };
    if (body.caseId) await genericDeleteInstance(body.caseId);
    else await genericDeleteAll();
    return { ok: true };
  });
  app.post("/sim/run-all", async (req) => {
    const body = (req.body ?? {}) as { caseId?: string };
    if (!body.caseId) throw new Error("caseId required");
    const steps: any[] = [];
    for (let guard = 0; guard < 500; guard++) {
      const step = await genericStep(body.caseId);
      steps.push(step);
      if (step.done) break;
    }
    return { steps };
  });

  // DERIVE — replay the domain events the ingested data's evidence implies into
  // the event log (one place the simulator reads real data instead of synthesizing
  // it). `preview: true` reports what would fire without writing. Idempotent.
  app.post("/sim/derive", async (req, reply) => {
    const body = (req.body ?? {}) as { preview?: boolean; limit?: number };
    try {
      return await deriveFromData({ preview: body.preview, limit: body.limit });
    } catch (err) {
      if (isHandledError(err)) return reply.code(err.status).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  // REBUILD — clear the workflow's event log, then re-derive from the still-present
  // ingested rows. The designer's "regenerate after a model change": like
  // /sim/derive but without the idempotency floor, so changed evidence takes
  // effect. Keeps the gen_ source rows; lossy for events that leave no row trace.
  app.post("/sim/rebuild", async (req, reply) => {
    const body = (req.body ?? {}) as { limit?: number };
    try {
      return await rebuildFromData({ limit: body.limit });
    } catch (err) {
      if (isHandledError(err)) return reply.code(err.status).send({ error: err.code, message: err.message });
      throw err;
    }
  });
}

// Naive English pluralization for UI labels (User→Users, Policy→Policies,
// Address→Addresses). Good enough for a header; the model can override the whole
// title via overlay.json if a domain term doesn't pluralize cleanly.
function pluralize(word: string): string {
  if (!word) return word;
  if (/[^aeiou]y$/i.test(word)) return word.slice(0, -1) + "ies";
  if (/(s|x|z|ch|sh)$/i.test(word)) return word + "es";
  return word + "s";
}
