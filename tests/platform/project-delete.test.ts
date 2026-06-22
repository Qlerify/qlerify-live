// Project deletion cascade (the destructive lifecycle: "when a project is
// deleted, all its tables + entities + data are dropped"). Model-INDEPENDENT —
// builds its own org / project / ontology / data fixtures.
//
// Proves:
//   - the project's control-plane metadata is gone (project, ontology, versions,
//     branches, resource, resource markings, project-scoped role assignments)
//   - the project's data plane is gone (its gen__p<project>_ tables + EventLog)
//   - a SIBLING project in the same org is left completely untouched
//   - the system default project is protected (deletion refused)
//   - the destructive act is written to the audit chain

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import * as store from "../../src/twin/projection-store.js";
import type { EntitySchema } from "../../src/ontology/model.js";
import { newId, SYSTEM_ORG_ID, SYSTEM_PROJECT_ID } from "../../src/platform/ids.js";
import { assignRole, deleteProject } from "../../src/platform/provisioning/index.js";
import { ensureOntologyResource, createVersion } from "../../src/platform/ontology-store/ontology-store.js";
import { runWithTenant } from "../../src/platform/tenancy/context.js";
import type { TenantContext } from "../../src/platform/types.js";

const SFX = `pd${Date.now().toString(36)}`;
const caId = newId();
const orgId = newId();
const wsId = newId();
const projId = newId(); // the project under test (deleted)
const siblingId = newId(); // a second project that must survive
const aliceSub = `pd-alice-${SFX}`;
let aliceId: string;

const entity: EntitySchema = { name: `GenP${SFX}`, required: [], fields: [{ name: "id" }, { name: "label" }] };

function projCtx(projectId: string): TenantContext {
  return { organizationId: orgId, principal: { id: aliceId, type: "identity" }, identityId: aliceId, subject: aliceSub, projectId };
}

async function seedProject(projectId: string, name: string) {
  await prisma.platProject.create({ data: { id: projectId, organizationId: orgId, workspaceId: wsId, name } });
  const { ontologyId } = await ensureOntologyResource({ organizationId: orgId, projectId, workspaceId: wsId, name: "workflow", ownerId: aliceId });
  await createVersion(orgId, ontologyId, JSON.stringify({ boundedContext: "X", domainEvents: {}, roles: [] }), null, { source: "initial" });
  // A gen__p<project>_ table with one row, created in THIS project's scope.
  await runWithTenant(projCtx(projectId), async () => {
    await store.ensureTable(entity);
    await store.insert(entity.name, { id: newId(), label: `row-for-${name}` });
  });
  // An EventLog run-history row scoped to this project.
  await prisma.eventLog.create({
    data: { id: newId(), eventName: "X", eventRef: "#/x", boundedContext: "X", aggregateRoot: "X", aggregateId: newId(), role: "r", payload: "{}", organizationId: orgId, projectId },
  });
  return { ontologyId };
}

let underTest: { ontologyId: string };
let sibling: { ontologyId: string };

beforeAll(async () => {
  await prisma.platCustomerAccount.create({ data: { id: caId, name: `CA ${SFX}` } });
  await prisma.platOrganization.create({ data: { id: orgId, customerAccountId: caId, name: `Org ${SFX}`, slug: `org-${SFX}` } });
  const env = await prisma.platEnvironment.create({ data: { id: newId(), organizationId: orgId, name: "development", region: "local" } });
  await prisma.platWorkspace.create({ data: { id: wsId, organizationId: orgId, environmentId: env.id, name: "Default" } });
  aliceId = (await prisma.platIdentity.create({ data: { id: newId(), subject: aliceSub } })).id;
  await prisma.platOrgMembership.create({ data: { id: newId(), identityId: aliceId, organizationId: orgId } });

  underTest = await seedProject(projId, "Doomed");
  sibling = await seedProject(siblingId, "Survivor");

  // A project-scoped role grant on the doomed project (must be cascaded away).
  await assignRole({ organizationId: orgId, principalId: aliceId, principalType: "identity", roleKey: "editor", scopeType: "project", scopeId: projId });
  // A marking on the doomed project's ontology resource (must be cascaded away).
  const res = await prisma.platOntology.findFirst({ where: { id: underTest.ontologyId }, select: { resourceId: true } });
  const markingId = newId();
  await prisma.platMarking.create({ data: { id: markingId, organizationId: orgId, name: `M-${SFX}` } });
  await prisma.platResourceMarking.create({ data: { id: newId(), organizationId: orgId, resourceId: res!.resourceId, markingId, source: "direct" } });
});

