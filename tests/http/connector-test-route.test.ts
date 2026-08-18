// POST /api/bc/:bc/adapter/:id/test is what the connector detail's test button
// calls. It was labelled a dry run and documented as writing nothing, but it
// pulls — and an actuator's pull is its action. This is the route-level gate.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";
import { prisma } from "../../src/db.js";
import { newId } from "../../src/platform/ids.js";
import { registerAdapter, unregisterAdapter } from "../../src/packs/registry.js";
import { writeSidecar, deleteSidecar } from "../../src/packs/sidecar.js";
import { deleteConnectorFiles } from "../../src/packs/connector/runtime.js";
import { setWorkflowModel } from "../../src/ontology/model.js";
import type { AdapterBehavior } from "../../src/packs/types.js";

const MODEL = JSON.stringify({
  version: 1,
  boundedContext: "Hubspot",
  roles: ["Automation"],
  domainEvents: {
    ContactCreated: {
      event: "Contact Created",
      role: "Automation",
      command: { $ref: "#/schemas/commands/CreateContact" },
      aggregateRoot: { $ref: "#/schemas/entities/Contact" },
    },
  },
  schemas: {
    entities: { Contact: { required: ["id"], fields: [{ name: "id", dataType: "string" }, { name: "email", dataType: "string" }] } },
    commands: { CreateContact: { required: ["email"], fields: [{ name: "email" }] } },
  },
});

const SFX = `ctr${Date.now().toString(36)}`;
const SUBJECT = `conn-test-${SFX}`;

const caId = newId();
const orgId = newId();
const envId = newId();
const wsId = newId();
const wfId = newId();
let identityId: string;

const ACT = `route-act-${SFX}`;
const SYNC = `route-sync-${SFX}`;
const IDS = [ACT, SYNC];

const pulls: string[] = [];
let app: FastifyInstance;

const AUTHED = { authorization: `Bearer ${SUBJECT}`, "x-org-id": orgId, "x-workflow-id": wfId };

const test = (id: string, body: Record<string, unknown> = {}) =>
  app.inject({ method: "POST", url: `/api/bc/Hubspot/adapter/${id}/test`, headers: AUTHED, payload: body });

const spyAdapter = (id: string, behavior: AdapterBehavior) => {
  writeSidecar({
    id, kind: "connector", behavior, boundedContext: "Hubspot", targetEntity: "Contact",
    phase: "built", mode: "live", workflowId: wfId, organizationId: orgId,
  });
  registerAdapter({
    id, kind: "connector", boundedContext: "Hubspot", targetEntity: "Contact", mode: "live" as const,
    async introspect() { return { entity: "Contact", fields: [] }; },
    async mapping() { return {}; },
    async pull() { pulls.push(id); return { rows: { Contact: [] }, count: 0 }; },
    async push() { return { pushed: 0 }; },
    async healthcheck() { return { ok: true }; },
  } as any);
};

beforeAll(async () => {
  app = await buildServer();
  await prisma.platCustomerAccount.create({ data: { id: caId, name: `CA ${SFX}` } });
  await prisma.platOrganization.create({ data: { id: orgId, customerAccountId: caId, name: `Org ${SFX}`, slug: `org-${SFX}` } });
  await prisma.platEnvironment.create({ data: { id: envId, organizationId: orgId, name: "development", region: "local" } });
  await prisma.platWorkspace.create({ data: { id: wsId, organizationId: orgId, environmentId: envId, name: "Default" } });
  await prisma.platWorkflow.create({ data: { id: wfId, organizationId: orgId, workspaceId: wsId, name: "Default" } });
  identityId = (await prisma.platIdentity.create({ data: { id: newId(), subject: SUBJECT } })).id;
  await prisma.platOrgMembership.create({ data: { id: newId(), identityId, organizationId: orgId } });
  await prisma.platRoleAssignment.create({ data: { id: newId(), organizationId: orgId, principalId: identityId, principalType: "identity", roleKey: "org_admin", scopeType: "organization", scopeId: orgId } });

  setWorkflowModel(wfId, MODEL, null, `conn-test-${SFX}`);
  spyAdapter(ACT, "actuator");
  spyAdapter(SYNC, "sync");
});

afterAll(async () => {
  for (const id of IDS) { unregisterAdapter(id); deleteSidecar(id); deleteConnectorFiles(id); }
  await prisma.platAuditEvent.deleteMany({ where: { organizationId: orgId } });
  await prisma.platRoleAssignment.deleteMany({ where: { organizationId: orgId } });
  await prisma.platOrgMembership.deleteMany({ where: { organizationId: orgId } });
  await prisma.platIdentity.deleteMany({ where: { id: identityId } });
  await prisma.platWorkflow.deleteMany({ where: { organizationId: orgId } });
  await prisma.platWorkspace.deleteMany({ where: { organizationId: orgId } });
  await prisma.platEnvironment.deleteMany({ where: { organizationId: orgId } });
  await prisma.platOrganization.deleteMany({ where: { id: orgId } });
  await prisma.platCustomerAccount.deleteMany({ where: { id: caId } });
  await app.close();
});

describe("POST /adapter/:id/test", () => {
  it("refuses an actuator without ever running it", async () => {
    pulls.length = 0;
    const r = await test(ACT);
    expect(r.statusCode).toBe(422);
    expect(r.json().message).toMatch(/performs actions in Hubspot/i);
    expect(pulls).toEqual([]);
  });

  it("runs it once the caller confirms the actions", async () => {
    pulls.length = 0;
    const r = await test(ACT, { confirmActions: true });
    expect(r.statusCode).not.toBe(422);
    expect(pulls).toEqual([ACT]);
  });

  it("leaves a read-only connector alone", async () => {
    pulls.length = 0;
    const r = await test(SYNC);
    expect(r.statusCode).not.toBe(422);
    expect(pulls).toEqual([SYNC]);
  });
});
