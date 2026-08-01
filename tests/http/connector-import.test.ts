// POST /api/connectors/import — restore/share counterpart of export. Pins:
//   - imported connectors are restamped with the DESTINATION tenancy and
//     round-trip cleanly back through export,
//   - per-entry conflict policy: same-workflow id → skip, foreign/global id
//     collision → rename (no cross-tenant existence oracle), occupied table →
//     skip, missing table → import as ORPHANED (the tab's recovery state),
//   - phase is recomputed from what actually lands (code → built, none → draft),
//   - hostile ids are re-slugged (an id becomes a sidecar FILENAME),
//   - envelope validation is a 400, authz is connector.build (403 for an
//     editor — imported code runs in the sandbox, the RCE surface).
// No LLM key in env (forced below), so the post-import summary regeneration
// exercises its deterministic fallback — no network.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";
import { prisma } from "../../src/db.js";
import { newId } from "../../src/platform/ids.js";
import { ensureOntologyResource, createVersion } from "../../src/platform/ontology-store/ontology-store.js";
import { writeSidecar, readSidecar, deleteSidecar } from "../../src/packs/sidecar.js";
import { deleteConnectorFiles, readModule } from "../../src/packs/connector/runtime.js";
import { deleteDoc } from "../../src/packs/connector/journal.js";

const SFX = `cimp${Date.now().toString(36)}`;
const ADMIN_SUBJECT = `conn-import-${SFX}`;
const EDITOR_SUBJECT = `conn-import-ed-${SFX}`;

const caId = newId();
const orgId = newId();
const envId = newId();
const wsId = newId();
const wfId = newId();
let adminId: string;
let editorId: string;

const ID_BUILT = `imp-built-${SFX}`;
const ID_DRAFT = `imp-draft-${SFX}`;
const ID_ORPHAN = `imp-orphan-${SFX}`;
const ID_TAKEN = `imp-taken-${SFX}`;
const ID_DUP_TARGET = `imp-dup-${SFX}`;
const HOSTILE_RAW = `../EVIL Path ${SFX}`;
const HOSTILE_SLUG = `evil-path-${SFX}`;
const LONG_RAW = `imp-long-${SFX}-` + "x".repeat(300);
const LONG_SLUG = LONG_RAW.slice(0, 80);
const ID_TYPES = `imp-types-${SFX}`;
const CLEANUP_IDS = [ID_BUILT, ID_DRAFT, ID_ORPHAN, ID_TAKEN, `${ID_TAKEN}-2`, ID_DUP_TARGET, HOSTILE_SLUG, LONG_SLUG, ID_TYPES];

const CODE = `export async function pull(ctx) { return { rows: [] }; }`;

// Entities the import resolves against. MissingEntity/GhostEntity deliberately absent.
const MODEL = JSON.stringify({
  version: 1,
  boundedContext: "TestBC",
  roles: ["Agent"],
  domainEvents: {},
  schemas: {
    entities: {
      TestEntity: { required: ["id"], fields: [{ name: "id", dataType: "string" }, { name: "name", dataType: "string" }] },
      OtherEntity: { required: ["id"], fields: [{ name: "id", dataType: "string" }] },
      ThirdEntity: { required: ["id"], fields: [{ name: "id", dataType: "string" }] },
    },
  },
});

const envelope = (connectors: unknown[]) => ({
  format: "qlerify-connector-export", version: 1, exportedAt: "2026-08-01T00:00:00.000Z", connectors,
});
const entry = (id: string, target: string, opts: { code?: string; credentialKeys?: string[]; kind?: string } = {}) => ({
  config: { id, kind: opts.kind ?? "connector", boundedContext: "TestBC", targetEntity: target, targetKind: "entity", phase: "built", mode: "live" },
  code: opts.code ?? null,
  credentialKeys: opts.credentialKeys ?? [],
});

let app: FastifyInstance;
const AUTHED = { authorization: `Bearer ${ADMIN_SUBJECT}`, "x-org-id": orgId, "x-workflow-id": wfId };

