import { prisma } from "../../db.js";
import { assertRole, type Role } from "../../auth.js";
import { emit } from "../../events/bus.js";
import { DomainError } from "../../errors.js";
import { requireString } from "../../util/invariants.js";

export interface BookProductionLineArgs {
  lineId: string;
  buildId: string;
  plannedStart: string;
  plannedEnd: string;
}

export async function bookProductionLine(args: BookProductionLineArgs, role: Role) {
  assertRole(role, "Production Planner");
  requireString("lineId", args.lineId);
  requireString("buildId", args.buildId);
  requireString("plannedStart", args.plannedStart);
  requireString("plannedEnd", args.plannedEnd);

  const line = await prisma.productionLine.findUnique({ where: { id: args.lineId } });
  if (!line) throw new DomainError(`production line ${args.lineId} does not exist`);

  const build = await prisma.build.findUnique({ where: { id: args.buildId } });
  if (!build) throw new DomainError(`build ${args.buildId} does not exist`);
  if (build.status !== "RELEASED") {
    throw new DomainError(`build ${build.id} is ${build.status}; only RELEASED builds can be booked on a line`);
  }
  if (args.plannedEnd <= args.plannedStart) {
    throw new DomainError("plannedEnd must be after plannedStart");
  }

  const booking = await prisma.lineBooking.create({
    data: {
      lineId: args.lineId,
      buildId: args.buildId,
      plannedStart: args.plannedStart,
      plannedEnd: args.plannedEnd,
      status: "BOOKED",
    },
  });

  await emit({
    ref: "#/domainEvents/ProductionLineBooked",
    aggregateId: booking.id,
    role,
    payload: { id: booking.id, lineId: args.lineId, buildId: args.buildId, plannedStart: args.plannedStart, plannedEnd: args.plannedEnd },
  });
  return booking;
}
