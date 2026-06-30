// Workstreams A + B: the actor primitive on EventLog and the PDP gate on the
// data plane. Proves (1) emitted events are attributed by actorKind (human vs ai),
// and (2) guardData() lets an org editor write but denies a viewer — auditing the
// deny — while leaving reads open to the viewer.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { newId } from "../../src/platform/ids.js";
import { runWithTenant } from "../../src/platform/tenancy/context.js";
import { withActorKind, currentActorKind } from "../../src/platform/tenancy/actor.js";
import { guardData } from "../../src/platform/authz.js";
import { AuthError } from "../../src/errors.js";
import { genericNewInstance } from "../../src/twin/sim.js";
import { modelHarness } from "../helpers/po-model.js";
import type { TenantContext } from "../../src/platform/types.js";

// A minimal root aggregate the generic simulator can instantiate on its own
// (id auto, status from exampleData) — so genericNewInstance() emits one event.
const CREATABLE_MODEL = JSON.stringify({
  version: 1,
  boundedContext: "Demo",
  roles: ["Agent"],
  domainEvents: {
    ThingCreated: {
      event: "Thing Created",
      role: "Agent",
      command: { $ref: "#/schemas/commands/CreateThing" },
      aggregateRoot: { $ref: "#/schemas/entities/Thing" },
      acceptanceCriteria: ["Given a request, When raised, Then a DRAFT thing exists"],
    },
  },
  schemas: {
    entities: {
      Thing: { required: ["id", "status"], fields: [{ name: "id", dataType: "string" }, { name: "status", dataType: "string", exampleData: ["DRAFT"] }] },
    },
    commands: { CreateThing: { required: [], fields: [{ name: "title" }] } },
  },
});

describe("actor primitive — emit() attribution", () => {
  it("currentActorKind defaults to system off-request and honours an explicit scope", async () => {
    expect(currentActorKind()).toBe("system"); // no bound context here
    await withActorKind("ai", async () => {
      expect(currentActorKind()).toBe("ai");
    });
  });

  it("stamps human for a direct run and ai for a chat-driven run", async () => {
    const human = modelHarness(CREATABLE_MODEL);
    await human.run(async () => {
      await genericNewInstance();
    });
    const ai = modelHarness(CREATABLE_MODEL);
    await ai.run(() => withActorKind("ai", async () => {
      await genericNewInstance();
    }));

    const humanRows = await prisma.eventLog.findMany({ where: { workflowId: human.workflowId }, select: { actorKind: true } });
    const aiRows = await prisma.eventLog.findMany({ where: { workflowId: ai.workflowId }, select: { actorKind: true } });

    expect(humanRows.length).toBeGreaterThan(0);
    expect(aiRows.length).toBeGreaterThan(0);
    expect(humanRows.every((r) => r.actorKind === "human")).toBe(true);
    expect(aiRows.every((r) => r.actorKind === "ai")).toBe(true);

    await prisma.eventLog.deleteMany({ where: { workflowId: { in: [human.workflowId, ai.workflowId] } } });
  });
});

describe("data-plane PDP — guardData", () => {
  const caId = newId();
  const orgId = newId();
  const wfId = newId();
  const editorId = newId();
  const viewerId = newId();

  const ctxFor = (principalId: string): TenantContext => ({
    organizationId: orgId,
    principal: { id: principalId, type: "identity" },
    identityId: principalId,
    workflowId: wfId,
  });

  beforeAll(async () => {
    await prisma.platCustomerAccount.create({ data: { id: caId, name: `CA dpz ${orgId}` } });
    await prisma.platOrganization.create({ data: { id: orgId, customerAccountId: caId, name: `Org dpz`, slug: `org-dpz-${orgId}` } });
    for (const id of [editorId, viewerId]) {
      await prisma.platIdentity.create({ data: { id, subject: `dpz-${id}` } });
      await prisma.platOrgMembership.create({ data: { id: newId(), identityId: id, organizationId: orgId } });
    }
    // Org-scoped grants flow down the containment chain to the workflow resource.
    await prisma.platRoleAssignment.create({ data: { id: newId(), organizationId: orgId, principalId: editorId, principalType: "identity", roleKey: "editor", scopeType: "organization", scopeId: orgId } });
    await prisma.platRoleAssignment.create({ data: { id: newId(), organizationId: orgId, principalId: viewerId, principalType: "identity", roleKey: "viewer", scopeType: "organization", scopeId: orgId } });
  });

  afterAll(async () => {
    await prisma.platAuditEvent.deleteMany({ where: { organizationId: orgId } });
    await prisma.platRoleAssignment.deleteMany({ where: { organizationId: orgId } });
    await prisma.platOrgMembership.deleteMany({ where: { organizationId: orgId } });
    await prisma.platIdentity.deleteMany({ where: { id: { in: [editorId, viewerId] } } });
    await prisma.platOrganization.deleteMany({ where: { id: orgId } });
    await prisma.platCustomerAccount.deleteMany({ where: { id: caId } });
  });

  it("allows an editor to write", async () => {
    await expect(runWithTenant(ctxFor(editorId), () => guardData("workflow.command.write"))).resolves.toBeUndefined();
  });

  it("denies a viewer on a write and audits the deny", async () => {
    await expect(runWithTenant(ctxFor(viewerId), () => guardData("workflow.command.write"))).rejects.toBeInstanceOf(AuthError);
    const denies = await prisma.platAuditEvent.count({ where: { organizationId: orgId, decision: "deny" } });
    expect(denies).toBeGreaterThan(0);
  });

  it("allows a viewer to read", async () => {
    await expect(runWithTenant(ctxFor(viewerId), () => guardData("workflow.read"))).resolves.toBeUndefined();
  });
});
