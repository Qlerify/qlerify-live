import { prisma } from "../../db.js";
import { assertRole, type Role } from "../../auth.js";
import { emit } from "../../events/bus.js";
import { newId } from "../../util/ids.js";
import { requireString, requirePositiveInt } from "../../util/invariants.js";

export interface CreateDemandArgs {
  customerId: string;
  productName: string;
  qty: number;
  requestedWeek: string;
}

export async function createDemand(args: CreateDemandArgs, role: Role) {
  assertRole(role, "Product Manager");
  requireString("customerId", args.customerId);
  requireString("productName", args.productName);
  requirePositiveInt("qty", args.qty);
  requireString("requestedWeek", args.requestedWeek);

  const id = newId("dmd");
  const demand = await prisma.demand.create({
    data: {
      id,
      customerId: args.customerId,
      productName: args.productName,
      qty: args.qty,
      requestedWeek: args.requestedWeek,
      status: "NEW",
    },
  });

  await emit({
    ref: "#/domainEvents/HardwareDemandCreated",
    aggregateId: demand.id,
    role,
    payload: { ...args, id: demand.id, status: demand.status },
  });

  return demand;
}
