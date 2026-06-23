// Empty-org fail-closed behavior. After an org's LAST workflow is deleted the org
// survives with zero workflows. The control plane keeps working (whoami / create
// workflow), but the workflow-scoped DATA plane must fail CLOSED — a workflow-less
// non-system org can NEVER fall open into the system demo's gen_ tables or
// EventLog. This replaces the old org-id "phantom workflow" sentinel.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import * as store from "../../src/twin/projection-store.js";
import { newId, SYSTEM_WORKFLOW_ID } from "../../src/platform/ids.js";
import { deleteWorkflow } from "../../src/platform/provisioning/index.js";
import { ensureOntologyResource, createVersion } from "../../src/platform/ontology-store/ontology-store.js";
import { resolveTenantContext } from "../../src/platform/authn/index.js";
import { runWithTenant, currentWorkflowId, isSystemWorkflow } from "../../src/platform/tenancy/context.js";
import { eventLogOrgWhere } from "../../src/platform/tenancy/event-scope.js";
import { NoActiveWorkflowError } from "../../src/errors.js";
import type { TenantContext } from "../../src/platform/types.js";

const SFX = `eo${Date.now().toString(36)}`;
const caId = newId();
const orgId = newId();
const wsId = newId();
const projId = newId();
const sub = `eo-${SFX}`;
let identityId: string;

const emptyCtx = (): TenantContext => ({ organizationId: orgId, principal: { id: identityId, type: "identity" }, identityId, subject: sub });

beforeAll(async () => {
  await prisma.platCustomerAccount.create({ data: { id: caId, name: `CA ${SFX}` } });
  await prisma.platOrganization.create({ data: { id: orgId, customerAccountId: caId, name: `Org ${SFX}`, slug: `org-${SFX}` } });
  const env = await prisma.platEnvironment.create({ data: { id: newId(), organizationId: orgId, name: "development", region: "local" } });
  await prisma.platWorkspace.create({ data: { id: wsId, organizationId: orgId, environmentId: env.id, name: "Default" } });
  identityId = (await prisma.platIdentity.create({ data: { id: newId(), subject: sub } })).id;
  await prisma.platOrgMembership.create({ data: { id: newId(), identityId, organizationId: orgId } });

  // One workflow, then delete it → the org is now empty.
  await prisma.platWorkflow.create({ data: { id: projId, organizationId: orgId, workspaceId: wsId, name: "Default" } });
  const { ontologyId } = await ensureOntologyResource({ organizationId: orgId, workflowId: projId, workspaceId: wsId, name: "workflow", ownerId: identityId });
  await createVersion(orgId, ontologyId, JSON.stringify({ boundedContext: "X", domainEvents: {}, roles: [] }), null, { source: "initial" });
  await deleteWorkflow(orgId, projId, identityId);
});

afterAll(async () => {
  await prisma.platAuditEvent.deleteMany({ where: { organizationId: orgId } });
  await prisma.platOrgMembership.deleteMany({ where: { organizationId: orgId } });
  await prisma.platIdentity.deleteMany({ where: { id: identityId } });
  await prisma.platWorkspace.deleteMany({ where: { organizationId: orgId } });
  await prisma.platEnvironment.deleteMany({ where: { organizationId: orgId } });
  await prisma.platOrganization.deleteMany({ where: { id: orgId } });
  await prisma.platCustomerAccount.deleteMany({ where: { id: caId } });
});

describe("empty org (last workflow deleted) fails closed", () => {
  it("the org still has zero workflows (it survived the delete)", async () => {
    expect(await prisma.platWorkflow.count({ where: { organizationId: orgId } })).toBe(0);
    expect(await prisma.platOrganization.count({ where: { id: orgId } })).toBe(1);
  });

  it("resolves to NO active workflow — not the org-id sentinel, not the system workflow", async () => {
    const ctx = await resolveTenantContext({ authorization: `Bearer ${sub}` });
    expect(ctx.organizationId).toBe(orgId);
    expect(ctx.workflowId).toBeUndefined();
  });

  it("currentWorkflowId() throws and isSystemWorkflow() is false for the empty org", () => {
    runWithTenant(emptyCtx(), () => {
      expect(() => currentWorkflowId()).toThrow(NoActiveWorkflowError);
      expect(isSystemWorkflow()).toBe(false); // crucially NOT mistaken for the demo
    });
  });

  it("the data plane fails closed — no read of the demo's tables or EventLog", async () => {
    await runWithTenant(emptyCtx(), async () => {
      // Scoping the EventLog computes the workflow id first → throws before querying.
      expect(() => eventLogOrgWhere()).toThrow(NoActiveWorkflowError);
      // gen_ store access likewise refuses (would otherwise hit demo gen_ tables).
      await expect(store.findMany("AnyEntity")).rejects.toThrow(NoActiveWorkflowError);
    });
  });

  it("non-request contexts and the system org still resolve to the system workflow", () => {
    // No store at all (boot / fs.watch / sim / tests) → system tenant, unchanged.
    expect(currentWorkflowId()).toBe(SYSTEM_WORKFLOW_ID);
    expect(isSystemWorkflow()).toBe(true);
  });
});
