// Per-demand step engine. Drives one demand's 28-event journey at a time.
// Each step body scopes every DB lookup to the supplied demandId, so multiple
// demands can be in flight concurrently without interfering.

import { prisma } from "../db.js";
import { wireDerivedEvents } from "../events/derived.js";
import { setBusinessClock, businessTimeForStep } from "../events/clock.js";
import { createDemand } from "../helix/demand/commands.js";
import { defineBuildQuantity, updateBuildPlan, lockBuildPlan } from "../helix/buildplan/commands.js";
import {
  specifyMaterialDemand, setBuildPriority, releaseBuildToSite,
  startProduction, markBuildAsRTD,
} from "../helix/build/commands.js";
import {
  createProject, defineBOM, freezeBOMAtDS1, freezeBOMAtDS2,
} from "../prim/project/commands.js";
import { approveEngineeringRelease } from "../prim/engineering-release/commands.js";
import {
  orderMaterial, confirmOrderWithETA, changeMaterialETA, receiveMaterial,
} from "../sap/purchase-order/commands.js";
import {
  raiseEngineeringChange, approveEngineeringChange,
} from "../ester/engineering-change/commands.js";
import { bookProductionLine } from "../compass/line-booking/commands.js";
import { recordBoardTestPass, recordFAIPass } from "../test/test-result/commands.js";
import {
  pickAndPackUnits, dispatchShipment, confirmShipmentDelivered,
} from "../logistics/shipment/commands.js";

import { EVENTS, type EventDef } from "../events/registry.js";

export interface StepResult {
  index: number;
  event: EventDef;
  caption: string;
  done: boolean;
  demandId: string;
}

// ---------------------------------------------------------------------------
// Per-demand lookup helpers
// ---------------------------------------------------------------------------

async function demand(demandId: string) {
  return prisma.demand.findUniqueOrThrow({ where: { id: demandId } });
}
async function project(demandId: string) {
  return prisma.project.findFirstOrThrow({ where: { demandId } });
}
async function latestPlan(demandId: string) {
  return prisma.buildPlan.findFirstOrThrow({
    where: { demandId },
    orderBy: { versionNo: "desc" },
  });
}
async function activeBuild(demandId: string) {
  const plan = await latestPlan(demandId);
  return prisma.build.findFirstOrThrow({ where: { buildPlanId: plan.id } });
}

// Defaults used to seed a new demand — kept here so the dashboard can create one with one click.
const DEFAULT_DEMAND_TEMPLATES = [
  { customerId: "cust-10", productName: "Radio Unit X", qty: 4, requestedWeek: "2026-W18" },
  { customerId: "cust-22", productName: "Baseband 6630", qty: 8, requestedWeek: "2026-W22" },
  { customerId: "cust-07", productName: "Antenna AIR 3239", qty: 12, requestedWeek: "2026-W30" },
  { customerId: "cust-15", productName: "Radio Unit X", qty: 2, requestedWeek: "2026-W26" },
];

export async function newDemand(): Promise<{ id: string; template: typeof DEFAULT_DEMAND_TEMPLATES[number] }> {
  wireDerivedEvents();
  const existing = await prisma.demand.count();
  const tmpl = DEFAULT_DEMAND_TEMPLATES[existing % DEFAULT_DEMAND_TEMPLATES.length]!;
  setBusinessClock(businessTimeForStep(0));
  try {
    const d = await createDemand(tmpl, "Product Manager");
    return { id: d.id, template: tmpl };
  } finally {
    setBusinessClock(null);
  }
}

// ---------------------------------------------------------------------------
// Step bodies — index 0 is "Hardware Demand Created", already covered by newDemand().
// Steps 1..27 advance a demand once it exists.
// ---------------------------------------------------------------------------

