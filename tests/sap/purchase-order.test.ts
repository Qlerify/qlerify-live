import { describe, it, expect } from "vitest";
import { prisma } from "../../src/db.js";
import {
  orderMaterial, confirmOrderWithETA, changeMaterialETA, receiveMaterial,
} from "../../src/sap/purchase-order/commands.js";
import { givenUpTo, eventLogged } from "../helpers/world.js";

describe("Order Material", () => {
  it("Given a purchase order is in DRAFT, When the buyer orders the material, Then the purchase order status becomes ORDERED and requested_date is set", async () => {
    const w = await givenUpTo("after_material_demand");
    const po = await orderMaterial({ id: w.poIds[0]!, requestedDate: "2026-04-10" }, "Buyer");
    expect(po.status).toBe("ORDERED");
    expect(po.requestedDate).toBe("2026-04-10");
    expect(await eventLogged("#/domainEvents/MaterialOrdered")).toBe(true);
  });
});

describe("Confirm Order With ETA", () => {
  it("Given a purchase order is ORDERED, When the supplier confirms, Then the purchase order status becomes CONFIRMED and confirmed_eta is set", async () => {
    const w = await givenUpTo("after_material_ordered");
    const po = await confirmOrderWithETA(
      { id: w.poIds[0]!, confirmedEta: "2026-04-12" },
      "Supplier",
    );
    expect(po.status).toBe("CONFIRMED");
    expect(po.confirmedEta).toBe("2026-04-12");
    expect(await eventLogged("#/domainEvents/SupplierConfirmedOrderWithETA")).toBe(true);
  });
});

describe("Change Material ETA", () => {
  it("Given a purchase order is CONFIRMED, When the supplier updates the ETA, Then confirmed_eta is changed to a later date", async () => {
    const w = await givenUpTo("after_supplier_confirmed");
    const po = await changeMaterialETA(
      { id: w.poIds[0]!, confirmedEta: "2026-04-25" },
      "Supplier",
    );
    expect(po.confirmedEta).toBe("2026-04-25");
    expect(await eventLogged("#/domainEvents/MaterialETAChanged")).toBe(true);
  });

  it("rejects an earlier ETA", async () => {
    const w = await givenUpTo("after_supplier_confirmed");
    await expect(
      changeMaterialETA({ id: w.poIds[0]!, confirmedEta: "2026-04-01" }, "Supplier"),
    ).rejects.toThrow(/later than the previous/);
  });
});

describe("Receive Material", () => {
  it("Given a PO is CONFIRMED and the ETA has been reached, When goods are received, Then purchase_order.status becomes RECEIVED, actual_receipt_date is set, and build_demand.qty_available is updated", async () => {
    const w = await givenUpTo("after_line_booked");
    const po = await receiveMaterial(
      { id: w.poIds[0]!, actualReceiptDate: "2026-04-12" },
      "Goods Receiving",
    );
    expect(po!.status).toBe("RECEIVED");
    const bd = await prisma.buildDemand.findFirst({
      where: { buildId: w.buildId, partNumber: po!.partNumber },
    });
    expect(bd!.qtyAvailable).toBeGreaterThan(0);
    expect(await eventLogged("#/domainEvents/MaterialReceivedAtSite")).toBe(true);
  });
});
