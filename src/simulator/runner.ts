// Scripted simulator that fires all 28 events end-to-end.
// Each step calls a command handler directly (in-process, no HTTP) so the
// runner doubles as a smoke test of the whole domain model.

import { prisma } from "../db.js";
import { wireDerivedEvents } from "../events/derived.js";

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

export interface RunOptions {
  reset?: boolean;        // wipe transactional state first
  withDisruptions?: boolean; // also fire the ETA-slip and engineering-change cascades
}

export async function runHappyPath(opts: RunOptions = {}): Promise<{ events: number }> {
  wireDerivedEvents();

  if (opts.reset) await resetTransactionalState();

  // 1 — Hardware Demand Created
  const demand = await createDemand(
    { customerId: "cust-10", productName: "Radio Unit X", qty: 4, requestedWeek: "2026-W18" },
    "Product Manager",
  );

  // 2 — Project Created
  const project = await createProject(
    { demandId: demand.id, productName: "Radio Unit X" },
    "Product Manager",
  );

  // 3 — BOM Defined
  await defineBOM(
    {
      id: project.id,
      bomItems: [
        { partNumber: "PN-4711", qtyPerUnit: 1 },
        { partNumber: "PN-4712", qtyPerUnit: 2 },
        { partNumber: "PN-4713", qtyPerUnit: 4 },
      ],
    },
    "Designer",
  );

  // 4 — BOM Frozen At DS1
  await freezeBOMAtDS1({ id: project.id }, "Configuration Manager");

  // 5 — Build Quantity Defined
  const plan = await defineBuildQuantity(
    {
      demandId: demand.id,
      builds: [{ buildNo: "B1", qty: 4, plannedStart: "2026-04-20" }],
    },
    "Planner",
  );
  const build = plan.builds[0]!;

  // 6 — Material Demand Specified
  await specifyMaterialDemand(
    {
      id: build.id,
      buildDemand: [
        { partNumber: "PN-4711", qtyRequired: 4 },
        { partNumber: "PN-4712", qtyRequired: 8 },
        { partNumber: "PN-4713", qtyRequired: 16 },
      ],
    },
    "Supply Planner",
  );

  // 7 — Material Ordered  (all draft POs for this project)
  const draftPOs = await prisma.purchaseOrder.findMany({
    where: { projectId: project.id, status: "DRAFT" },
  });
  for (const po of draftPOs) {
    await orderMaterial({ id: po.id, requestedDate: "2026-04-10" }, "Buyer");
  }

  // 8 — Supplier Confirmed Order With ETA
  for (const po of draftPOs) {
    await confirmOrderWithETA({ id: po.id, confirmedEta: "2026-04-12" }, "Supplier");
  }

  if (opts.withDisruptions) {
    // 9 — Material ETA Changed (one PO slips past plannedStart → derived 10)
    await changeMaterialETA(
      { id: draftPOs[0]!.id, confirmedEta: "2026-04-25" },
      "Supplier",
    );
  }

  // 11 — Engineering Change Raised
  const bomItem = await prisma.bomItem.findFirst({ where: { projectId: project.id } });
  const ec = await raiseEngineeringChange(
    {
      projectId: project.id,
      bomItemId: bomItem!.id,
      description: "Tolerance change on PN-4711",
    },
    "Designer",
  );

  // 12 — Engineering Change Approved
  await approveEngineeringChange({ id: ec.id }, "Configuration Manager");

  // 13 — BOM Frozen At DS2
  await freezeBOMAtDS2({ id: project.id }, "Configuration Manager");

  // 14 — Engineering Release Approved
  await approveEngineeringRelease({ projectId: project.id }, "Configuration Manager");

  // 15 — Build Priority Set
  await setBuildPriority({ id: build.id, priority: 1 }, "Planner");

  // 16 — Build Plan Updated (optional replan)
  if (opts.withDisruptions) {
    await updateBuildPlan(
      { demandId: demand.id, reason: "ER_APPROVED" },
      "Planner",
    );
  }

  // 17 — Build Plan Locked
  await lockBuildPlan({ id: plan.id }, "Configuration Manager");

  // 18 — Build Released To Site
  await releaseBuildToSite({ id: build.id, siteId: "site-stockholm" }, "Planner");

  // 19 — Production Line Booked
  await bookProductionLine(
    {
      lineId: "line-A1",
      buildId: build.id,
      plannedStart: "2026-04-21T08:00:00Z",
      plannedEnd: "2026-04-25T17:00:00Z",
    },
    "Production Planner",
  );

  // 20 — Material Received At Site (all confirmed POs)
  const confirmedPOs = await prisma.purchaseOrder.findMany({
    where: { projectId: project.id, status: "CONFIRMED" },
  });
  for (const po of confirmedPOs) {
    await receiveMaterial({ id: po.id, actualReceiptDate: "2026-04-12" }, "Goods Receiving");
  }
  // 21 — Material Kit Completed fires automatically via derived events

  // 22 — Production Started
  await startProduction(
    { id: build.id, actualStart: "2026-04-21T08:00:00Z" },
    "Production",
  );

  // 23 — Board Test Passed (one per unit)
  for (let i = 1; i <= build.qty; i++) {
    await recordBoardTestPass(
      {
        buildId: build.id,
        unitSerial: `B1-SN-${i.toString().padStart(4, "0")}`,
        executedAt: "2026-04-22T10:00:00Z",
      },
      "Test Engineer",
    );
  }

  // 24 — First Article Inspection Passed
  await recordFAIPass(
    {
      buildId: build.id,
      unitSerial: "B1-SN-0001",
      executedAt: "2026-04-23T14:00:00Z",
    },
    "Quality Engineer",
  );

  // 25 — Build Reached RTD (also creates the N units)
  await markBuildAsRTD(
    { id: build.id, actualEnd: "2026-04-25T17:00:00Z" },
    "Quality Engineer",
  );

  // 26 — Units Picked And Packed
  const shipment = await pickAndPackUnits(
    { demandId: demand.id, buildId: build.id, packedAt: "2026-04-26T09:00:00Z" },
    "Warehouse",
  );

  // 27 — Shipment Dispatched
  await dispatchShipment({ id: shipment!.id, shippedAt: "2026-04-26T15:00:00Z" }, "Logistics");

  // 28 — Unit Received By Customer
  await confirmShipmentDelivered({ id: shipment!.id, deliveredAt: "2026-04-30T11:00:00Z" }, "Customer");

  const events = await prisma.eventLog.count();
  return { events };
}

export async function resetTransactionalState() {
  // Delete in dependency order; leave production_site / production_line seeds.
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

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const withDisruptions = process.argv.includes("--with-disruptions");
  runHappyPath({ reset: true, withDisruptions })
    .then((r) => {
      console.log(`simulator complete: ${r.events} events recorded`);
      return prisma.$disconnect();
    })
    .catch(async (err) => {
      console.error("simulator failed:", err);
      await prisma.$disconnect();
      process.exit(1);
    });
}