async function runStep(index: number, demandId: string, withDisruptions: boolean): Promise<string> {
  switch (index) {
    case 0: {
      // Hardware Demand Created — this stepper expects the demand to already
      // exist (created via POST /sim/demands). The marker record will be
      // written by nextStep() to advance currentStepIndex.
      const d = await demand(demandId);
      return `Demand ${d.id.slice(0,12)}… for ${d.qty} × ${d.productName} (week ${d.requestedWeek})`;
    }
    case 1: {
      const d = await demand(demandId);
      await createProject({ demandId, productName: d.productName }, "Product Manager");
      return `PM creates PRIM project for ${d.productName}`;
    }
    case 2: {
      const p = await project(demandId);
      await defineBOM(
        {
          id: p.id,
          bomItems: [
            { partNumber: "PN-4711", qtyPerUnit: 1 },
            { partNumber: "PN-4712", qtyPerUnit: 2 },
            { partNumber: "PN-4713", qtyPerUnit: 4 },
          ],
        },
        "Designer",
      );
      return "Designer drafts 3 BOM lines (PN-4711, PN-4712, PN-4713)";
    }
    case 3: {
      const p = await project(demandId);
      await freezeBOMAtDS1({ id: p.id }, "Configuration Manager");
      return "CM freezes BOM at design state DS1";
    }
    case 4: {
      const d = await demand(demandId);
      await defineBuildQuantity(
        { demandId, builds: [{ buildNo: "B1", qty: d.qty, plannedStart: "2026-04-20" }] },
        "Planner",
      );
      return `Planner schedules 1 build of qty ${d.qty} starting 2026-04-20`;
    }
    case 5: {
      const b = await activeBuild(demandId);
      const factor = b.qty;
      await specifyMaterialDemand(
        {
          id: b.id,
          buildDemand: [
            { partNumber: "PN-4711", qtyRequired: 1 * factor },
            { partNumber: "PN-4712", qtyRequired: 2 * factor },
            { partNumber: "PN-4713", qtyRequired: 4 * factor },
          ],
        },
        "Supply Planner",
      );
      return "Supply Planner specifies material demand (Helix → SAP creates draft POs)";
    }
    case 6: {
      const p = await project(demandId);
      const drafts = await prisma.purchaseOrder.findMany({ where: { projectId: p.id, status: "DRAFT" } });
      for (const po of drafts) await orderMaterial({ id: po.id, requestedDate: "2026-04-10" }, "Buyer");
      return `Buyer orders ${drafts.length} parts`;
    }
    case 7: {
      const p = await project(demandId);
      const ordered = await prisma.purchaseOrder.findMany({ where: { projectId: p.id, status: "ORDERED" } });
      for (const po of ordered) await confirmOrderWithETA({ id: po.id, confirmedEta: "2026-04-12" }, "Supplier");
      return `Supplier confirms ${ordered.length} POs with ETA 2026-04-12`;
    }
    case 8: {
      if (!withDisruptions) return "(skipped — disruptions disabled)";
      const p = await project(demandId);
      const po = await prisma.purchaseOrder.findFirst({ where: { projectId: p.id, status: "CONFIRMED" } });
      if (!po) return "(no PO to slip)";
      await changeMaterialETA({ id: po.id, confirmedEta: "2026-04-25" }, "Supplier");
      return `Supplier slips PO ${po.partNumber} ETA to 2026-04-25 (after planned_start)`;
    }
    case 9: {
      if (!withDisruptions) return "(skipped — derived event fires only after ETA slip)";
      const b = await activeBuild(demandId);
      return b.materialStatus === "AT_RISK"
        ? `Simulator flags build ${b.buildNo} as AT_RISK (derived from ETA slip)`
        : "(no shortage detected)";
    }
    case 10: {
      const p = await project(demandId);
      const bomItem = await prisma.bomItem.findFirstOrThrow({ where: { projectId: p.id } });
      await raiseEngineeringChange(
        { projectId: p.id, bomItemId: bomItem.id, description: "Tolerance update on PN-4711" },
        "Designer",
      );
      return "Designer raises an engineering change on PN-4711";
    }
    case 11: {
      const p = await project(demandId);
      const open = await prisma.engineeringChange.findFirstOrThrow({ where: { projectId: p.id, status: "OPEN" } });
      await approveEngineeringChange({ id: open.id }, "Configuration Manager");
      return "CM approves the engineering change";
    }
    case 12: {
      const p = await project(demandId);
      await freezeBOMAtDS2({ id: p.id }, "Configuration Manager");
      return "CM freezes BOM at DS2_PROD (production-ready)";
    }
    case 13: {
      const p = await project(demandId);
      await approveEngineeringRelease({ projectId: p.id }, "Configuration Manager");
      return "CM approves the engineering release (design package signed off)";
    }
    case 14: {
      const b = await activeBuild(demandId);
      await setBuildPriority({ id: b.id, priority: 1 }, "Planner");
      return "Planner sets build priority to 1";
    }
    case 15: {
      if (!withDisruptions) return "(skipped — replan trigger disabled)";
      await updateBuildPlan({ demandId, reason: "ER_APPROVED" }, "Planner");
      return "Planner publishes a new plan version (replanning after ER)";
    }
    case 16: {
      const plan = await prisma.buildPlan.findFirstOrThrow({
        where: { demandId, status: "DRAFT" },
        orderBy: { versionNo: "desc" },
      });
      await lockBuildPlan({ id: plan.id }, "Planner");
      return "🔒 Planner locks the build plan — no further changes to build_demand";
    }
    case 17: {
      const b = await prisma.build.findFirstOrThrow({
        where: { buildPlan: { demandId }, status: "PLANNED" },
      });
      await releaseBuildToSite({ id: b.id, siteId: "site-stockholm" }, "Planner");
      return "Planner releases build to site Stockholm";
    }
    case 18: {
      const b = await prisma.build.findFirstOrThrow({
        where: { buildPlan: { demandId }, status: "RELEASED" },
      });
      await bookProductionLine(
        {
          lineId: "line-A1",
          buildId: b.id,
          plannedStart: "2026-04-21T08:00:00Z",
          plannedEnd: "2026-04-25T17:00:00Z",
        },
        "Production Planner",
      );
      return "Production Planner books Stockholm line A1";
    }
    case 19: {
      const p = await project(demandId);
      const confirmed = await prisma.purchaseOrder.findMany({ where: { projectId: p.id, status: "CONFIRMED" } });
      for (const po of confirmed) await receiveMaterial({ id: po.id, actualReceiptDate: "2026-04-12" }, "Goods Receiving");
      return `Goods Receiving books in ${confirmed.length} POs (qty_available updated)`;
    }
    case 20: {
      const b = await prisma.build.findFirst({ where: { buildPlan: { demandId }, materialStatus: "KIT_READY" } });
      return b
        ? `Simulator marks build ${b.buildNo} as KIT_READY (derived AND-gate)`
        : "(kit not yet complete)";
    }
    case 21: {
      const b = await prisma.build.findFirstOrThrow({
        where: { buildPlan: { demandId }, materialStatus: "KIT_READY", status: "RELEASED" },
      });
      await startProduction({ id: b.id, actualStart: "2026-04-21T08:00:00Z" }, "Production");
      return "Production starts on the line (status IN_PROGRESS)";
    }
    case 22: {
      const b = await prisma.build.findFirstOrThrow({
        where: { buildPlan: { demandId }, status: "IN_PROGRESS" },
      });
      for (let i = 1; i <= b.qty; i++) {
        await recordBoardTestPass(
          {
            buildId: b.id,
            unitSerial: `${b.buildNo}-SN-${i.toString().padStart(4, "0")}`,
            executedAt: "2026-04-22T10:00:00Z",
          },
          "Test Engineer",
        );
      }
      return `Test Engineer records ${b.qty} board-test passes`;
    }
    case 23: {
      const b = await prisma.build.findFirstOrThrow({
        where: { buildPlan: { demandId }, status: "IN_PROGRESS" },
      });
      await recordFAIPass(
        { buildId: b.id, unitSerial: `${b.buildNo}-SN-0001`, executedAt: "2026-04-23T14:00:00Z" },
        "Quality Engineer",
      );
      return "Quality Engineer records the FAI pass";
    }
    case 24: {
      const b = await prisma.build.findFirstOrThrow({
        where: { buildPlan: { demandId }, status: "IN_PROGRESS" },
      });
      await markBuildAsRTD({ id: b.id, actualEnd: "2026-04-25T17:00:00Z" }, "Quality Engineer");
      return `Build reaches RTD — ${b.qty} units created in Logistics`;
    }
    case 25: {
      const b = await prisma.build.findFirstOrThrow({ where: { buildPlan: { demandId }, status: "RTD" } });
      await pickAndPackUnits(
        { demandId, buildId: b.id, packedAt: "2026-04-26T09:00:00Z" },
        "Warehouse",
      );
      return "Warehouse picks and packs the units (shipment READY)";
    }
    case 26: {
      const s = await prisma.shipment.findFirstOrThrow({ where: { demandId, status: "READY" } });
      await dispatchShipment({ id: s.id, shippedAt: "2026-04-26T15:00:00Z" }, "Logistics");
      return "Logistics dispatches the shipment (IN_TRANSIT)";
    }
    case 27: {
      const s = await prisma.shipment.findFirstOrThrow({ where: { demandId, status: "IN_TRANSIT" } });
      await confirmShipmentDelivered({ id: s.id, deliveredAt: "2026-04-30T11:00:00Z" }, "Customer");
      return "Customer confirms receipt — demand DELIVERED ✅";
    }
    default:
      throw new Error(`unknown step ${index}`);
  }
}

