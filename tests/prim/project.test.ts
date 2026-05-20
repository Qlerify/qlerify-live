import { describe, it, expect } from "vitest";
import { prisma } from "../../src/db.js";
import {
  createProject, defineBOM, freezeBOMAtDS1, freezeBOMAtDS2,
} from "../../src/prim/project/commands.js";
import { givenUpTo, eventLogged } from "../helpers/world.js";

describe("Create Project", () => {
  it("Given a demand exists, When the product manager creates a project, Then a project linked to the demand is created", async () => {
    const w = await givenUpTo("after_demand");
    const project = await createProject(
      { demandId: w.demandId, productName: "Radio Unit X" },
      "Product Manager",
    );
    expect(project.demandId).toBe(w.demandId);
    expect(project.productName).toBe("Radio Unit X");
    expect(await eventLogged("#/domainEvents/ProjectCreated")).toBe(true);
  });
});

describe("Define BOM", () => {
  it("Given a project exists, When the designer defines the BOM, Then bom_item rows are inserted with design_state DRAFT", async () => {
    const w = await givenUpTo("after_project");
    const out = await defineBOM(
      {
        id: w.projectId,
        bomItems: [
          { partNumber: "PN-4711", qtyPerUnit: 1 },
          { partNumber: "PN-4712", qtyPerUnit: 3 },
        ],
      },
      "Designer",
    );
    expect(out!.bomItems.length).toBe(2);
    expect(out!.bomItems.every((b) => b.designState === "DRAFT")).toBe(true);
    expect(await eventLogged("#/domainEvents/BOMDefined")).toBe(true);
  });
});

describe("Freeze BOM At DS1", () => {
  it("Given a project has at least one bom_item, When the CM freezes the BOM at DS1, Then all bom_items design_state becomes DS1 and frozen_at is set", async () => {
    const w = await givenUpTo("after_bom_defined");
    const out = await freezeBOMAtDS1({ id: w.projectId }, "Configuration Manager");
    expect(out!.bomItems.every((b) => b.designState === "DS1")).toBe(true);
    expect(out!.bomItems.every((b) => !!b.frozenAt)).toBe(true);
    expect(await eventLogged("#/domainEvents/BOMFrozenAtDS1")).toBe(true);
  });
});

describe("Freeze BOM At DS2", () => {
  it("Given all open engineering changes are resolved, When the CM freezes the BOM at DS2, Then all bom_items design_state becomes DS2_PROD", async () => {
    const w = await givenUpTo("after_ec_approved");
    const out = await freezeBOMAtDS2({ id: w.projectId }, "Configuration Manager");
    expect(out!.bomItems.every((b) => b.designState === "DS2_PROD")).toBe(true);
    expect(await eventLogged("#/domainEvents/BOMFrozenAtDS2")).toBe(true);
  });

  it("rejects when an EC is still OPEN", async () => {
    const w = await givenUpTo("after_ec_raised");
    await expect(
      freezeBOMAtDS2({ id: w.projectId }, "Configuration Manager"),
    ).rejects.toThrow(/OPEN/);
  });
});
