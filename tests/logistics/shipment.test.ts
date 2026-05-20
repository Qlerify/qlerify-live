import { describe, it, expect } from "vitest";
import { prisma } from "../../src/db.js";
import {
  pickAndPackUnits, dispatchShipment, confirmShipmentDelivered,
} from "../../src/logistics/shipment/commands.js";
import { givenUpTo, eventLogged } from "../helpers/world.js";

describe("Pick And Pack Units", () => {
  it("Given the build is RTD, When the warehouse picks and packs, Then a shipment row with status READY is created with packed_at set and unit.status becomes PACKED", async () => {
    const w = await givenUpTo("after_rtd");
    const shipment = await pickAndPackUnits(
      { demandId: w.demandId, buildId: w.buildId, packedAt: "2026-04-26T09:00:00Z" },
      "Warehouse",
    );
    expect(shipment!.status).toBe("READY");
    expect(shipment!.packedAt).toBe("2026-04-26T09:00:00Z");
    expect(shipment!.units.every((u) => u.status === "PACKED")).toBe(true);
    expect(await eventLogged("#/domainEvents/UnitsPickedAndPacked")).toBe(true);
  });
});

describe("Dispatch Shipment", () => {
  it("Given the shipment is READY, When dispatched, Then shipment.status becomes IN_TRANSIT with shipped_at set, unit.status becomes SHIPPED, and build.status becomes SHIPPED", async () => {
    const w = await givenUpTo("after_packed");
    const ship = await dispatchShipment(
      { id: w.shipmentId!, shippedAt: "2026-04-26T15:00:00Z" },
      "Logistics",
    );
    expect(ship!.status).toBe("IN_TRANSIT");
    const units = await prisma.unit.findMany({ where: { shipmentId: w.shipmentId } });
    expect(units.every((u) => u.status === "SHIPPED")).toBe(true);
    const build = await prisma.build.findUnique({ where: { id: w.buildId } });
    expect(build?.status).toBe("SHIPPED");
    expect(await eventLogged("#/domainEvents/ShipmentDispatched")).toBe(true);
  });
});

describe("Confirm Shipment Delivered", () => {
  it("Given the shipment is IN_TRANSIT, When the customer receives it, Then shipment.status becomes DELIVERED with delivered_at set, unit.status becomes DELIVERED, and demand.status becomes DELIVERED", async () => {
    const w = await givenUpTo("after_dispatched");
    const ship = await confirmShipmentDelivered(
      { id: w.shipmentId!, deliveredAt: "2026-04-30T11:00:00Z" },
      "Customer",
    );
    expect(ship!.status).toBe("DELIVERED");
    expect(ship!.deliveredAt).toBe("2026-04-30T11:00:00Z");
    const units = await prisma.unit.findMany({ where: { shipmentId: w.shipmentId } });
    expect(units.every((u) => u.status === "DELIVERED")).toBe(true);
    const demand = await prisma.demand.findUnique({ where: { id: w.demandId } });
    expect(demand?.status).toBe("DELIVERED");
    expect(await eventLogged("#/domainEvents/UnitReceivedByCustomer")).toBe(true);
  });
});
