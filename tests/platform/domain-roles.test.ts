// Domain-role mapping ("identity X plays lane Y in workflow Z") — the
// personalization layer behind whoami.domainRoles and the To do tab's "my
// roles" filter. Pins: round trip, idempotent grant, org scoping (no cross-org
// read/write/grant), and membership/workflow validation on writes.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { DomainError } from "../../src/errors.js";
import {
  assignDomainRole,
  domainRolesFor,
  listDomainRoles,
  removeDomainRole,
} from "../../src/platform/domain-roles.js";
import { newId } from "../../src/platform/ids.js";

const SFX = `dr${Date.now().toString(36)}`;
const caId = newId();
const orgAId = newId();
const orgBId = newId();
const envId = newId();
const wsId = newId();
const wfId = newId();

let aliceId: string;
let bobId: string; // member of org B only

beforeAll(async () => {
  await prisma.platCustomerAccount.create({ data: { id: caId, name: `CA ${SFX}` } });
  await prisma.platOrganization.create({ data: { id: orgAId, customerAccountId: caId, name: `OrgA ${SFX}`, slug: `orga-${SFX}` } });
  await prisma.platOrganization.create({ data: { id: orgBId, customerAccountId: caId, name: `OrgB ${SFX}`, slug: `orgb-${SFX}` } });
  await prisma.platEnvironment.create({ data: { id: envId, organizationId: orgAId, name: `dev-${SFX}` } });
  await prisma.platWorkspace.create({ data: { id: wsId, organizationId: orgAId, environmentId: envId, name: `ws-${SFX}` } });
  await prisma.platWorkflow.create({ data: { id: wfId, organizationId: orgAId, workspaceId: wsId, name: `wf-${SFX}` } });
  aliceId = (await prisma.platIdentity.create({ data: { id: newId(), subject: `alice-${SFX}` } })).id;
  bobId = (await prisma.platIdentity.create({ data: { id: newId(), subject: `bob-${SFX}` } })).id;
  await prisma.platOrgMembership.create({ data: { id: newId(), identityId: aliceId, organizationId: orgAId } });
  await prisma.platOrgMembership.create({ data: { id: newId(), identityId: bobId, organizationId: orgBId } });
});

afterAll(async () => {
  await prisma.platDomainRoleAssignment.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.platOrgMembership.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.platIdentity.deleteMany({ where: { id: { in: [aliceId, bobId] } } });
  await prisma.platWorkflow.deleteMany({ where: { id: wfId } });
  await prisma.platWorkspace.deleteMany({ where: { id: wsId } });
  await prisma.platEnvironment.deleteMany({ where: { id: envId } });
  await prisma.platOrganization.deleteMany({ where: { id: { in: [orgAId, orgBId] } } });
  await prisma.platCustomerAccount.deleteMany({ where: { id: caId } });
});

describe("domain-role mapping", () => {
  it("grants a lane and reads it back via domainRolesFor + listDomainRoles", async () => {
    await assignDomainRole({ organizationId: orgAId, workflowId: wfId, identityId: aliceId, domainRole: "Buyer", grantedBy: aliceId });
    await assignDomainRole({ organizationId: orgAId, workflowId: wfId, identityId: aliceId, domainRole: "Analyst" });
    expect(await domainRolesFor(orgAId, wfId, aliceId)).toEqual(["Analyst", "Buyer"]);
    const list = await listDomainRoles(orgAId, wfId);
    expect(list).toHaveLength(2);
    expect(list[0]!.subject).toBe(`alice-${SFX}`);
  });

  it("re-granting the same triple is idempotent (same row, no duplicate)", async () => {
    const first = await assignDomainRole({ organizationId: orgAId, workflowId: wfId, identityId: aliceId, domainRole: "Buyer" });
    const again = await assignDomainRole({ organizationId: orgAId, workflowId: wfId, identityId: aliceId, domainRole: "Buyer" });
    expect(again.id).toBe(first.id);
    const rows = await prisma.platDomainRoleAssignment.findMany({ where: { organizationId: orgAId, workflowId: wfId, identityId: aliceId, domainRole: "Buyer" } });
    expect(rows).toHaveLength(1);
  });

  it("rejects a grant to a non-member and to a foreign workflow", async () => {
    // bob is a member of org B, not org A.
    await expect(
      assignDomainRole({ organizationId: orgAId, workflowId: wfId, identityId: bobId, domainRole: "Buyer" }),
    ).rejects.toThrow(DomainError);
    // org B granting against org A's workflow: the workflow lookup is org-scoped.
    await expect(
      assignDomainRole({ organizationId: orgBId, workflowId: wfId, identityId: bobId, domainRole: "Buyer" }),
    ).rejects.toThrow(/workflow not found/);
  });

  it("reads and deletes are org-scoped — no cross-org reach", async () => {
    expect(await listDomainRoles(orgBId, wfId)).toEqual([]);
    expect(await domainRolesFor(orgBId, wfId, aliceId)).toEqual([]);
    const row = await prisma.platDomainRoleAssignment.findFirst({ where: { organizationId: orgAId, workflowId: wfId, domainRole: "Buyer" } });
    await expect(removeDomainRole(orgBId, row!.id)).rejects.toThrow(/not found/);
    // …and the row survived the foreign delete attempt.
    expect(await prisma.platDomainRoleAssignment.findUnique({ where: { id: row!.id } })).not.toBeNull();
  });

  it("removes an assignment in-org", async () => {
    const { id } = await assignDomainRole({ organizationId: orgAId, workflowId: wfId, identityId: aliceId, domainRole: "Temp" });
    await removeDomainRole(orgAId, id);
    expect(await domainRolesFor(orgAId, wfId, aliceId)).not.toContain("Temp");
  });

  it("rejects an empty lane name", async () => {
    await expect(
      assignDomainRole({ organizationId: orgAId, workflowId: wfId, identityId: aliceId, domainRole: "  " }),
    ).rejects.toThrow(/domainRole is required/);
  });
});
