// GET /api/connectors/export and /api/connectors/:id/export — the portable
// connector backup. Pins the contract the format's future import depends on:
//   - the versioned envelope shape and the attachment Content-Disposition,
//   - tenancy/environment fields are STRIPPED (portability),
//   - credential VALUES never appear even when a cred file exists — only field
//     names (secret hygiene),
//   - the config allow-list is pinned exactly, so a future AdapterConfig field
//     cannot leak into exports without failing here,
//   - workflow scoping: foreign and unknown ids 404 identically, foreign and
//     non-connector sidecars are absent from export-all.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";
import { prisma } from "../../src/db.js";
import { newId } from "../../src/platform/ids.js";
import { writeSidecar, deleteSidecar } from "../../src/packs/sidecar.js";
import { writeModule, writeCredentials, deleteConnectorFiles } from "../../src/packs/connector/runtime.js";
import {
  exportConnectorEntry, CONNECTOR_EXPORT_FORMAT, CONNECTOR_EXPORT_VERSION,
} from "../../src/packs/connector/export.js";
import type { AdapterConfig } from "../../src/packs/types.js";

const SFX = `cexp${Date.now().toString(36)}`;
const SUBJECT = `conn-export-${SFX}`;

const caId = newId();
const orgId = newId();
const envId = newId();
const wsId = newId();
const wfId = newId();
const emptyWfId = newId();
let identityId: string;

const ID_FULL = `exp-full-${SFX}`;
const ID_DRAFT = `exp-draft-${SFX}`;
const ID_FOREIGN = `exp-foreign-${SFX}`;
const ID_SIM = `exp-sim-${SFX}`;
const SIDECAR_IDS = [ID_FULL, ID_DRAFT, ID_FOREIGN, ID_SIM];

const SECRET = `super-secret-value-${SFX}`;
const CODE = `export async function pull(ctx) { return { rows: [] }; }`;

let app: FastifyInstance;

const AUTHED = {
  authorization: `Bearer ${SUBJECT}`,
  "x-org-id": orgId,
  "x-workflow-id": wfId,
};

