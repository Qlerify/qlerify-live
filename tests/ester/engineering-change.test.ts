import { describe, it, expect } from "vitest";
import {
  raiseEngineeringChange, approveEngineeringChange,
} from "../../src/ester/engineering-change/commands.js";
import { givenUpTo, eventLogged } from "../helpers/world.js";

describe("Raise Engineering Change", () => {
  it("Given a BOM is frozen at DS1, When a designer raises an engineering change, Then an engineering_change row is created with status OPEN", async () => {
    const w = await givenUpTo("after_bom_ds1");
    const ec = await raiseEngineeringChange(
      {
        projectId: w.projectId,
        bomItemId: w.bomItemIds[0]!,
        description: "Swap supplier",
      },
      "Designer",
    );
    expect(ec.status).toBe("OPEN");
    expect(ec.description).toBe("Swap supplier");
    expect(await eventLogged("#/domainEvents/EngineeringChangeRaised")).toBe(true);
  });

  it("rejects when BOM is still in DRAFT", async () => {
    const w = await givenUpTo("after_bom_defined");
    await expect(
      raiseEngineeringChange(
        { projectId: w.projectId, bomItemId: w.bomItemIds[0]!, description: "Too early" },
        "Designer",
      ),
    ).rejects.toThrow(/DS1/);
  });
});

describe("Approve Engineering Change", () => {
  it("Given an engineering change is OPEN, When the CM approves it, Then the status becomes APPROVED and the affected bom_item is updated", async () => {
    const w = await givenUpTo("after_ec_raised");
    const updated = await approveEngineeringChange({ id: w.ecId! }, "Configuration Manager");
    expect(updated.status).toBe("APPROVED");
    expect(updated.approvedAt).toBeTruthy();
    expect(await eventLogged("#/domainEvents/EngineeringChangeApproved")).toBe(true);
  });
});
