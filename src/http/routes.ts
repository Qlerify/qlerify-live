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
import { applyModel, applyStatus } from "../twin/apply.js";
import {
  isEricssonModel, genericNewInstance, genericStep, genericCurrentStep,
  genericListInstances, genericInstanceDetail, genericDeleteInstance, genericDeleteAll, rebuildNeeded,
} from "../twin/sim.js";

// Commands
import * as demand from "../helix/demand/commands.js";
import * as bp from "../helix/buildplan/commands.js";
import * as build from "../helix/build/commands.js";
import * as project from "../prim/project/commands.js";
import * as er from "../prim/engineering-release/commands.js";
import * as ec from "../ester/engineering-change/commands.js";
import * as lb from "../compass/line-booking/commands.js";
import * as test from "../test/test-result/commands.js";
import * as ship from "../logistics/shipment/commands.js";

// Queries
import * as helixQ from "../helix/queries.js";
import * as primQ from "../prim/queries.js";
import * as sapQ from "../sap/queries.js";
import * as esterQ from "../ester/queries.js";
import * as compassQ from "../compass/queries.js";
import * as testQ from "../test/queries.js";
import * as logisticsQ from "../logistics/queries.js";

import { prisma } from "../db.js";
import { EVENTS, registryError } from "../events/registry.js";
import { ontologyView, getOntology } from "../ontology/model.js";
import { fetchLatestModel, modelStatus, rollModel, restoreModel, modelFile, getModelSource, writeSourceOverride } from "../ontology/sync.js";
import {
  nextStep, currentStepIndex, newDemand, resetDemand, resetAll,
} from "../simulator/stepper.js";
import { runAgentTurn } from "../chat/agent.js";
import { systemPromptSize } from "../chat/system-prompt.js";
import { getCommandByRoute, listRegisteredCommands } from "../commands/registry.js";
import { codegenStatus } from "../kernel/codegen/status.js";
import { swapPreview } from "../kernel/codegen/swap.js";
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
  // Helix
  app.post("/commands/helix/create-demand",         cmd(demand.createDemand));
  app.post("/commands/helix/define-build-quantity", cmd(bp.defineBuildQuantity));
  app.post("/commands/helix/update-build-plan",     cmd(bp.updateBuildPlan));
  app.post("/commands/helix/lock-build-plan",       cmd(bp.lockBuildPlan));
  app.post("/commands/helix/specify-material-demand", cmd(build.specifyMaterialDemand));
  app.post("/commands/helix/flag-material-shortage",  cmd(build.flagMaterialShortage));
  app.post("/commands/helix/set-build-priority",      cmd(build.setBuildPriority));
  app.post("/commands/helix/release-build-to-site",   cmd(build.releaseBuildToSite));
  app.post("/commands/helix/complete-material-kit",   cmd(build.completeMaterialKit));
  app.post("/commands/helix/start-production",        cmd(build.startProduction));
  app.post("/commands/helix/mark-build-as-rtd",       cmd(build.markBuildAsRTD));
  // PRIM
  app.post("/commands/prim/create-project",       cmd(project.createProject));
  app.post("/commands/prim/define-bom",           cmd(project.defineBOM));
  app.post("/commands/prim/freeze-bom-at-ds1",    cmd(project.freezeBOMAtDS1));
  app.post("/commands/prim/freeze-bom-at-ds2",    cmd(project.freezeBOMAtDS2));
  app.post("/commands/prim/approve-engineering-release", cmd(er.approveEngineeringRelease));
  // SAP commands are generated — mounted dynamically from the codegen registry
  // below (see "Generated commands"), so they are not hand-listed here.
  // ESTER
  app.post("/commands/ester/raise-engineering-change",   cmd(ec.raiseEngineeringChange));
  app.post("/commands/ester/approve-engineering-change", cmd(ec.approveEngineeringChange));
  // Compass
  app.post("/commands/compass/book-production-line", cmd(lb.bookProductionLine));
  // Test
  app.post("/commands/test/record-board-test-pass", cmd(test.recordBoardTestPass));
  app.post("/commands/test/record-fai-pass",        cmd(test.recordFAIPass));
  // Logistics
  app.post("/commands/logistics/pick-and-pack-units",       cmd(ship.pickAndPackUnits));
  app.post("/commands/logistics/dispatch-shipment",         cmd(ship.dispatchShipment));
  app.post("/commands/logistics/confirm-shipment-delivered", cmd(ship.confirmShipmentDelivered));

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

  // -- QUERIES --
  app.get("/queries/list-demands", async () => helixQ.listDemands());
  app.get("/queries/get-demand/:id", async (req) => helixQ.getDemand((req.params as any).id));
  app.get("/queries/get-demand-with-bom-status/:id", async (req) => helixQ.getDemandWithBOMStatus((req.params as any).id));
  app.get("/queries/get-build-with-bom/:id", async (req) => helixQ.getBuildWithBOM((req.params as any).id));
  app.get("/queries/list-builds-at-risk", async () => helixQ.listBuildsAtRisk());
  app.get("/queries/list-builds", async (req) => helixQ.listBuilds((req.query as any)?.buildPlanId));
  app.get("/queries/get-build-plan-disruptions/:demandId", async (req) => helixQ.getBuildPlanDisruptions((req.params as any).demandId));
  app.get("/queries/get-build-plan-lock-readiness/:id", async (req) => helixQ.getBuildPlanLockReadiness((req.params as any).id));
  app.get("/queries/get-build-material-status/:id", async (req) => helixQ.getBuildMaterialStatus((req.params as any).id));
  app.get("/queries/get-build-production-readiness/:id", async (req) => helixQ.getBuildProductionReadiness((req.params as any).id));
  app.get("/queries/list-builds-in-production", async () => helixQ.listBuildsInProduction());
  app.get("/queries/list-builds-ready-for-fai", async () => helixQ.listBuildsReadyForFAI());
  app.get("/queries/get-build-test-status/:id", async (req) => helixQ.getBuildTestStatus((req.params as any).id));
  app.get("/queries/list-builds-ready-for-pack", async () => helixQ.listBuildsReadyForPack());

  app.get("/queries/get-project/:id", async (req) => primQ.getProject((req.params as any).id));
  app.get("/queries/get-project-with-bom/:id", async (req) => primQ.getProjectWithBOM((req.params as any).id));
  app.get("/queries/get-project-status/:id", async (req) => primQ.getProjectStatus((req.params as any).id));
  app.get("/queries/get-bom-item/:id", async (req) => primQ.getBOMItem((req.params as any).id));

  app.get("/queries/list-draft-purchase-orders", async () => sapQ.listDraftPurchaseOrders());
  app.get("/queries/get-purchase-order/:id", async (req) => sapQ.getPurchaseOrder((req.params as any).id));
  app.get("/queries/list-purchase-orders", async (req) => sapQ.listPurchaseOrdersByStatus((req.query as any)?.status));
  app.get("/queries/list-work-orders", async () => sapQ.listWorkOrders());

  app.get("/queries/list-open-engineering-changes", async (req) => esterQ.listOpenEngineeringChanges((req.query as any)?.projectId));
  app.get("/queries/list-engineering-changes", async (req) => esterQ.listEngineeringChanges((req.query as any)?.projectId));

  app.get("/queries/list-production-sites", async () => compassQ.listProductionSites());
  app.get("/queries/list-production-lines", async (req) => compassQ.listProductionLines((req.query as any)?.siteId));
  app.get("/queries/list-line-bookings", async () => compassQ.listLineBookings());

  app.get("/queries/list-test-results", async (req) => testQ.listTestResults((req.query as any)?.buildId));

  app.get("/queries/list-shipments-ready", async () => logisticsQ.listShipmentsReady());
  app.get("/queries/list-shipments", async () => logisticsQ.listShipments());
  app.get("/queries/get-shipment/:id", async (req) => logisticsQ.getShipment((req.params as any).id));
  app.get("/queries/list-units", async (req) => logisticsQ.listUnits((req.query as any)?.buildId));

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
  // Swap preview: read-only diff of what applying the current model to the DB
  // would DROP (data permanently lost), create, and keep. The UI shows this as
  // the irreversible-swap warning before anyone runs `npm run swap --yes`.
  app.get("/api/model/swap-preview", async () => swapPreview());
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

  // -- MODEL SYNC & VERSION HISTORY --
  // Pull the latest workflow.json from the Qlerify modeller, snapshot it, and
  // hot-reload. Version history supports rolling back and forward.
  app.get("/api/model/status", async () => modelStatus());
  // Metadata + content for the in-app viewer dialog.
  app.get("/api/model/file", async (_req, reply) => {
    try {
      return modelFile();
    } catch (err: any) {
      return reply.code(404).send({ error: "NOT_FOUND", message: err?.message ?? String(err) });
    }
  });
  // Source URL the fetch pulls from (editable override, or the default MCP endpoint).
  app.get("/api/model/source", async () => getModelSource());
  app.put("/api/model/source", async (req, reply) => {
    const url = (req.body as any)?.url;
    if (url != null && typeof url !== "string") {
      return reply.code(400).send({ error: "BAD_REQUEST", message: "url must be a string or null" });
    }
    try {
      writeSourceOverride(url ?? null);
      return getModelSource();
    } catch (err: any) {
      return reply.code(400).send({ error: "BAD_URL", message: err?.message ?? String(err) });
    }
  });
  // Raw workflow.json, openable directly in a browser tab (the "link to it").
  app.get("/api/model/file/raw", async (_req, reply) => {
    try {
      return reply.type("application/json").send(modelFile().content);
    } catch (err: any) {
      return reply.code(404).send({ error: "NOT_FOUND", message: err?.message ?? String(err) });
    }
  });
  app.post("/api/model/fetch", async (_req, reply) => {
    try {
      return await fetchLatestModel();
    } catch (err: any) {
      return reply.code(502).send({ error: "FETCH_FAILED", message: err?.message ?? String(err) });
    }
  });

  // Apply the loaded model: rebuild the overlay + DROP/CREATE the projection
  // tables to match it (in-process, no restart). Destructive by design — the
  // projection tables are disposable. The UI shows a loader and polls
  // /api/model/apply-status while this runs.
  app.post("/api/model/apply", async (req, reply) => {
    const resetOverlay = (req.body as any)?.resetOverlay;
    try {
      const result = await applyModel({ resetOverlay });
      return { ok: true, ...result, status: applyStatus() };
    } catch (err: any) {
      return reply.code(500).send({ error: "APPLY_FAILED", message: err?.message ?? String(err), status: applyStatus() });
    }
  });
  app.get("/api/model/apply-status", async () => applyStatus());
  app.post("/api/model/roll", async (req, reply) => {
    const dir = (req.body as any)?.direction;
    if (dir !== "back" && dir !== "forward") {
      return reply.code(400).send({ error: "BAD_REQUEST", message: 'direction must be "back" or "forward"' });
    }
    try {
      return rollModel(dir);
    } catch (err: any) {
      return reply.code(409).send({ error: "ROLL_FAILED", message: err?.message ?? String(err) });
    }
  });
  // Jump straight to any stored version (the inspect dialog's version sidebar).
  app.post("/api/model/restore", async (req, reply) => {
    const index = (req.body as any)?.index;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
      return reply.code(400).send({ error: "BAD_REQUEST", message: "index must be a non-negative integer" });
    }
    try {
      return restoreModel(index);
    } catch (err: any) {
      return reply.code(409).send({ error: "RESTORE_FAILED", message: err?.message ?? String(err) });
    }
  });

  // -- SIMULATOR SUPPORT --
  // Health of the event registry vs. the loaded model. When the synced
  // workflow.json doesn't match the simulator's 28-step sequence, EVENTS is
  // empty and `error` carries the mismatch — the frontend renders a banner
  // instead of the process crashing at boot. `registryError` is a live binding,
  // so this reflects the current state after any hot-reload.
  app.get("/sim/registry-status", async () => ({
    ok: registryError == null,
    error: registryError,
    eventCount: EVENTS.length,
    // Non-fatal: overlay entries left over from a previous model (regenerate the
    // overlay via the swap to restore curated ordering/phases for those events).
    staleOverlayKeys: getOntology().staleOverlayKeys,
  }));
  app.get("/sim/events", async () => EVENTS);
  app.get("/sim/event-log", async (req) => {
    const limit = Number((req.query as any)?.limit ?? 200);
    const demandId = (req.query as any)?.demandId as string | undefined;
    return prisma.eventLog.findMany({
      where: demandId ? { demandId } : undefined,
      orderBy: { occurredAt: "desc" },
      take: limit,
    });
  });
  app.get("/sim/snapshot", async (req) => {
    const demandId = (req.query as any)?.demandId as string | undefined;
    if (demandId) return demandScopedSnapshot(demandId);
    const [demands, projects, bomItems, ers, ecs, plans, builds, buildDemand, pos, wos, sites, lines, bookings, tests, units, shipments] = await Promise.all([
      prisma.demand.findMany(),
      prisma.project.findMany(),
      prisma.bomItem.findMany(),
      prisma.engineeringRelease.findMany(),
      prisma.engineeringChange.findMany(),
      prisma.buildPlan.findMany(),
      prisma.build.findMany(),
      prisma.buildDemand.findMany(),
      prisma.purchaseOrder.findMany(),
      prisma.workOrder.findMany(),
      prisma.productionSite.findMany(),
      prisma.productionLine.findMany(),
      prisma.lineBooking.findMany(),
      prisma.testResult.findMany(),
      prisma.unit.findMany(),
      prisma.shipment.findMany(),
    ]);
    return {
      Helix: { demands, buildPlans: plans, builds, buildDemand },
      PRIM: { projects, bomItems, engineeringReleases: ers },
      SAP: { purchaseOrders: pos, workOrders: wos },
      ESTER: { engineeringChanges: ecs },
      Compass: { sites, lines, bookings },
      Test: { testResults: tests },
      Logistics: { units, shipments },
    };
  });

  app.get("/sim/health", async () => ({ ok: true, ts: new Date().toISOString() }));

  // Model-derived UI labels for the dashboard — so the header/buttons follow the
  // loaded model instead of hardcoded domain strings. Hot-reloads with the model.
  app.get("/sim/meta", async () => {
    const o = getOntology();
    const singular = o.rootAggregate;
    return {
      title: o.title,
      primaryBoundedContext: o.primaryBoundedContext,
      rootAggregate: singular,
      rootAggregatePlural: pluralize(singular),
      boundedContextCount: o.boundedContexts.length,
      aggregateCount: new Set(o.events.map((e) => e.aggregateRoot).filter(Boolean)).size,
      eventCount: EVENTS.length,
      // Whether the hand-written Ericsson simulator drives this model, or the
      // model-generic simulator. The frontend renders the dashboard accordingly.
      ericsson: isEricssonModel(),
      // True when the projection tables don't match the model yet — the UI
      // auto-rebuilds (with the loader) so no manual "Rebuild" button is needed.
      rebuildNeeded: await rebuildNeeded(),
    };
  });
  // Generic per-run detail (root row + events + rows created in the run) — used
  // by the dashboard detail view for non-Ericsson models.
  app.get("/sim/instance/:id", async (req) => genericInstanceDetail((req.params as any).id));

  // ---------------- Chat assistant ----------------
  app.get("/chat/info", async () => ({
    model: process.env.CHAT_MODEL ?? "claude-sonnet-4-6",
    effort: process.env.CHAT_EFFORT ?? "medium",
    apiKeyConfigured: !!process.env.ANTHROPIC_API_KEY,
    systemPrompt: systemPromptSize(),
    toolCount: 8,
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

  // List all demands with progress (the dashboard's main query). For non-Ericsson
  // models, list the root-aggregate instances via the generic simulator.
  app.get("/sim/demands", async () => {
    if (!isEricssonModel()) return genericListInstances();
    const demands = await prisma.demand.findMany({ orderBy: { createdAt: "desc" } });
    const out: any[] = [];
    const nowMs = Date.now();
    for (const d of demands) {
      const refs = await prisma.eventLog.findMany({
        where: { demandId: d.id },
        distinct: ["eventRef"],
        select: { eventRef: true },
      });
      const last = await prisma.eventLog.findFirst({
        where: { demandId: d.id },
        orderBy: { occurredAt: "desc" },
        select: { eventName: true, eventRef: true, occurredAt: true, businessAt: true, boundedContext: true },
      });
      // dwellSeconds = real wall-clock idleness since the last event the user
      // triggered (good for "how long ago did I click step forward on this one").
      const dwellSeconds = last ? Math.round((nowMs - new Date(last.occurredAt).getTime()) / 1000) : null;
      out.push({ ...d, progress: refs.length, total: EVENTS.length, lastEvent: last, dwellSeconds });
    }
    return out;
  });

  // Create a fresh demand (fires Hardware Demand Created). Guarded: returns a
  // clean 422 when the loaded model isn't the one the simulator is wired to.
  app.post("/sim/demands", async (_req, reply) => {
    try {
      if (isEricssonModel()) return await newDemand();
      const inst = await genericNewInstance();
      return { id: inst.id, template: { aggregate: inst.aggregate } };
    } catch (err) {
      if (isHandledError(err)) return reply.code(err.status).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  app.get("/sim/current-step", async (req) => {
    const demandId = (req.query as any)?.demandId as string | undefined;
    if (!demandId) return { error: "demandId required" };
    if (!isEricssonModel()) return { ...(await genericCurrentStep(demandId)), demandId };
    return { index: await currentStepIndex(demandId), total: EVENTS.length, demandId };
  });

  app.post("/sim/next", async (req, reply) => {
    const body = (req.body ?? {}) as { demandId?: string; withDisruptions?: boolean };
    if (!body.demandId) throw new Error("demandId required");
    try {
      if (!isEricssonModel()) return await genericStep(body.demandId);
      return await nextStep(body.demandId, body.withDisruptions ?? true);
    } catch (err) {
      if (isHandledError(err)) return reply.code(err.status).send({ error: err.code, message: err.message });
      throw err;
    }
  });
  // DELETE — remove an item entirely (the dashboard's ✕). Distinct from /sim/reset.
  // Generic: delete the run's rows (root + everything it created) + its events.
  // Ericsson: resetDemand wipes the demand's whole chain (and the demand row).
  app.post("/sim/delete", async (req) => {
    const body = (req.body ?? {}) as { demandId?: string };
    if (!body.demandId) throw new Error("demandId required");
    if (!isEricssonModel()) await genericDeleteInstance(body.demandId);
    else await resetDemand(body.demandId);
    return { ok: true };
  });

  // RESET — start over / clear (the detail view's Reset button). For a generic
  // model with a demandId this also removes the run; without one it clears all.
  app.post("/sim/reset", async (req) => {
    const body = (req.body ?? {}) as { demandId?: string };
    if (!isEricssonModel()) {
      if (body.demandId) await genericDeleteInstance(body.demandId);
      else await genericDeleteAll();
      return { ok: true };
    }
    if (body.demandId) await resetDemand(body.demandId);
    else await resetAll();
    return { ok: true };
  });
  app.post("/sim/run-all", async (req) => {
    const body = (req.body ?? {}) as { demandId?: string; withDisruptions?: boolean };
    if (!body.demandId) throw new Error("demandId required");
    const steps: any[] = [];
    if (!isEricssonModel()) {
      for (let guard = 0; guard < 500; guard++) {
        const step = await genericStep(body.demandId);
        steps.push(step);
        if (step.done) break;
      }
      return { steps };
    }
    while (true) {
      const idx = await currentStepIndex(body.demandId);
      if (idx >= EVENTS.length) break;
      const step = await nextStep(body.demandId, body.withDisruptions ?? true);
      steps.push(step);
    }
    return { steps };
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

// Snapshot scoped to one demand's chain.
async function demandScopedSnapshot(demandId: string) {
  const project = await prisma.project.findFirst({ where: { demandId } });
  const plans = await prisma.buildPlan.findMany({ where: { demandId } });
  const planIds = plans.map((p) => p.id);
  const builds = await prisma.build.findMany({ where: { buildPlanId: { in: planIds } } });
  const buildIds = builds.map((b) => b.id);
  const projectId = project?.id ?? "__none__";

  const [demands, bomItems, ers, ecs, buildDemand, pos, wos, sites, lines, bookings, tests, units, shipments] = await Promise.all([
    prisma.demand.findMany({ where: { id: demandId } }),
    prisma.bomItem.findMany({ where: { projectId } }),
    prisma.engineeringRelease.findMany({ where: { projectId } }),
    prisma.engineeringChange.findMany({ where: { projectId } }),
    prisma.buildDemand.findMany({ where: { buildId: { in: buildIds } } }),
    prisma.purchaseOrder.findMany({ where: { projectId } }),
    prisma.workOrder.findMany({ where: { buildId: { in: buildIds } } }),
    prisma.productionSite.findMany(),
    prisma.productionLine.findMany(),
    prisma.lineBooking.findMany({ where: { buildId: { in: buildIds } } }),
    prisma.testResult.findMany({ where: { buildId: { in: buildIds } } }),
    prisma.unit.findMany({ where: { buildId: { in: buildIds } } }),
    prisma.shipment.findMany({ where: { demandId } }),
  ]);

  return {
    Helix: { demands, buildPlans: plans, builds, buildDemand },
    PRIM: { projects: project ? [project] : [], bomItems, engineeringReleases: ers },
    SAP: { purchaseOrders: pos, workOrders: wos },
    ESTER: { engineeringChanges: ecs },
    Compass: { sites, lines, bookings },
    Test: { testResults: tests },
    Logistics: { units, shipments },
  };
}
