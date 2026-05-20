import { describe, it, expect } from "vitest";
import { prisma } from "../../src/db.js";
import {
  specifyMaterialDemand, flagMaterialShortage, setBuildPriority,
  releaseBuildToSite, completeMaterialKit, startProduction, markBuildAsRTD,
} from "../../src/helix/build/commands.js";
import { givenUpTo, eventLogged } from "../helpers/world.js";

describe("Specify Material Demand", () => {
  it("Given builds exist, When the supply planner specifies material demand, Then build_demand rows and draft purchase_orders are created", async () => {
    const w = await givenUpTo("after_build_qty");
    await specifyMaterialDemand(
      {
        id: w.buildId,
        buildDemand: [
          { partNumber: "PN-4711", qtyRequired: 4 },
          { partNumber: "PN-4712", qtyRequired: 8 },
        ],
      },
      "Supply Planner",
    );
    const demand = await prisma.buildDemand.findMany({ where: { buildId: w.buildId } });
    const pos = await prisma.purchaseOrder.findMany({ where: { status: "DRAFT" } });
    expect(demand.length).toBe(2);
    expect(pos.length).toBeGreaterThanOrEqual(2);
    expect(await eventLogged("#/domainEvents/MaterialDemandSpecified")).toBe(true);
  });
});

describe("Flag Material Shortage", () => {
  it("Given a purchase order confirmed_eta is later than a build planned_start, When the simulator detects the shortage, Then the build material_status becomes AT_RISK", async () => {
    const w = await givenUpTo("after_supplier_confirmed");
    const updated = await flagMaterialShortage({ id: w.buildId }, "Automation");
    expect(updated.materialStatus).toBe("AT_RISK");
    expect(await eventLogged("#/domainEvents/MaterialShortageIdentified")).toBe(true);
  });
});

describe("Set Build Priority", () => {
  it("Given builds exist, When the planner sets priority, Then build.priority is updated", async () => {
    const w = await givenUpTo("after_build_qty");
    const updated = await setBuildPriority({ id: w.buildId, priority: 7 }, "Planner");
    expect(updated.priority).toBe(7);
    expect(await eventLogged("#/domainEvents/BuildPrioritySet")).toBe(true);
  });
});

describe("Release Build To Site", () => {
  it("Given the build_plan is LOCKED, When the HWM releases the build to a site, Then build.site_id is set, build.status becomes RELEASED, and build_plan.status becomes RELEASED", async () => {
    const w = await givenUpTo("after_lock");
    const updated = await releaseBuildToSite(
      { id: w.buildId, siteId: "site-stockholm" },
      "Planner",
    );
    expect(updated.status).toBe("RELEASED");
    expect(updated.siteId).toBe("site-stockholm");
    const plan = await prisma.buildPlan.findUnique({ where: { id: w.planId } });
    expect(plan?.status).toBe("RELEASED");
    expect(await eventLogged("#/domainEvents/BuildReleasedToSite")).toBe(true);
  });

  it("rejects when plan is not LOCKED", async () => {
    const w = await givenUpTo("after_priority");
    await expect(
      releaseBuildToSite({ id: w.buildId, siteId: "site-stockholm" }, "Planner"),
    ).rejects.toThrow(/must be LOCKED/);
  });
});

describe("Complete Material Kit", () => {
  it("Given every build_demand for a build has qty_available >= qty_required, When the simulator detects completion, Then build.material_status becomes KIT_READY", async () => {
    const w = await givenUpTo("after_material_received");
    // The derived event should already have fired automatically when material was received.
    const build = await prisma.build.findUnique({ where: { id: w.buildId } });
    expect(build?.materialStatus).toBe("KIT_READY");
    expect(await eventLogged("#/domainEvents/MaterialKitCompleted")).toBe(true);
  });

  it("rejects when build_demand still has under-supplied parts", async () => {
    const w = await givenUpTo("after_supplier_confirmed");
    await expect(
      completeMaterialKit({ id: w.buildId }, "Automation"),
    ).rejects.toThrow(/under-supplied/);
  });
});

describe("Start Production", () => {
  it("Given the line is BOOKED and material is KIT_READY, When production begins, Then line_booking.status becomes RUNNING and build.status becomes IN_PROGRESS with actual_start set", async () => {
    const w = await givenUpTo("after_kit_ready");
    const updated = await startProduction(
      { id: w.buildId, actualStart: "2026-04-21T08:00:00Z" },
      "Production",
    );
    expect(updated.status).toBe("IN_PROGRESS");
    expect(updated.actualStart).toBe("2026-04-21T08:00:00Z");
    const booking = await prisma.lineBooking.findFirst({ where: { buildId: w.buildId } });
    expect(booking?.status).toBe("RUNNING");
    expect(await eventLogged("#/domainEvents/ProductionStarted")).toBe(true);
  });
});

describe("Mark Build As RTD", () => {
  it("Given FAI passed and qty produced, When the build reaches RTD, Then build.status becomes RTD with actual_end set, line_booking.status becomes DONE, work_order.status becomes CLOSED, and N unit rows with status BUILT are created", async () => {
    const w = await givenUpTo("after_fai");
    await markBuildAsRTD({ id: w.buildId, actualEnd: "2026-04-25T17:00:00Z" }, "Quality Engineer");
    const build = await prisma.build.findUnique({ where: { id: w.buildId } });
    expect(build?.status).toBe("RTD");
    const booking = await prisma.lineBooking.findFirst({ where: { buildId: w.buildId } });
    expect(booking?.status).toBe("DONE");
    const wo = await prisma.workOrder.findFirst({ where: { buildId: w.buildId } });
    expect(wo?.status).toBe("CLOSED");
    const units = await prisma.unit.count({ where: { buildId: w.buildId } });
    expect(units).toBe(build!.qty);
    expect(await eventLogged("#/domainEvents/BuildReachedRTD")).toBe(true);
  });
});
