// HTTP route table. Every command is exposed as a POST under
// /commands/{boundedContext}/{commandName} so the URL itself documents
// the source of truth. Read models are GET under /queries/{name}.
//
// Auth: role taken from `x-role` header; assertRole inside each handler
// enforces the lane→command constraint from the workflow.

import type { FastifyInstance } from "fastify";
import { roleFromRequest } from "../auth.js";
import { isHandledError } from "../errors.js";

// Commands
import * as demand from "../helix/demand/commands.js";
import * as bp from "../helix/buildplan/commands.js";
import * as build from "../helix/build/commands.js";
import * as project from "../prim/project/commands.js";
import * as er from "../prim/engineering-release/commands.js";
import * as po from "../sap/purchase-order/commands.js";
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
import { ontologyView } from "../ontology/model.js";
import { fetchLatestModel, modelStatus, rollModel, restoreModel, modelFile, getModelSource, writeSourceOverride } from "../ontology/sync.js";
import {
  nextStep, currentStepIndex, newDemand, resetDemand, resetAll,
} from "../simulator/stepper.js";
import { runAgentTurn } from "../chat/agent.js";
import { systemPromptSize } from "../chat/system-prompt.js";

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
  // SAP
  app.post("/commands/sap/order-material",         cmd(po.orderMaterial));
  app.post("/commands/sap/confirm-order-with-eta", cmd(po.confirmOrderWithETA));
  app.post("/commands/sap/change-material-eta",    cmd(po.changeMaterialETA));
  app.post("/commands/sap/receive-material",       cmd(po.receiveMaterial));
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

  // List all demands with progress (the dashboard's main query).
  app.get("/sim/demands", async () => {
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

  // Create a fresh demand (fires Hardware Demand Created).
  app.post("/sim/demands", async () => newDemand());

  app.get("/sim/current-step", async (req) => {
    const demandId = (req.query as any)?.demandId as string | undefined;
    if (!demandId) return { error: "demandId required" };
    return { index: await currentStepIndex(demandId), total: EVENTS.length, demandId };
  });

  app.post("/sim/next", async (req) => {
    const body = (req.body ?? {}) as { demandId?: string; withDisruptions?: boolean };
    if (!body.demandId) throw new Error("demandId required");
    return nextStep(body.demandId, body.withDisruptions ?? true);
  });
  app.post("/sim/reset", async (req) => {
    const body = (req.body ?? {}) as { demandId?: string };
    if (body.demandId) await resetDemand(body.demandId);
    else await resetAll();
    return { ok: true };
  });
  app.post("/sim/run-all", async (req) => {
    const body = (req.body ?? {}) as { demandId?: string; withDisruptions?: boolean };
    if (!body.demandId) throw new Error("demandId required");
    const steps: any[] = [];
    while (true) {
      const idx = await currentStepIndex(body.demandId);
      if (idx >= EVENTS.length) break;
      const step = await nextStep(body.demandId, body.withDisruptions ?? true);
      steps.push(step);
    }
    return { steps };
  });
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
