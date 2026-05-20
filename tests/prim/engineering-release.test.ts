import { describe, it, expect } from "vitest";
import { approveEngineeringRelease } from "../../src/prim/engineering-release/commands.js";
import { givenUpTo, eventLogged } from "../helpers/world.js";

describe("Approve Engineering Release", () => {
  it("Given DS2 is frozen, When the release authority approves the release, Then an engineering_release row with status APPROVED and approved_at is created", async () => {
    const w = await givenUpTo("after_bom_ds2");
    const er = await approveEngineeringRelease({ projectId: w.projectId }, "Configuration Manager");
    expect(er.status).toBe("APPROVED");
    expect(er.approvedAt).toBeTruthy();
    expect(await eventLogged("#/domainEvents/EngineeringReleaseApproved")).toBe(true);
  });

  it("rejects when DS2 not yet frozen", async () => {
    const w = await givenUpTo("after_bom_ds1");
    await expect(
      approveEngineeringRelease({ projectId: w.projectId }, "Configuration Manager"),
    ).rejects.toThrow(/DS2_PROD/);
  });
});
