// The trigger-rule routes + structured manifest, end-to-end over HTTP. Pins:
//   - rule save is connector.build (403 for an editor — rule code runs in-process
//     at derive time, the same trust surface as connector code),
//   - workflow scoping: unknown/foreign ids get the identical 404,
//   - the saved rule round-trips (list → code → manifest) with live status,
//   - deny-scanned code is a 422 DomainError, unknown events a 422,
//   - the manifest lists EVERY event on the target — ruled ones with their
//     condition, the rest as "static" — and delete restores static.
// No LLM key involved anywhere on these paths.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";
import { prisma } from "../../src/db.js";
import { newId } from "../../src/platform/ids.js";
import { ensureOntologyResource, createVersion } from "../../src/platform/ontology-store/ontology-store.js";
import { writeSidecar, deleteSidecar } from "../../src/packs/sidecar.js";
import { deleteConnectorFiles } from "../../src/packs/connector/runtime.js";
import { deleteDoc } from "../../src/packs/connector/journal.js";

const SFX = `trul${Date.now().toString(36)}`;
const ADMIN_SUBJECT = `rule-admin-${SFX}`;
const EDITOR_SUBJECT = `rule-editor-${SFX}`;

const caId = newId();
const orgId = newId();
const envId = newId();
const wsId = newId();
const wfId = newId();
let adminId: string;
let editorId: string;

const CONN = `rule-conn-${SFX}`;
const FOREIGN = `rule-foreign-${SFX}`;

const MODEL = JSON.stringify({
  version: 1,
  boundedContext: "Sales",
  roles: ["Rep"],
  domainEvents: {
    DealCreated: {
      event: "Deal Created", role: "Rep",
      command: { $ref: "#/schemas/commands/PlaceDeal" },
      aggregateRoot: { $ref: "#/schemas/entities/Deal" },
    },
    UpsellDealCreated: {
      event: "Upsell Deal Created", role: "Rep",
      follows: [{ $ref: "#/domainEvents/DealCreated" }],
      command: { $ref: "#/schemas/commands/CategorizeDeal" },
      aggregateRoot: { $ref: "#/schemas/entities/Deal" },
      acceptanceCriteria: ["Given a deal, When its category is upsell, Then an upsell deal is recorded"],
    },
  },
  schemas: {
    entities: {
      Deal: {
        required: ["id"],
        fields: [
          { name: "id", dataType: "string" },
          { name: "category", dataType: "string" },
          { name: "amount", dataType: "number" },
        ],
      },
    },
    commands: {
      PlaceDeal: { required: [], fields: [{ name: "amount" }] },
      CategorizeDeal: { required: [], fields: [{ name: "category" }] },
    },
  },
});

const RULE_CODE = `export function detect(row, ctx, previous) {
  const fired = String(row.category) === "upsell";
  return { fired, evidence: "category=" + row.category };
}
`;

let app: FastifyInstance;
const AUTHED = { authorization: `Bearer ${ADMIN_SUBJECT}`, "x-org-id": orgId, "x-workflow-id": wfId };
const AS_EDITOR = { authorization: `Bearer ${EDITOR_SUBJECT}`, "x-org-id": orgId, "x-workflow-id": wfId };

