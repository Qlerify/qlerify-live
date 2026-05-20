import { prisma } from "../../db.js";
import { assertRole, type Role } from "../../auth.js";
import { emit } from "../../events/bus.js";
import { DomainError, NotFoundError } from "../../errors.js";
import { requireString } from "../../util/invariants.js";

export interface PickAndPackUnitsArgs {
  demandId: string;
  buildId: string;
  packedAt: string;
  units?: Array<{ id: string; status?: string }>;
}

export async function pickAndPackUnits(args: PickAndPackUnitsArgs, role: Role) {
  assertRole(role, "Warehouse");
  requireString("demandId", args.demandId);
  requireString("buildId", args.buildId);
  requireString("packedAt", args.packedAt);

  const build = await prisma.build.findUnique({ where: { id: args.buildId } });
  if (!build) throw new DomainError(`build ${args.buildId} does not exist`);
  if (build.status !== "RTD") {
    throw new DomainError(`build ${build.id} is ${build.status}; only RTD builds can be packed`);
  }

  // Default: pack all units of this build that aren't already shipped
  const targetIds = args.units?.map((u) => u.id) ?? (
    await prisma.unit.findMany({ where: { buildId: build.id, status: "BUILT" }, select: { id: true } })
  ).map((u) => u.id);
  if (targetIds.length === 0) throw new DomainError("no units available to pack");

  const shipment = await prisma.$transaction(async (tx) => {
    const ship = await tx.shipment.create({
      data: { demandId: args.demandId, packedAt: args.packedAt, status: "READY" },
    });
    await tx.unit.updateMany({
      where: { id: { in: targetIds }, buildId: build.id },
      data: { status: "PACKED", shipmentId: ship.id },
    });
    return ship;
  });

  await emit({
    ref: "#/domainEvents/UnitsPickedAndPacked",
    aggregateId: shipment.id,
    role,
    payload: { id: shipment.id, demandId: args.demandId, buildId: args.buildId, packedAt: args.packedAt, unitCount: targetIds.length },
  });
  return prisma.shipment.findUnique({ where: { id: shipment.id }, include: { units: true } });
}

export async function dispatchShipment(args: { id: string; shippedAt: string }, role: Role) {
  assertRole(role, "Logistics");
  requireString("id", args.id);
  requireString("shippedAt", args.shippedAt);
  const shipment = await prisma.shipment.findUnique({ where: { id: args.id }, include: { units: true } });
  if (!shipment) throw new NotFoundError(`shipment ${args.id} not found`);
  if (shipment.status !== "READY") {
    throw new DomainError(`shipment ${shipment.id} is ${shipment.status}; only READY shipments can be dispatched`);
  }

  await prisma.$transaction(async (tx) => {
    await tx.shipment.update({
      where: { id: shipment.id, version: shipment.version },
      data: { status: "IN_TRANSIT", shippedAt: args.shippedAt, version: { increment: 1 } },
    });
    await tx.unit.updateMany({
      where: { shipmentId: shipment.id },
      data: { status: "SHIPPED" },
    });
    const builds = new Set(shipment.units.map((u) => u.buildId));
    for (const bid of builds) {
      await tx.build.update({ where: { id: bid }, data: { status: "SHIPPED", version: { increment: 1 } } });
    }
  });

  await emit({
    ref: "#/domainEvents/ShipmentDispatched",
    aggregateId: shipment.id,
    role,
    payload: { id: shipment.id, shippedAt: args.shippedAt, unitCount: shipment.units.length },
  });
  return prisma.shipment.findUnique({ where: { id: shipment.id } });
}

export async function confirmShipmentDelivered(args: { id: string; deliveredAt: string }, role: Role) {
  assertRole(role, "Customer");
  requireString("id", args.id);
  requireString("deliveredAt", args.deliveredAt);
  const shipment = await prisma.shipment.findUnique({ where: { id: args.id }, include: { units: true } });
  if (!shipment) throw new NotFoundError(`shipment ${args.id} not found`);
  if (shipment.status !== "IN_TRANSIT") {
    throw new DomainError(`shipment ${shipment.id} is ${shipment.status}; only IN_TRANSIT shipments can be delivered`);
  }

  await prisma.$transaction(async (tx) => {
    await tx.shipment.update({
      where: { id: shipment.id, version: shipment.version },
      data: { status: "DELIVERED", deliveredAt: args.deliveredAt, version: { increment: 1 } },
    });
    await tx.unit.updateMany({
      where: { shipmentId: shipment.id },
      data: { status: "DELIVERED" },
    });
    await tx.demand.update({
      where: { id: shipment.demandId },
      data: { status: "DELIVERED", version: { increment: 1 } },
    });
  });

  await emit({
    ref: "#/domainEvents/UnitReceivedByCustomer",
    aggregateId: shipment.id,
    role,
    payload: { id: shipment.id, deliveredAt: args.deliveredAt, demandId: shipment.demandId },
  });
  return prisma.shipment.findUnique({ where: { id: shipment.id } });
}