export async function currentStepIndex(demandId: string): Promise<number> {
  const refsFired = await prisma.eventLog.findMany({
    where: { demandId },
    distinct: ["eventRef"],
    select: { eventRef: true },
  });
  const fired = new Set(refsFired.map((r) => r.eventRef));
  for (let i = 0; i < EVENTS.length; i++) {
    if (!fired.has(EVENTS[i]!.ref)) return i;
  }
  return EVENTS.length;
}

export async function nextStep(demandId: string, withDisruptions = true): Promise<StepResult> {
  wireDerivedEvents();
  const idx = await currentStepIndex(demandId);
  if (idx >= EVENTS.length) {
    return { index: idx, event: EVENTS[EVENTS.length - 1]!, caption: "(simulation complete)", done: true, demandId };
  }
  const event = EVENTS[idx]!;
  const businessAt = businessTimeForStep(idx);
  setBusinessClock(businessAt);
  try {
    const before = await prisma.eventLog.count({ where: { eventRef: event.ref, demandId } });
    const caption = await runStep(idx, demandId, withDisruptions);
    const after = await prisma.eventLog.count({ where: { eventRef: event.ref, demandId } });

    // No-op step (skipped or just an observational caption) — leave a marker
    // so currentStepIndex advances.
    if (after === before) {
      await prisma.eventLog.create({
        data: {
          eventName: event.name,
          eventRef: event.ref,
          boundedContext: event.boundedContext,
          aggregateRoot: event.aggregateRoot,
          aggregateId: "",
          demandId,
          role: event.role,
          payload: JSON.stringify({ skipped: true, caption }),
          businessAt,
        },
      });
    }

    return { index: idx, event, caption, done: idx + 1 >= EVENTS.length, demandId };
  } finally {
    setBusinessClock(null);
  }
}