beforeAll(async () => {
  app = await buildServer();
  await prisma.platCustomerAccount.create({ data: { id: caId, name: `CA ${SFX}` } });
  await prisma.platOrganization.create({ data: { id: orgId, customerAccountId: caId, name: `Org ${SFX}`, slug: `org-${SFX}` } });
  await prisma.platEnvironment.create({ data: { id: envId, organizationId: orgId, name: "development", region: "local" } });
  await prisma.platWorkspace.create({ data: { id: wsId, organizationId: orgId, environmentId: envId, name: "Default" } });
  await prisma.platWorkflow.create({ data: { id: wfId, organizationId: orgId, workspaceId: wsId, name: "Default" } });
  await prisma.platWorkflow.create({ data: { id: emptyWfId, organizationId: orgId, workspaceId: wsId, name: "Empty" } });
  identityId = (await prisma.platIdentity.create({ data: { id: newId(), subject: SUBJECT } })).id;
  await prisma.platOrgMembership.create({ data: { id: newId(), identityId, organizationId: orgId } });
  await prisma.platRoleAssignment.create({ data: { id: newId(), organizationId: orgId, principalId: identityId, principalType: "identity", roleKey: "editor", scopeType: "organization", scopeId: orgId } });

  // A fully-configured connector: every portable field set, PLUS every field the
  // export must strip — so the stripping assertions bite.
  writeSidecar({
    id: ID_FULL, kind: "connector", boundedContext: "TestBC", targetEntity: "TestEntity",
    targetKind: "entity", phase: "built", mode: "live",
    workflowId: wfId, organizationId: orgId,
    credentialsRef: `CRED_${orgId}_${wfId}_${ID_FULL}`,
    lastPullAt: "2026-01-01T00:00:00.000Z", fixturesDir: "/tmp/fixtures",
    bodyPath: "src/generated/body-abc123.ts", bodyPromptHash: "abc123",
    instructions: "Pull users from the source API.",
    deps: ["@aws-sdk/client-dynamodb"],
    dateRoles: { created: "createdAt", updated: "updatedAt" },
    fieldMap: { user_name: "name" }, limits: { pageSize: 50, limit: 500 },
    endpoint: "https://api.example.com/users", connectionOptionId: "rest-api",
  });
  writeModule(ID_FULL, CODE);
  writeCredentials(ID_FULL, { apiKey: SECRET, region: "eu-north-1" });

  // Draft: registered but never built — no module, no credentials.
  writeSidecar({ id: ID_DRAFT, kind: "connector", boundedContext: "TestBC", targetEntity: "OtherEntity", phase: "draft", mode: "live", workflowId: wfId, organizationId: orgId });

  // Foreign: a connector stamped with a DIFFERENT workflow — must be invisible.
  writeSidecar({ id: ID_FOREIGN, kind: "connector", boundedContext: "TestBC", targetEntity: "ForeignEntity", phase: "built", mode: "live", workflowId: newId(), organizationId: orgId });

  // Non-connector sidecar in this workflow — excluded by kind.
  writeSidecar({ id: ID_SIM, kind: "simulated", boundedContext: "TestBC", targetEntity: "SimEntity", phase: "draft", mode: "simulated", workflowId: wfId, organizationId: orgId });
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

describe("GET /api/connectors/:id/export", () => {
  it("returns the versioned envelope as an attachment", async () => {
    const res = await app.inject({ method: "GET", url: `/api/connectors/${ID_FULL}/export`, headers: AUTHED });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.headers["content-disposition"]).toMatch(
      new RegExp(`^attachment; filename="qlerify-connector-${ID_FULL}-\\d{4}-\\d{2}-\\d{2}\\.json"$`));
    const body = res.json();
    expect(body.format).toBe(CONNECTOR_EXPORT_FORMAT);
    expect(body.version).toBe(CONNECTOR_EXPORT_VERSION);
    expect(body.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.connectors).toHaveLength(1);
    const entry = body.connectors[0];
    expect(entry.config.id).toBe(ID_FULL);
    expect(entry.code).toBe(CODE + "\n"); // writeModule normalizes the trailing newline
    expect(entry.credentialKeys.sort()).toEqual(["apiKey", "region"]);
  });

  it("never leaks credential values or tenancy/environment fields", async () => {
    const res = await app.inject({ method: "GET", url: `/api/connectors/${ID_FULL}/export`, headers: AUTHED });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(SECRET);
    const config = res.json().connectors[0].config;
    for (const stripped of ["workflowId", "organizationId", "credentialsRef", "lastPullAt", "lastPullDurationMs", "fixturesDir", "bodyPath", "bodyPromptHash"]) {
      expect(config, `"${stripped}" must not be exported`).not.toHaveProperty(stripped);
    }
  });

  it("404s identically for a foreign and an unknown id (no existence oracle)", async () => {
    for (const id of [ID_FOREIGN, `no-such-${SFX}`]) {
      const res = await app.inject({ method: "GET", url: `/api/connectors/${id}/export`, headers: AUTHED });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("UNKNOWN_CONNECTOR");
    }
  });
});

describe("GET /api/connectors/export", () => {
  it("bundles exactly the workflow's connectors — foreign and non-connector sidecars absent", async () => {
    const res = await app.inject({ method: "GET", url: "/api/connectors/export", headers: AUTHED });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(
      /^attachment; filename="qlerify-connectors-\d{4}-\d{2}-\d{2}\.json"$/);
    const ids = res.json().connectors.map((c: any) => c.config.id).sort();
    expect(ids).toEqual([ID_DRAFT, ID_FULL].sort());
    expect(res.body).not.toContain(SECRET);
  });

  it("exports a draft connector with code null and no credential keys", async () => {
    const res = await app.inject({ method: "GET", url: "/api/connectors/export", headers: AUTHED });
    const draft = res.json().connectors.find((c: any) => c.config.id === ID_DRAFT);
    expect(draft.code).toBeNull();
    expect(draft.credentialKeys).toEqual([]);
  });

  it("yields a valid empty envelope for a workflow with no connectors", async () => {
    const res = await app.inject({
      method: "GET", url: "/api/connectors/export",
      headers: { ...AUTHED, "x-workflow-id": emptyWfId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.format).toBe(CONNECTOR_EXPORT_FORMAT);
    expect(body.connectors).toEqual([]);
  });

  it("401s without credentials", async () => {
    const res = await app.inject({ method: "GET", url: "/api/connectors/export" });
    expect(res.statusCode).toBe(401);
  });
});

describe("exportConnectorEntry allow-list", () => {
  it("pins the exact exported config keys — a new AdapterConfig field cannot leak silently", () => {
    const cfg: AdapterConfig = {
      id: `pin-${SFX}`, kind: "connector", boundedContext: "BC", targetEntity: "E",
      targetKind: "entity", phase: "built", mode: "live",
      workflowId: "wf", organizationId: "org", credentialsRef: "CRED_X",
      lastPullAt: "2026-01-01T00:00:00.000Z", lastPullDurationMs: 1234, fixturesDir: "/x", bodyPath: "b.ts", bodyPromptHash: "h",
      connectionOptionId: "opt", fieldMap: { a: "b" }, limits: { pageSize: 1 },
      endpoint: "https://e", instructions: "i", deps: ["d"], dateRoles: { created: "c" },
      discoveredFields: [{ name: "src_field", dataType: "string", sample: '"x"' }],
      discoveredAt: "2026-02-02T00:00:00.000Z",
    };
    const entry = exportConnectorEntry(cfg);
    expect(Object.keys(entry.config).sort()).toEqual([
      "boundedContext", "connectionOptionId", "dateRoles", "deps", "discoveredAt",
      "discoveredFields", "endpoint", "fieldMap", "id", "instructions", "kind",
      "limits", "mode", "phase", "targetEntity", "targetKind",
    ]);
    // No module/creds on disk for this id: the entry degrades to null/[].
    expect(entry.code).toBeNull();
    expect(entry.credentialKeys).toEqual([]);
  });
});
