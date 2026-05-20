import { prisma } from "../../db.js";
import { assertRole, type Role } from "../../auth.js";
import { emit } from "../../events/bus.js";
import { DomainError } from "../../errors.js";
import { requireString } from "../../util/invariants.js";

async function loadBuildInProgress(buildId: string) {
  const build = await prisma.build.findUnique({ where: { id: buildId } });
  if (!build) throw new DomainError(`build ${buildId} does not exist`);
  if (build.status !== "IN_PROGRESS") {
    throw new DomainError(`build ${build.id} is ${build.status}; tests require IN_PROGRESS`);
  }
  return build;
}

export async function recordBoardTestPass(
  args: { buildId: string; unitSerial: string; executedAt: string },
  role: Role,
) {
  assertRole(role, "Test Engineer");
  requireString("buildId", args.buildId);
  requireString("unitSerial", args.unitSerial);
  requireString("executedAt", args.executedAt);
  await loadBuildInProgress(args.buildId);

  const tr = await prisma.testResult.create({
    data: {
      buildId: args.buildId,
      unitSerial: args.unitSerial,
      testType: "BOARD",
      result: "PASS",
      executedAt: args.executedAt,
    },
  });
  await emit({
    ref: "#/domainEvents/BoardTestPassed",
    aggregateId: tr.id,
    role,
    payload: { id: tr.id, buildId: args.buildId, unitSerial: args.unitSerial, executedAt: args.executedAt },
  });
  return tr;
}

export async function recordFAIPass(
  args: { buildId: string; unitSerial: string; executedAt: string },
  role: Role,
) {
  assertRole(role, "Quality Engineer");
  requireString("buildId", args.buildId);
  requireString("unitSerial", args.unitSerial);
  requireString("executedAt", args.executedAt);
  await loadBuildInProgress(args.buildId);

  const boardPass = await prisma.testResult.findFirst({
    where: { buildId: args.buildId, testType: "BOARD", result: "PASS" },
  });
  if (!boardPass) throw new DomainError("board test must pass before FAI");

  const tr = await prisma.testResult.create({
    data: {
      buildId: args.buildId,
      unitSerial: args.unitSerial,
      testType: "FAI",
      result: "PASS",
      executedAt: args.executedAt,
    },
  });
  await emit({
    ref: "#/domainEvents/FirstArticleInspectionPassed",
    aggregateId: tr.id,
    role,
    payload: { id: tr.id, buildId: args.buildId, unitSerial: args.unitSerial, executedAt: args.executedAt },
  });
  return tr;
}
