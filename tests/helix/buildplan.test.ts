import { describe, it, expect } from "vitest";
import { prisma } from "../../src/db.js";
import {
  defineBuildQuantity, updateBuildPlan, lockBuildPlan,
} from "../../src/helix/buildplan/commands.js";
import { givenUpTo, eventLogged } from "../helpers/world.js";

describe("Define Build Quantity", () => {
  it("Given the BOM is frozen at DS1, When the planner defines the build quantity, Then a build_plan v1 with status DRAFT and N builds with status PLANNED are created", async () => {
    const w = await givenUpTo("after_bom_ds1");
    const plan = await defineBuildQuantity(
      {
        demandId: w.demandId,
        builds: [
          { buildNo: "B1", qty: 5, plannedStart: "2026-04-20" },
          { buildNo: "B2", qty: 3, plannedStart: "2026-04-25" },
        ],
      },
      "Planner",
    );
    expect(plan.status).toBe("DRAFT");
    expect(plan.versionNo).toBe(1);
    expect(plan.builds.length).toBe(2);
    expect(plan.builds.every((b) => b.status === "PLANNED")).toBe(true);
    expect(await eventLogged("#/domainEvents/BuildQuantityDefined")).toBe(true);
  });

  it("rejects when BOM is not frozen at DS1", async () => {
    const w = await givenUpTo("after_bom_defined");
    await expect(
      defineBuildQuantity(
        { demandId: w.demandId, builds: [{ buildNo: "B1", qty: 1, plannedStart: "2026-04-20" }] },
        "Planner",
      ),
    ).rejects.toThrow(/not frozen at DS1/);
  });
});

describe("Update Build Plan", () => {
  it("Given an ETA change, ER approval, priority change, or site change occurred, When the planner triggers a replan, Then a new build_plan version with status DRAFT is created and the previous version is archived", async () => {
    const w = await givenUpTo("after_priority");
    const newPlan = await updateBuildPlan(
      { demandId: w.demandId, reason: "ER_APPROVED" },
      "Planner",
    );
    expect(newPlan.status).toBe("DRAFT");
    expect(newPlan.versionNo).toBe(2);
    expect(newPlan.reason).toBe("ER_APPROVED");
    expect(await eventLogged("#/domainEvents/BuildPlanUpdated")).toBe(true);
  });
});

describe("Lock Build Plan", () => {
  it("Given DS2 is frozen and engineering_release is APPROVED and a work_order is CREATED, When the planner locks the latest build_plan, Then build_plan.status becomes LOCKED and locked_at is set", async () => {
    const w = await givenUpTo("after_priority");
    const locked = await lockBuildPlan({ id: w.planId }, "Planner");
    expect(locked.status).toBe("LOCKED");
    expect(locked.lockedAt).toBeTruthy();
    const wo = await prisma.workOrder.findFirst({ where: { buildId: w.buildId } });
    expect(wo?.status).toBe("CREATED");
    expect(await eventLogged("#/domainEvents/BuildPlanLocked")).toBe(true);
  });

  it("rejects when DS2 is not frozen", async () => {
    // after_build_qty: BuildPlan exists (so we can target it), but BOM is still at DS1
    const w = await givenUpTo("after_build_qty");
    await expect(
      lockBuildPlan({ id: w.planId }, "Planner"),
    ).rejects.toThrow(/BOM not frozen at DS2/);
  });

  it("rejects when engineering release is not approved", async () => {
    const w = await givenUpTo("after_bom_ds2");
    await expect(
      lockBuildPlan({ id: w.planId }, "Planner"),
    ).rejects.toThrow(/engineering release not approved/);
  });
});
