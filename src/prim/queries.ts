import { prisma } from "../db.js";

export async function getProject(projectId: string) {
  return prisma.project.findUnique({ where: { id: projectId } });
}

export async function getProjectWithBOM(projectId: string) {
  return prisma.project.findUnique({
    where: { id: projectId },
    include: { bomItems: { orderBy: { partNumber: "asc" } } },
  });
}

export async function getProjectStatus(projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { bomItems: true },
  });
  if (!project) return null;
  const bomDesignState = project.bomItems.length === 0
    ? "NO_BOM"
    : project.bomItems.some((i) => i.designState === "DRAFT")
      ? "DRAFT"
      : project.bomItems.every((i) => i.designState === "DS2_PROD")
        ? "DS2_PROD"
        : "DS1";
  const openEngineeringChanges = await prisma.engineeringChange.count({
    where: { projectId, status: "OPEN" },
  });
  return { ...project, bomDesignState, openEngineeringChanges };
}

export async function getBOMItem(bomItemId: string) {
  return prisma.bomItem.findUnique({ where: { id: bomItemId } });
}
