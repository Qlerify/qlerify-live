// Shared test fixture: builds the world up to (and including) a target
// event by replaying earlier commands in the workflow. Each test calls
// world.givenUpTo(eventName) in its Given clause.
//
// The replay sequence mirrors src/simulator/runner.ts; if a test changes,
// update the runner too.

import { execSync } from "node:child_process";
import { prisma } from "../../src/db.js";
import { wireDerivedEvents } from "../../src/events/derived.js";

import { createDemand } from "../../src/helix/demand/commands.js";
import { defineBuildQuantity, updateBuildPlan, lockBuildPlan } from "../../src/helix/buildplan/commands.js";
import {
  specifyMaterialDemand, setBuildPriority, releaseBuildToSite,
  startProduction, markBuildAsRTD,
} from "../../src/helix/build/commands.js";
import {
  createProject, defineBOM, freezeBOMAtDS1, freezeBOMAtDS2,
} from "../../src/prim/project/commands.js";
import { approveEngineeringRelease } from "../../src/prim/engineering-release/commands.js";
import {
  orderMaterial, confirmOrderWithETA, receiveMaterial,
} from "../../src/sap/purchase-order/commands.js";
import {
  raiseEngineeringChange, approveEngineeringChange,
} from "../../src/ester/engineering-change/commands.js";
import { bookProductionLine } from "../../src/compass/line-booking/commands.js";
import { recordBoardTestPass, recordFAIPass } from "../../src/test/test-result/commands.js";
import {
  pickAndPackUnits, dispatchShipment,
} from "../../src/logistics/shipment/commands.js";

export type Stage =
  | "init"
  | "after_demand"
  | "after_project"
  | "after_bom_defined"
  | "after_bom_ds1"
  | "after_build_qty"
  | "after_material_demand"
  | "after_material_ordered"
  | "after_supplier_confirmed"
  | "after_ec_raised"
  | "after_ec_approved"
  | "after_bom_ds2"
  | "after_er_approved"
  | "after_priority"
  | "after_lock"
  | "after_release_to_site"
  | "after_line_booked"
  | "after_material_received"
  | "after_kit_ready"
  | "after_production_started"
  | "after_board_tests"
  | "after_fai"
  | "after_rtd"
  | "after_packed"
  | "after_dispatched";

export interface World {
  demandId: string;
  projectId: string;
  planId: string;
  buildId: string;
  shipmentId?: string;
  bomItemIds: string[];
  poIds: string[];
  ecId?: string;
}

const STAGE_ORDER: Stage[] = [
  "init", "after_demand", "after_project", "after_bom_defined", "after_bom_ds1",
  "after_build_qty", "after_material_demand", "after_material_ordered",
  "after_supplier_confirmed", "after_ec_raised", "after_ec_approved",
  "after_bom_ds2", "after_er_approved", "after_priority", "after_lock",
  "after_release_to_site", "after_line_booked", "after_material_received",
  "after_kit_ready", "after_production_started", "after_board_tests",
  "after_fai", "after_rtd", "after_packed", "after_dispatched",
];

// Returns true while we still need to keep replaying past `reached` toward `target`.
function shouldContinue(target: Stage, reached: Stage): boolean {
  return STAGE_ORDER.indexOf(reached) < STAGE_ORDER.indexOf(target);
}

let seeded = false;

async function ensureSiteSeed() {
  const count = await prisma.productionSite.count();
  if (count === 0) {
    // The Prisma seed isn't part of the test script; recreate sites/lines inline.
    await prisma.productionSite.create({ data: { id: "site-stockholm", name: "Stockholm" } });
    await prisma.productionLine.create({ data: { id: "line-A1", siteId: "site-stockholm", name: "Stockholm A1", capacityPerWeek: 50 } });
  }
}

export async function resetWorld() {
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
  if (!seeded) {
    await ensureSiteSeed();
    wireDerivedEvents();
    seeded = true;
  }
}