beforeAll(async () => {
  app = await buildServer();
  await prisma.platCustomerAccount.create({ data: { id: caId, name: `CA ${SFX}` } });
  await prisma.platOrganization.create({ data: { id: orgId, customerAccountId: caId, name: `Org ${SFX}`, slug: `org-${SFX}` } });
  await prisma.platEnvironment.create({ data: { id: envId, organizationId: orgId, name: "development", region: "local" } });
  await prisma.platWorkspace.create({ data: { id: wsId, organizationId: orgId, environmentId: envId, name: "Default" } });
  await prisma.platWorkflow.create({ data: { id: wfId, organizationId: orgId, workspaceId: wsId, name: "Default" } });
  adminId = (await prisma.platIdentity.create({ data: { id: newId(), subject: ADMIN_SUBJECT } })).id;
  editorId = (await prisma.platIdentity.create({ data: { id: newId(), subject: EDITOR_SUBJECT } })).id;
  for (const id of [adminId, editorId]) {
    await prisma.platOrgMembership.create({ data: { id: newId(), identityId: id, organizationId: orgId } });
  }
  await prisma.platRoleAssignment.create({ data: { id: newId(), organizationId: orgId, principalId: adminId, principalType: "identity", roleKey: "org_admin", scopeType: "organization", scopeId: orgId } });
  await prisma.platRoleAssignment.create({ data: { id: newId(), organizationId: orgId, principalId: editorId, principalType: "identity", roleKey: "editor", scopeType: "organization", scopeId: orgId } });
  const { ontologyId } = await ensureOntologyResource({ organizationId: orgId, workflowId: wfId, workspaceId: wsId, name: "workflow", ownerId: adminId });
  await createVersion(orgId, ontologyId, MODEL, null, { source: "initial" });

  writeSidecar({
    id: CONN, kind: "connector", boundedContext: "Sales", targetEntity: "Deal",
    phase: "built", mode: "recorded", targetKind: "entity", workflowId: wfId, organizationId: orgId,
  });
  // A FOREIGN workflow's connector: its id must 404 here (no existence oracle).
  writeSidecar({
    id: FOREIGN, kind: "connector", boundedContext: "Sales", targetEntity: "Deal",
    phase: "built", mode: "recorded", targetKind: "entity", workflowId: newId(), organizationId: orgId,
  });
});

afterAll(async () => {
  for (const id of [CONN, FOREIGN]) { deleteSidecar(id); deleteConnectorFiles(id); deleteDoc(id); }
  await prisma.platAuditEvent.deleteMany({ where: { organizationId: orgId } });
  await prisma.platOntologyBranch.deleteMany({ where: { organizationId: orgId } });
  await prisma.platOntologyVersion.deleteMany({ where: { organizationId: orgId } });
  await prisma.platOntology.deleteMany({ where: { organizationId: orgId } });
  await prisma.platResource.deleteMany({ where: { organizationId: orgId } });
  await prisma.platRoleAssignment.deleteMany({ where: { organizationId: orgId } });
  await prisma.platOrgMembership.deleteMany({ where: { organizationId: orgId } });
  await prisma.platIdentity.deleteMany({ where: { id: { in: [adminId, editorId] } } });
  await prisma.platWorkflow.deleteMany({ where: { organizationId: orgId } });
  await prisma.platWorkspace.deleteMany({ where: { organizationId: orgId } });
  await prisma.platEnvironment.deleteMany({ where: { organizationId: orgId } });
  await prisma.platOrganization.deleteMany({ where: { id: orgId } });
  await prisma.platCustomerAccount.deleteMany({ where: { id: caId } });
  await app?.close();
});

const ruleUrl = (id: string, event: string, tail: string) =>
  `/api/connectors/${id}/rules/${event}/${tail}`;

