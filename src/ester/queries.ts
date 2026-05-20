import { prisma } from "../db.js";

export async function listOpenEngineeringChanges(projectId?: string) {
  return prisma.engineeringChange.findMany({
    where: { status: "OPEN", ...(projectId ? { projectId } : {}) },
    orderBy: { createdAt: "desc" },
  });
}

export async function listEngineeringChanges(projectId?: string) {
  return prisma.engineeringChange.findMany({
    where: projectId ? { projectId } : undefined,
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
  });
}
