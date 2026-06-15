import { describe, it, expect } from "vitest";
import { createDemand } from "../../src/helix/demand/commands.js";
import { prisma } from "../../src/db.js";
import { givenUpTo } from "../helpers/world.js";
import {
  provenanceFor,
  setAdapterMode,
  provenanceMeta,
  invalidateModesCache,
} from "../../src/twin/provenance.js";

const DEMAND_REF = "#/domainEvents/HardwareDemandCreated";
function latest(ref: string) {
  return prisma.eventLog.findFirst({ where: { eventRef: ref }, orderBy: { occurredAt: "desc" } });
}

describe("provenance substrate (Part 2.1)", () => {
  it("defaults an unclaimed bounded context to simulated", async () => {
    invalidateModesCache();
    expect(await provenanceFor("NoSuchBoundedContext")).toBe("simulated");
  });

  it("setAdapterMode flips a bounded context's mode (persisted + cached)", async () => {
    await setAdapterMode("AdapterTestBC", "recorded", "adp-1");
    expect(await provenanceFor("AdapterTestBC")).toBe("recorded");
  });

  it("provenanceMeta rolls up steps by each step's bounded-context mode", async () => {
    await setAdapterMode("BC_LIVE", "live");
    const meta = await provenanceMeta(
      ["BC_LIVE", "BC_SIM"],
      [{ boundedContext: "BC_LIVE" }, { boundedContext: "BC_LIVE" }, { boundedContext: "BC_SIM" }],
      { BC_LIVE: 2, BC_SIM: 0 },
    );
    expect(meta.steps).toEqual({ total: 3, simulated: 1, recorded: 0, live: 2, real: 2 });
    expect(meta.byContext.BC_LIVE).toMatchObject({ mode: "live", eventCount: 2 });
    expect(meta.byContext.BC_SIM.mode).toBe("simulated");
  });

  it("stamps emitted events with the bounded context's mode — default simulated", async () => {
    await givenUpTo("init");
    await setAdapterMode("Helix", "simulated"); // explicit so order can't taint it
    await createDemand(
      { customerId: "c1", productName: "Radio", qty: 1, requestedWeek: "2026-W30" },
      "Product Manager",
    );
    expect((await latest(DEMAND_REF))?.provenance).toBe("simulated");
  });

  it("emitted events follow a live bounded-context mode, then revert", async () => {
    await givenUpTo("init");
    await setAdapterMode("Helix", "live", "sap-po");
    await createDemand(
      { customerId: "c2", productName: "Radio", qty: 1, requestedWeek: "2026-W30" },
      "Product Manager",
    );
    expect((await latest(DEMAND_REF))?.provenance).toBe("live");
    // Leave Helix back at the demo default so no other suite inherits 'live'.
    await setAdapterMode("Helix", "simulated");
  });
});