export async function givenUpTo(target: Stage): Promise<World> {
  await resetWorld();
  const w: World = {
    demandId: "", projectId: "", planId: "", buildId: "",
    bomItemIds: [], poIds: [],
  };
  if (target === "init") return w;

  const demand = await createDemand(
    { customerId: "cust-10", productName: "Radio Unit X", qty: 2, requestedWeek: "2026-W18" },
    "Product Manager",
  );
  w.demandId = demand.id;
  if (!shouldContinue(target, "after_demand")) return w;

  const project = await createProject(
    { demandId: demand.id, productName: "Radio Unit X" },
    "Product Manager",
  );
  w.projectId = project.id;
  if (!shouldContinue(target, "after_project")) return w;

  const projWithBom = await defineBOM(
    {
      id: project.id,
      bomItems: [
        { partNumber: "PN-4711", qtyPerUnit: 1 },
        { partNumber: "PN-4712", qtyPerUnit: 2 },
      ],
    },
    "Designer",
  );
  w.bomItemIds = projWithBom!.bomItems.map((b) => b.id);
  if (!shouldContinue(target, "after_bom_defined")) return w;

  await freezeBOMAtDS1({ id: project.id }, "Configuration Manager");
  if (!shouldContinue(target, "after_bom_ds1")) return w;

  const plan = await defineBuildQuantity(
    {
      demandId: demand.id,
      builds: [{ buildNo: "B1", qty: 2, plannedStart: "2026-04-20" }],
    },
    "Planner",
  );
  w.planId = plan.id;
  w.buildId = plan.builds[0]!.id;
  if (!shouldContinue(target, "after_build_qty")) return w;

  await specifyMaterialDemand(
    {
      id: w.buildId,
      buildDemand: [
        { partNumber: "PN-4711", qtyRequired: 2 },
        { partNumber: "PN-4712", qtyRequired: 4 },
      ],
    },
    "Supply Planner",
  );
  const pos = await prisma.purchaseOrder.findMany({ where: { projectId: project.id } });
  w.poIds = pos.map((p) => p.id);
  if (!shouldContinue(target, "after_material_demand")) return w;

  for (const poId of w.poIds) {
    await orderMaterial({ id: poId, requestedDate: "2026-04-10" }, "Buyer");
  }
  if (!shouldContinue(target, "after_material_ordered")) return w;

  for (const poId of w.poIds) {
    await confirmOrderWithETA({ id: poId, confirmedEta: "2026-04-12" }, "Supplier");
  }
  if (!shouldContinue(target, "after_supplier_confirmed")) return w;

  const ec = await raiseEngineeringChange(
    { projectId: project.id, bomItemId: w.bomItemIds[0]!, description: "Tolerance update" },
    "Designer",
  );
  w.ecId = ec.id;
  if (!shouldContinue(target, "after_ec_raised")) return w;

  await approveEngineeringChange({ id: ec.id }, "Configuration Manager");
  if (!shouldContinue(target, "after_ec_approved")) return w;

  await freezeBOMAtDS2({ id: project.id }, "Configuration Manager");
  if (!shouldContinue(target, "after_bom_ds2")) return w;

  await approveEngineeringRelease({ projectId: project.id }, "Configuration Manager");
  if (!shouldContinue(target, "after_er_approved")) return w;

  await setBuildPriority({ id: w.buildId, priority: 1 }, "Planner");
  if (!shouldContinue(target, "after_priority")) return w;

  await lockBuildPlan({ id: plan.id }, "Planner");
  if (!shouldContinue(target, "after_lock")) return w;

  await releaseBuildToSite({ id: w.buildId, siteId: "site-stockholm" }, "Planner");
  if (!shouldContinue(target, "after_release_to_site")) return w;

  await bookProductionLine(
    {
      lineId: "line-A1",
      buildId: w.buildId,
      plannedStart: "2026-04-21T08:00:00Z",
      plannedEnd: "2026-04-25T17:00:00Z",
    },
    "Production Planner",
  );
  if (!shouldContinue(target, "after_line_booked")) return w;

  for (const poId of w.poIds) {
    await receiveMaterial({ id: poId, actualReceiptDate: "2026-04-12" }, "Goods Receiving");
  }
  if (!shouldContinue(target, "after_material_received")) return w;

  // Kit Ready fires automatically via derived event (target "after_kit_ready" same as after_material_received in this flow)
  if (!shouldContinue(target, "after_kit_ready")) return w;

  await startProduction({ id: w.buildId, actualStart: "2026-04-21T08:00:00Z" }, "Production");
  if (!shouldContinue(target, "after_production_started")) return w;

  for (let i = 1; i <= 2; i++) {
    await recordBoardTestPass(
      { buildId: w.buildId, unitSerial: `B1-SN-${i.toString().padStart(4, "0")}`, executedAt: "2026-04-22T10:00:00Z" },
      "Test Engineer",
    );
  }
  if (!shouldContinue(target, "after_board_tests")) return w;

  await recordFAIPass(
    { buildId: w.buildId, unitSerial: "B1-SN-0001", executedAt: "2026-04-23T14:00:00Z" },
    "Quality Engineer",
  );
  if (!shouldContinue(target, "after_fai")) return w;

  await markBuildAsRTD({ id: w.buildId, actualEnd: "2026-04-25T17:00:00Z" }, "Quality Engineer");
  if (!shouldContinue(target, "after_rtd")) return w;

  const shipment = await pickAndPackUnits(
    { demandId: demand.id, buildId: w.buildId, packedAt: "2026-04-26T09:00:00Z" },
    "Warehouse",
  );
  w.shipmentId = shipment!.id;
  if (!shouldContinue(target, "after_packed")) return w;

  await dispatchShipment({ id: w.shipmentId!, shippedAt: "2026-04-26T15:00:00Z" }, "Logistics");
  if (!shouldContinue(target, "after_dispatched")) return w;

  return w;
}

export async function lastEventRef(): Promise<string | null> {
  const ev = await prisma.eventLog.findFirst({ orderBy: { occurredAt: "desc" } });
  return ev?.eventRef ?? null;
}

export async function eventLogged(ref: string): Promise<boolean> {
  const count = await prisma.eventLog.count({ where: { eventRef: ref } });
  return count > 0;
}

export async function applyPrismaPush() {
  try {
    execSync("npx prisma db push --skip-generate", { stdio: "ignore" });
  } catch {
    // ignore; assume already applied
  }
}
