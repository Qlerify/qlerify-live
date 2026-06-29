// Simulator stepping when two domain events share one command.
//
// Regression for the "stuck at step N" wedge: the generic simulator steps through
// EVENTS but fires them by COMMAND name. When two events bind the same command
// (the MDMarket model has two "Approval process completed" steps both on
// UpdateStatus, and two on UpdateMd), resolving the event by command name alone
// always picks the FIRST — so firing the second event re-emitted the first, its
// own ref was never recorded as fired, and the run re-added the first event on
// every "Step forward" instead of advancing. The fix threads the exact event ref
// the step intends to fire down to the base command. This proves a run with a
// shared command walks all the way to done, recording each event once.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { newId } from "../../src/platform/ids.js";
import { ensureOntologyResource } from "../../src/platform/ontology-store/ontology-store.js";
import { applyWorkflowModel } from "../../src/twin/apply.js";
import { genericNewInstance, genericStep, genericCurrentStep } from "../../src/twin/sim.js";
import { runWithTenant } from "../../src/platform/tenancy/context.js";
import type { TenantContext } from "../../src/platform/types.js";

const SFX = `ss${Date.now().toString(36)}`;
const caId = newId();
const orgId = newId();
const wsId = newId();
const projId = newId();
const aliceSub = `ss-alice-${SFX}`;
let aliceId: string;

// Demand walks Created → "Approval process completed" → "Approval process
// completed" again. The two approval steps are DISTINCT events that share the
// UpdateStatus command — exactly the shape that wedged the real workflow.
const MODEL = JSON.stringify({
  version: 1,
  boundedContext: "MarketDemand",
  roles: ["Manager"],
  domainEvents: {
    DemandCreated: {
      event: "Demand Created",
      role: "Manager",
      command: { $ref: "#/schemas/commands/CreateDemand" },
      aggregateRoot: { $ref: "#/schemas/entities/Demand" },
      acceptanceCriteria: ["Given a market, When raised, Then a DRAFT demand exists"],
    },
    ApprovalCompleted: {
      event: "Approval process completed",
      role: "Manager",
      follows: [{ $ref: "#/domainEvents/DemandCreated" }],
      command: { $ref: "#/schemas/commands/UpdateStatus" },
      aggregateRoot: { $ref: "#/schemas/entities/Demand" },
      acceptanceCriteria: ["Given a DRAFT demand, When approved, Then it is APPROVED"],
    },
    ApprovalCompleted2: {
      event: "Approval process completed",
      role: "Manager",
      follows: [{ $ref: "#/domainEvents/ApprovalCompleted" }],
      command: { $ref: "#/schemas/commands/UpdateStatus" },
      aggregateRoot: { $ref: "#/schemas/entities/Demand" },
      acceptanceCriteria: ["Given an APPROVED demand, When the second approval lands, Then it is RELEASED"],
    },
  },
  schemas: {
    entities: {
      Demand: {
        required: ["id", "status"],
        fields: [
          { name: "id", dataType: "string" },
          { name: "title", dataType: "string", exampleData: ["Market entry"] },
          { name: "status", dataType: "string", exampleData: ["DRAFT", "APPROVED", "RELEASED"] },
        ],
      },
    },
    commands: {
      CreateDemand: { required: [], fields: [{ name: "title" }] },
      UpdateStatus: { required: ["id"], fields: [{ name: "id" }, { name: "status" }] },
    },
  },
});

function projCtx(): TenantContext {
  return { organizationId: orgId, principal: { id: aliceId, type: "identity" }, identityId: aliceId, subject: aliceSub, workflowId: projId };
}

beforeAll(async () => {
  await prisma.platCustomerAccount.create({ data: { id: caId, name: `CA ${SFX}` } });
  await prisma.platOrganization.create({ data: { id: orgId, customerAccountId: caId, name: `Org ${SFX}`, slug: `org-${SFX}` } });
  const env = await prisma.platEnvironment.create({ data: { id: newId(), organizationId: orgId, name: "development", region: "local" } });
  await prisma.platWorkspace.create({ data: { id: wsId, organizationId: orgId, environmentId: env.id, name: "Default" } });
  aliceId = (await prisma.platIdentity.create({ data: { id: newId(), subject: aliceSub } })).id;
  await prisma.platOrgMembership.create({ data: { id: newId(), identityId: aliceId, organizationId: orgId } });
  await prisma.platWorkflow.create({ data: { id: projId, organizationId: orgId, workspaceId: wsId, name: "MarketDemand" } });
  await ensureOntologyResource({ organizationId: orgId, workflowId: projId, workspaceId: wsId, name: "workflow", ownerId: aliceId });
});

afterAll(async () => {
  await prisma.eventLog.deleteMany({ where: { organizationId: orgId } });
  await prisma.platOntologyBranch.deleteMany({ where: { organizationId: orgId } });
  await prisma.platOntologyVersion.deleteMany({ where: { organizationId: orgId } });
  await prisma.platOntology.deleteMany({ where: { organizationId: orgId } });
  await prisma.platResource.deleteMany({ where: { organizationId: orgId } });
  await prisma.platWorkflow.deleteMany({ where: { organizationId: orgId } });
  await prisma.platWorkspace.deleteMany({ where: { organizationId: orgId } });
  await prisma.platEnvironment.deleteMany({ where: { organizationId: orgId } });
  await prisma.platOrgMembership.deleteMany({ where: { organizationId: orgId } });
  await prisma.platIdentity.deleteMany({ where: { id: aliceId } });
  await prisma.platOrganization.deleteMany({ where: { id: orgId } });
  await prisma.platCustomerAccount.deleteMany({ where: { id: caId } });
});

describe("genericStep — two events sharing one command", () => {
  it("advances through both, recording each event once instead of re-firing the first", async () => {
    await runWithTenant(projCtx(), async () => {
      await applyWorkflowModel(MODEL, null, { source: "set" });

      // Create the run, then step until done (guarded against the very wedge this
      // test exists for, so a regression fails fast instead of looping 50×).
      const { id } = await genericNewInstance();
      const captions: string[] = [];
      for (let guard = 0; guard < 10; guard++) {
        const step = await genericStep(id);
        captions.push(step.caption);
        if (step.done) break;
      }

      // The run reached the end: the current step is at/after total.
      const cur = await genericCurrentStep(id);
      expect(cur.index).toBe(cur.total);

      // Each distinct event was recorded exactly once — the second UpdateStatus
      // event did NOT re-emit the first (which is what wedged the real run).
      const rows = await prisma.eventLog.findMany({
        where: { caseId: id, organizationId: orgId },
        select: { eventRef: true },
      });
      const counts = new Map<string, number>();
      for (const r of rows) counts.set(r.eventRef, (counts.get(r.eventRef) ?? 0) + 1);

      expect(counts.get("#/domainEvents/DemandCreated")).toBe(1);
      expect(counts.get("#/domainEvents/ApprovalCompleted")).toBe(1);
      expect(counts.get("#/domainEvents/ApprovalCompleted2")).toBe(1);
    });
  });
});
