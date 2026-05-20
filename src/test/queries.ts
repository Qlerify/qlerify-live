import { prisma } from "../db.js";

export async function listTestResults(buildId?: string) {
  return prisma.testResult.findMany({
    where: buildId ? { buildId } : undefined,
    orderBy: { executedAt: "desc" },
  });
}