describe("trigger-rule routes + manifest", () => {
  it("editor is denied rule save (connector.build), admin succeeds", async () => {
    const denied = await app.inject({
      method: "POST", url: ruleUrl(CONN, "UpsellDealCreated", "code"), headers: AS_EDITOR,
      payload: { code: RULE_CODE, condition: "deal category is upsell" },
    });
    expect(denied.statusCode).toBe(403);

    const ok = await app.inject({
      method: "POST", url: ruleUrl(CONN, "UpsellDealCreated", "code"), headers: AUTHED,
      payload: { code: RULE_CODE, condition: "deal category is upsell" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().rule.eventKey).toBe("UpsellDealCreated");
    expect(ok.json().rule.author).toBe("human");
  });

  it("unknown and foreign connector ids get the identical 404", async () => {
    for (const id of [`nope-${SFX}`, FOREIGN]) {
      const res = await app.inject({ method: "GET", url: `/api/connectors/${id}/rules`, headers: AUTHED });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("UNKNOWN_CONNECTOR");
    }
  });

  it("deny-scanned code and unknown events are 422s", async () => {
    const denied = await app.inject({
      method: "POST", url: ruleUrl(CONN, "UpsellDealCreated", "code"), headers: AUTHED,
      payload: { code: `export function detect(row){ fetch("http://x"); return {fired:false} }` },
    });
    expect(denied.statusCode).toBe(422);
    expect(denied.json().message).toContain("deny-scan");

    const noEvent = await app.inject({
      method: "POST", url: ruleUrl(CONN, "NoSuchEvent", "code"), headers: AUTHED,
      payload: { code: RULE_CODE },
    });
    expect(noEvent.statusCode).toBe(422);
  });

  it("the rule round-trips: list shows live status, the code route returns the source", async () => {
    const list = await app.inject({ method: "GET", url: `/api/connectors/${CONN}/rules`, headers: AUTHED });
    expect(list.statusCode).toBe(200);
    expect(list.json().rules).toEqual([
      expect.objectContaining({ eventKey: "UpsellDealCreated", eventName: "Upsell Deal Created", condition: "deal category is upsell", status: "ok", author: "human" }),
    ]);

    const code = await app.inject({ method: "GET", url: ruleUrl(CONN, "UpsellDealCreated", "code"), headers: AUTHED });
    expect(code.statusCode).toBe(200);
    expect(code.json().code).toBe(RULE_CODE);
    expect(code.json().status).toBe("ok");
  });

  it("the manifest lists every event on the target — the ruled one with its condition, the rest static", async () => {
    const res = await app.inject({ method: "GET", url: `/api/connectors/${CONN}/manifest`, headers: AUTHED });
    expect(res.statusCode).toBe(200);
    const m = res.json();
    expect(m.target).toEqual({ name: "Deal", kind: "entity", rowCount: 0 });
    const events = m.sections.find((s: any) => s.kind === "canTriggerEvents");
    expect(events.items).toEqual([
      expect.objectContaining({ eventKey: "DealCreated", condition: null, status: "static" }),
      expect.objectContaining({ eventKey: "UpsellDealCreated", condition: "deal category is upsell", status: "ok" }),
    ]);
  });

  it("delete removes the rule and the manifest falls back to static", async () => {
    const del = await app.inject({ method: "POST", url: ruleUrl(CONN, "UpsellDealCreated", "delete"), headers: AUTHED, payload: {} });
    expect(del.statusCode).toBe(200);
    const list = await app.inject({ method: "GET", url: `/api/connectors/${CONN}/rules`, headers: AUTHED });
    expect(list.json().rules).toEqual([]);
    const m = (await app.inject({ method: "GET", url: `/api/connectors/${CONN}/manifest`, headers: AUTHED })).json();
    const events = m.sections.find((s: any) => s.kind === "canTriggerEvents");
    expect(events.items.every((i: any) => i.status === "static")).toBe(true);
  });

  it("rules survive export → delete → import; a hostile envelope rule is deny-scanned out per-rule", async () => {
    // Re-arm the rule, then take a portable backup.
    await app.inject({
      method: "POST", url: ruleUrl(CONN, "UpsellDealCreated", "code"), headers: AUTHED,
      payload: { code: RULE_CODE, condition: "deal category is upsell" },
    });
    const envelope = (await app.inject({ method: "GET", url: `/api/connectors/${CONN}/export`, headers: AUTHED })).json();
    expect(envelope.connectors[0].rules).toEqual([
      expect.objectContaining({ eventKey: "UpsellDealCreated", condition: "deal category is upsell", code: RULE_CODE }),
    ]);

    // Full teardown, then restore from the backup — with a smuggled hostile rule.
    const del = await app.inject({ method: "POST", url: `/api/connectors/${CONN}/delete`, headers: AUTHED, payload: {} });
    expect(del.statusCode).toBe(200);
    envelope.connectors[0].rules.push({
      eventKey: "DealCreated", eventRef: "#/domainEvents/DealCreated", condition: "evil",
      gwtHash: "x", author: "ai", code: `export function detect(row){ require("fs"); return {fired:true} }`,
    });
    const imp = await app.inject({ method: "POST", url: "/api/connectors/import", headers: AUTHED, payload: envelope });
    expect(imp.statusCode).toBe(200);
    expect(imp.json().imported[0].rules).toEqual({
      imported: 1,
      skipped: [{ eventKey: "DealCreated", reason: expect.stringContaining("deny-scan") }],
    });

    // The restored rule is live again — status computed against THIS model's GWTs.
    const list = await app.inject({ method: "GET", url: `/api/connectors/${CONN}/rules`, headers: AUTHED });
    expect(list.json().rules).toEqual([
      expect.objectContaining({ eventKey: "UpsellDealCreated", condition: "deal category is upsell", status: "ok" }),
    ]);
  });
});
