import { describe, it, expect } from "vitest";
import { createDemand } from "../../src/helix/demand/commands.js";
import { prisma } from "../../src/db.js";
import { givenUpTo, eventLogged } from "../helpers/world.js";

describe("Create Demand", () => {
  it("Given a customer hardware need exists, When the product manager submits a new demand, Then a demand row is created with status NEW", async () => {
    await givenUpTo("init");

    const result = await createDemand(
      { customerId: "cust-99", productName: "Radio Unit Y", qty: 7, requestedWeek: "2026-W30" },
      "Product Manager",
    );

    expect(result.status).toBe("NEW");
    expect(result.customerId).toBe("cust-99");
    expect(result.productName).toBe("Radio Unit Y");
    expect(result.qty).toBe(7);
    expect(result.requestedWeek).toBe("2026-W30");
    expect(await eventLogged("#/domainEvents/HardwareDemandCreated")).toBe(true);
  });

  it("rejects non-PM roles", async () => {
    await givenUpTo("init");
    await expect(
      createDemand(
        { customerId: "cust-99", productName: "X", qty: 1, requestedWeek: "W1" },
        "Designer",
      ),
    ).rejects.toThrow(/role "Designer" not permitted/);
  });

  it("rejects qty <= 0", async () => {
    await givenUpTo("init");
    await expect(
      createDemand(
        { customerId: "cust-99", productName: "X", qty: 0, requestedWeek: "W1" },
        "Product Manager",
      ),
    ).rejects.toThrow(/qty/);
  });
});