export async function resetDemand(demandId: string) {
  // Wipe only this demand's chain. Reference data (sites, lines) is untouched.
  const project = await prisma.project.findFirst({ where: { demandId } });
  const plans = await prisma.buildPlan.findMany({ where: { demandId } });
  const builds = await prisma.build.findMany({ where: { buildPlanId: { in: plans.map((p) => p.id) } } });
  const buildIds = builds.map((b) => b.id);

  await prisma.$transaction([
    prisma.eventLog.deleteMany({ where: { demandId } }),
    prisma.unit.deleteMany({ where: { buildId: { in: buildIds } } }),
    prisma.shipment.deleteMany({ where: { demandId } }),
    prisma.testResult.deleteMany({ where: { buildId: { in: buildIds } } }),
    prisma.lineBooking.deleteMany({ where: { buildId: { in: buildIds } } }),
    prisma.workOrder.deleteMany({ where: { buildId: { in: buildIds } } }),
    prisma.purchaseOrder.deleteMany({ where: { projectId: project?.id ?? "__none__" } }),
    prisma.engineeringChange.deleteMany({ where: { projectId: project?.id ?? "__none__" } }),
    prisma.engineeringRelease.deleteMany({ where: { projectId: project?.id ?? "__none__" } }),
    prisma.bomItem.deleteMany({ where: { projectId: project?.id ?? "__none__" } }),
    prisma.buildDemand.deleteMany({ where: { buildId: { in: buildIds } } }),
    prisma.build.deleteMany({ where: { id: { in: buildIds } } }),
    prisma.buildPlan.deleteMany({ where: { demandId } }),
    prisma.project.deleteMany({ where: { demandId } }),
    prisma.demand.deleteMany({ where: { id: demandId } }),
  ]);
}

export async function resetAll() {
  await prisma.$transaction([
    prisma.eventLog.deleteMany(),
    prisma.unit.deleteMany(),
    prisma.shipment.deleteMany(),
    prisma.testResult.deleteMany(),
    prisma.lineBooking.deleteMany(),
    prisma.workOrder.deleteMany(),
    prisma.purchaseOrder.deleteMany(),
    prisma.engineeringChange.deleteMany(),
    prisma.engineeringRelease.deleteMany(),
    prisma.bomItem.deleteMany(),
    prisma.buildDemand.deleteMany(),
    prisma.build.deleteMany(),
    prisma.buildPlan.deleteMany(),
    prisma.project.deleteMany(),
    prisma.demand.deleteMany(),
  ]);
}
