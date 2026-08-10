import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";
import { prisma } from "../../src/db.js";
import { newId } from "../../src/platform/ids.js";
import { readSidecar, writeSidecar, deleteSidecar } from "../../src/packs/sidecar.js";
import { deleteConnectorFiles } from "../../src/packs/connector/runtime.js";
import { SCHEDULE_MIN_MINUTES } from "../../src/packs/scheduler.js";

const SFX = `csch${Date.now().toString(36)}`;
const SUBJECT = `conn-sched-${SFX}`;

const caId = newId();
const orgId = newId();
const envId = newId();
const wsId = newId();
const wfId = newId();
let identityId: string;

const ID = `sch-${SFX}`;
const ID_FOREIGN = `sch-foreign-${SFX}`;
const SIDECAR_IDS = [ID, ID_FOREIGN];

let app: FastifyInstance;

const AUTHED = { authorization: `Bearer ${SUBJECT}`, "x-org-id": orgId, "x-workflow-id": wfId };

const post = (id: string, body: Record<string, unknown>) =>
  app.inject({ method: "POST", url: `/api/connectors/${id}/schedule`, headers: AUTHED, payload: body });

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

  writeSidecar({ id: ID, kind: "connector", boundedContext: "TestBC", targetEntity: "TestEntity", phase: "built", mode: "live", workflowId: wfId, organizationId: orgId });
  writeSidecar({ id: ID_FOREIGN, kind: "connector", boundedContext: "TestBC", targetEntity: "ForeignEntity", phase: "built", mode: "live", workflowId: newId(), organizationId: orgId });
});

afterAll(async () => {
  for (const id of SIDECAR_IDS) { deleteSidecar(id); deleteConnectorFiles(id); }
  await prisma.platAuditEvent.deleteMany({ where: { organizationId: orgId } });
  await prisma.platRoleAssignment.deleteMany({ where: { organizationId: orgId } });
  await prisma.platOrgMembership.deleteMany({ where: { organizationId: orgId } });
  await prisma.platIdentity.deleteMany({ where: { id: identityId } });
  await prisma.platWorkflow.deleteMany({ where: { organizationId: orgId } });
  await prisma.platWorkspace.deleteMany({ where: { organizationId: orgId } });
  await prisma.platEnvironment.deleteMany({ where: { organizationId: orgId } });
  await prisma.platOrganization.deleteMany({ where: { id: orgId } });
  await prisma.platCustomerAccount.deleteMany({ where: { id: caId } });
  await app?.close();
});

describe("POST /api/connectors/:id/schedule", () => {
  it("enables polling and persists it to the sidecar", async () => {
    const res = await post(ID, { enabled: true, everyMinutes: 30 });
    expect(res.statusCode).toBe(200);
    expect(res.json().schedule).toMatchObject({ enabled: true, everyMinutes: 30, failures: 0 });
    expect(readSidecar(ID)?.schedule).toMatchObject({ enabled: true, everyMinutes: 30 });
  });

  it("rejects an interval below the floor when enabling", async () => {
    const res = await post(ID, { enabled: true, everyMinutes: SCHEDULE_MIN_MINUTES - 1 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("BAD_INTERVAL");
    expect(readSidecar(ID)?.schedule?.everyMinutes).toBe(30); // unchanged
  });

  it("rejects a non-numeric interval when enabling", async () => {
    expect((await post(ID, { enabled: true, everyMinutes: "soon" })).statusCode).toBe(400);
    expect((await post(ID, { enabled: true })).statusCode).toBe(400);
  });

  it("keeps the chosen interval when turning polling off", async () => {
    const res = await post(ID, { enabled: false, everyMinutes: 90 });
    expect(res.statusCode).toBe(200);
    expect(res.json().schedule).toMatchObject({ enabled: false, everyMinutes: 90 });
    expect(readSidecar(ID)?.schedule?.everyMinutes).toBe(90);
  });

  it("clears the failure streak and the auto-disable reason on save", async () => {
    const cur = readSidecar(ID)!;
    writeSidecar({ ...cur, schedule: { enabled: false, everyMinutes: 90, failures: 4, disabledReason: "boom" } });
    await post(ID, { enabled: true, everyMinutes: 15 });
    expect(readSidecar(ID)?.schedule?.failures).toBe(0);
  });

  it("404s a foreign connector exactly like an unknown one", async () => {
    const foreign = await post(ID_FOREIGN, { enabled: true, everyMinutes: 15 });
    const unknown = await post(`nope-${SFX}`, { enabled: true, everyMinutes: 15 });
    expect(foreign.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(foreign.json().error).toBe(unknown.json().error);
    expect(readSidecar(ID_FOREIGN)?.schedule).toBeUndefined();
  });
});