const ENV_KEYS = ["ANTHROPIC_API_KEY", "LLM_PROVIDER", "LLM_SETTINGS_LOCKED"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  // Force the no-provider state so the post-import summary regeneration takes its
  // deterministic fallback instead of a live AI call.
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }

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

  // A FOREIGN workflow's sidecar squatting an id the import will want.
  writeSidecar({ id: ID_TAKEN, kind: "connector", boundedContext: "TestBC", targetEntity: "ThirdEntity", phase: "built", mode: "live", workflowId: newId(), organizationId: orgId });
});

afterAll(async () => {
  for (const id of CLEANUP_IDS) { deleteSidecar(id); deleteConnectorFiles(id); deleteDoc(id); }
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
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await app?.close();
});

describe("POST /api/connectors/import", () => {
  it("imports built + draft entries, restamping tenancy and recomputing phase", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/connectors/import", headers: AUTHED,
      payload: envelope([
        entry(ID_BUILT, "TestEntity", { code: CODE, credentialKeys: ["apiKey"] }),
        entry(ID_DRAFT, "OtherEntity"),
      ]),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.skipped).toEqual([]);
    expect(body.imported.map((c: any) => c.id).sort()).toEqual([ID_BUILT, ID_DRAFT].sort());

    const built = body.imported.find((c: any) => c.id === ID_BUILT);
    expect(built.phase).toBe("built");
    expect(built.status).toBe("active");
    expect(built.credentialKeys).toEqual(["apiKey"]); // what the operator must re-enter
    expect(built.install?.ok).toBe(true);

    const draft = body.imported.find((c: any) => c.id === ID_DRAFT);
    expect(draft.phase).toBe("draft");
    expect(readModule(ID_DRAFT)).toBeNull();

    const cfg = readSidecar(ID_BUILT)!;
    expect(cfg.workflowId).toBe(wfId);           // destination tenancy, not the source's
    expect(cfg.organizationId).toBe(orgId);
    expect(cfg.phase).toBe("built");
    expect(cfg).not.toHaveProperty("credentialsRef");
    expect(readModule(ID_BUILT)).toBe(CODE + "\n");
  });

  it("round-trips: the imported connector exports the same portable payload", async () => {
    const res = await app.inject({ method: "GET", url: `/api/connectors/${ID_BUILT}/export`, headers: AUTHED });
    expect(res.statusCode).toBe(200);
    const exported = res.json().connectors[0];
    expect(exported.config.id).toBe(ID_BUILT);
    expect(exported.config.targetEntity).toBe("TestEntity");
    expect(exported.config.boundedContext).toBe("TestBC");
    expect(exported.code).toBe(CODE + "\n");
    // Credential VALUES were not transferred: no cred file exists here yet.
    expect(exported.credentialKeys).toEqual([]);
  });

  it("re-importing the same backup skips instead of duplicating", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/connectors/import", headers: AUTHED,
      payload: envelope([entry(ID_BUILT, "TestEntity", { code: CODE }), entry(ID_DRAFT, "OtherEntity")]),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.imported).toEqual([]);
    expect(body.skipped.map((s: any) => s.reason)).toEqual(["CONNECTOR_EXISTS", "CONNECTOR_EXISTS"]);
  });

  it("skips an entry whose target table is already fed by another connector (I1)", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/connectors/import", headers: AUTHED,
      payload: envelope([entry(ID_DUP_TARGET, "TestEntity")]),
    });
    const body = res.json();
    expect(body.imported).toEqual([]);
    expect(body.skipped[0].reason).toBe("TABLE_OCCUPIED");
    expect(body.skipped[0].message).toContain(ID_BUILT);
  });

  it("renames on a foreign/global id collision instead of skipping or overwriting", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/connectors/import", headers: AUTHED,
      payload: envelope([entry(ID_TAKEN, "ThirdEntity", { code: CODE })]),
    });
    const body = res.json();
    expect(body.skipped).toEqual([]);
    expect(body.imported[0].id).toBe(`${ID_TAKEN}-2`);
    expect(body.imported[0].originalId).toBe(ID_TAKEN);
    // The squatter is untouched; the renamed import belongs to THIS workflow.
    expect(readSidecar(ID_TAKEN)!.workflowId).not.toBe(wfId);
    expect(readSidecar(`${ID_TAKEN}-2`)!.workflowId).toBe(wfId);
  });

  it("imports a connector whose target table is missing as ORPHANED", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/connectors/import", headers: AUTHED,
      payload: envelope([entry(ID_ORPHAN, "MissingEntity")]),
    });
    const body = res.json();
    expect(body.skipped).toEqual([]);
    expect(body.imported[0].status).toBe("orphaned");
    expect(readSidecar(ID_ORPHAN)!.targetEntity).toBe("MissingEntity");
  });

  it("re-slugs a hostile id — an id is a sidecar filename", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/connectors/import", headers: AUTHED,
      payload: envelope([entry(HOSTILE_RAW, "GhostEntity")]),
    });
    const body = res.json();
    expect(body.imported[0].id).toBe(HOSTILE_SLUG);
    expect(readSidecar(HOSTILE_SLUG)).toBeTruthy();
  });

  it("skips non-connector entries", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/connectors/import", headers: AUTHED,
      payload: envelope([entry(`imp-sim-${SFX}`, "ThirdEntity", { kind: "simulated" })]),
    });
    expect(res.json().skipped[0].reason).toBe("NOT_A_CONNECTOR");
  });

  it("caps id LENGTH — an id is a filename, and must not 500 the import", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/connectors/import", headers: AUTHED,
      payload: envelope([entry(LONG_RAW, "LongEntity")]),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.skipped).toEqual([]);
    expect(body.imported[0].id).toBe(LONG_SLUG);
    expect(body.imported[0].id.length).toBeLessThanOrEqual(80);
    expect(readSidecar(LONG_SLUG)).toBeTruthy();
  });

  it("sanitizes envelope value types — bogus mode/instructions/limits cannot poison the sidecar", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/connectors/import", headers: AUTHED,
      payload: envelope([{
        config: {
          id: ID_TYPES, kind: "connector", boundedContext: "TestBC", targetEntity: "TypesEntity",
          targetKind: "spaceship", phase: "built",
          mode: "evil",                    // not a ProvMode — must fall back to "live"
          instructions: 42,                // non-string — buildConnector calls .trim() on this
          limits: { pageSize: "9" },       // non-numeric — dropped
          dateRoles: { created: 7, updated: "updatedAt" },
        },
        code: null, credentialKeys: [],
      }]),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().skipped).toEqual([]);
    const cfg = readSidecar(ID_TYPES)!;
    expect(cfg.mode).toBe("live");
    expect(cfg).not.toHaveProperty("instructions");
    expect(cfg).not.toHaveProperty("limits");
    expect(cfg.targetKind).toBe("entity");
    expect(cfg.dateRoles).toEqual({ updated: "updatedAt" });
  });

  it("caps the entry count per upload", async () => {
    const many = Array.from({ length: 201 }, (_, i) => entry(`imp-many-${SFX}-${i}`, `T${i}`));
    const res = await app.inject({ method: "POST", url: "/api/connectors/import", headers: AUTHED, payload: envelope(many) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("BAD_ENVELOPE");
    expect(res.json().message).toContain("at most 200");
  });

  it("400s on a wrong format or unsupported version", async () => {
    const wrongFormat = await app.inject({ method: "POST", url: "/api/connectors/import", headers: AUTHED, payload: { format: "nope", version: 1, connectors: [] } });
    expect(wrongFormat.statusCode).toBe(400);
    expect(wrongFormat.json().error).toBe("BAD_ENVELOPE");
    const wrongVersion = await app.inject({ method: "POST", url: "/api/connectors/import", headers: AUTHED, payload: { format: "qlerify-connector-export", version: 99, connectors: [] } });
    expect(wrongVersion.statusCode).toBe(400);
  });

  it("401s unauthenticated and 403s an editor — import is the RCE surface", async () => {
    const anon = await app.inject({ method: "POST", url: "/api/connectors/import", payload: envelope([]) });
    expect(anon.statusCode).toBe(401);
    const editor = await app.inject({
      method: "POST", url: "/api/connectors/import",
      headers: { authorization: `Bearer ${EDITOR_SUBJECT}`, "x-org-id": orgId, "x-workflow-id": wfId },
      payload: envelope([]),
    });
    expect(editor.statusCode).toBe(403);
  });
});
