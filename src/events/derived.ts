// Derived events — fired automatically by subscriptions on upstream events.
// Events 10 (Material Shortage Identified) and 21 (Material Kit Completed)
// are the two "the simulator joins data the planner used to learn by email"
// moments from the spec §4.

import { prisma } from "../db.js";
import { subscribe } from "./bus.js";
import { flagMaterialShortage, completeMaterialKit } from "../helix/build/commands.js";

let wired = false;

export function wireDerivedEvents() {
  if (wired) return;
  wired = true;

  // After a Material ETA Changed event, recompute material risk per build.
  subscribe("#/domainEvents/MaterialETAChanged", async (ev) => {
    const poId = String(ev.payload["id"] ?? "");
    if (!poId) return;
    const po = await prisma.purchaseOrder.findUnique({ where: { id: poId } });
    if (!po || !po.confirmedEta) return;
    const project = await prisma.project.findUnique({ where: { id: po.projectId } });
    if (!project) return;
    const plans = await prisma.buildPlan.findMany({ where: { demandId: project.demandId } });
    const builds = await prisma.build.findMany({ where: { buildPlanId: { in: plans.map((p) => p.id) } } });
    for (const b of builds) {
      const hasDemandForPart = await prisma.buildDemand.findFirst({
        where: { buildId: b.id, partNumber: po.partNumber },
      });
      if (hasDemandForPart && po.confirmedEta > b.plannedStart && b.materialStatus !== "AT_RISK") {
        try {
          await flagMaterialShortage({ id: b.id }, "Automation");
        } catch (err) {
          // Soft failure — derived events shouldn't take down the originator.
          console.error("[derived] flagMaterialShortage failed", err);
        }
      }
    }
  });

  // After Material Received At Site, recompute kit readiness.
  subscribe("#/domainEvents/MaterialReceivedAtSite", async (ev) => {
    const poId = String(ev.payload["id"] ?? "");
    if (!poId) return;
    const po = await prisma.purchaseOrder.findUnique({ where: { id: poId } });
    if (!po) return;
    const project = await prisma.project.findUnique({ where: { id: po.projectId } });
    if (!project) return;
    const plans = await prisma.buildPlan.findMany({ where: { demandId: project.demandId } });
    const builds = await prisma.build.findMany({
      where: { buildPlanId: { in: plans.map((p) => p.id) } },
      include: { buildDemand: true },
    });
    for (const b of builds) {
      if (b.buildDemand.length === 0) continue;
      if (b.materialStatus === "KIT_READY") continue;
      const allSatisfied = b.buildDemand.every((d) => d.qtyAvailable >= d.qtyRequired);
      if (allSatisfied) {
        try {
          await completeMaterialKit({ id: b.id }, "Automation");
        } catch (err) {
          console.error("[derived] completeMaterialKit failed", err);
        }
      }
    }
  });
}