afterAll(async () => {
  // Best-effort teardown (the doomed project is already gone if the test passed).
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "gen__p${projId.replace(/-/g, "")}_${entity.name}"`).catch(() => {});
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "gen__p${siblingId.replace(/-/g, "")}_${entity.name}"`).catch(() => {});
  await prisma.eventLog.deleteMany({ where: { organizationId: orgId } });
  await prisma.platRoleAssignment.deleteMany({ where: { organizationId: orgId } });
  await prisma.platResourceMarking.deleteMany({ where: { organizationId: orgId } });
  await prisma.platMarking.deleteMany({ where: { organizationId: orgId } });
  await prisma.platAuditEvent.deleteMany({ where: { organizationId: orgId } });
  await prisma.platOntologyBranch.deleteMany({ where: { organizationId: orgId } });
  await prisma.platOntologyVersion.deleteMany({ where: { organizationId: orgId } });
  await prisma.platOntology.deleteMany({ where: { organizationId: orgId } });
  await prisma.platResource.deleteMany({ where: { organizationId: orgId } });
  await prisma.platProject.deleteMany({ where: { organizationId: orgId } });
  await prisma.platWorkspace.deleteMany({ where: { organizationId: orgId } });
  await prisma.platEnvironment.deleteMany({ where: { organizationId: orgId } });
  await prisma.platOrgMembership.deleteMany({ where: { organizationId: orgId } });
  await prisma.platIdentity.deleteMany({ where: { id: aliceId } });
  await prisma.platOrganization.deleteMany({ where: { id: orgId } });
  await prisma.platCustomerAccount.deleteMany({ where: { id: caId } });
});

const physTable = (projectId: string) => `gen__p${projectId.replace(/-/g, "")}_${entity.name}`;
async function tableExists(physName: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*) as n FROM sqlite_master WHERE type='table' AND name = ?`, physName);
  return Number(rows[0]?.n ?? 0) > 0;
}

describe("project deletion cascade", () => {
  it("refuses to delete the system default project", async () => {
    await expect(deleteProject(SYSTEM_ORG_ID, SYSTEM_PROJECT_ID, aliceId)).rejects.toThrow(/system default project/i);
  });

  it("refuses a project that does not exist in the org", async () => {
    await expect(deleteProject(orgId, newId(), aliceId)).rejects.toThrow(/not found/i);
  });

  it("drops the project's data plane, model metadata, grants, and history", async () => {
    // Preconditions: everything exists before the delete.
    expect(await tableExists(physTable(projId))).toBe(true);

    const result = await deleteProject(orgId, projId, aliceId);
    expect(result.id).toBe(projId);
    expect(result.droppedModels).toBe(1);
    expect(result.droppedTables).toContain(physTable(projId));

    // Control plane gone.
    expect(await prisma.platProject.findFirst({ where: { id: projId, organizationId: orgId } })).toBeNull();
    expect(await prisma.platOntology.count({ where: { organizationId: orgId, projectId: projId } })).toBe(0);
    expect(await prisma.platOntologyVersion.count({ where: { organizationId: orgId, ontologyId: underTest.ontologyId } })).toBe(0);
    expect(await prisma.platOntologyBranch.count({ where: { organizationId: orgId, ontologyId: underTest.ontologyId } })).toBe(0);
    expect(await prisma.platResource.count({ where: { organizationId: orgId, projectId: projId } })).toBe(0);
    expect(await prisma.platRoleAssignment.count({ where: { organizationId: orgId, scopeType: "project", scopeId: projId } })).toBe(0);

    // Data plane gone.
    expect(await tableExists(physTable(projId))).toBe(false);
    expect(await prisma.eventLog.count({ where: { organizationId: orgId, projectId: projId } })).toBe(0);

    // The destructive act is audited.
    const audit = await prisma.platAuditEvent.findFirst({ where: { organizationId: orgId, action: "project.delete", targetRef: `project:${projId}` } });
    expect(audit).not.toBeNull();
    expect(audit?.decision).toBe("allow");
  });

  it("leaves the sibling project completely untouched", async () => {
    expect(await prisma.platProject.findFirst({ where: { id: siblingId, organizationId: orgId } })).not.toBeNull();
    expect(await prisma.platOntology.count({ where: { organizationId: orgId, projectId: siblingId } })).toBe(1);
    expect(await tableExists(physTable(siblingId))).toBe(true);
    expect(await prisma.eventLog.count({ where: { organizationId: orgId, projectId: siblingId } })).toBe(1);
  });
});
