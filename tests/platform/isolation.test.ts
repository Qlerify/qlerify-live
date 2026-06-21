// Multi-tenant isolation acceptance tests (spec §20 checklist, the items that
// CAN be enforced on SQLite). Model-INDEPENDENT: they build their own org /
// identity / resource fixtures, so they pass regardless of which workflow.json
// is loaded. These are the executable form of the increment-1 invariants:
//
//   #1 org_id is derived from identity; client-supplied org is ignored
//   #2 cross-org access denied (read = empty, PDP = DENY by boundary)
//   #5 MAC gate runs before DAC (a missing marking denies even the owner)
//   #9 the audit log is hash-chained and tamper-evident
//   + deny-by-default: no tenant context throws (RLS's deny analogue)
//   + the gen_ data plane scopes rows by organization

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import * as store from "../../src/twin/projection-store.js";
import type { EntitySchema } from "../../src/ontology/model.js";
import { resolveTenantContext } from "../../src/platform/authn/index.js";
import { recordAudit, verifyAuditChain } from "../../src/platform/audit/index.js";
import { newId } from "../../src/platform/ids.js";
import { authorize, resourceRef } from "../../src/platform/pdp/index.js";
import { assignRole } from "../../src/platform/provisioning/index.js";
import { createVersion, ensureOntologyResource, getOntologyById } from "../../src/platform/ontology-store/ontology-store.js";
import { requireTenant, runWithTenant, TenantContextMissingError } from "../../src/platform/tenancy/context.js";
import { orgId } from "../../src/platform/tenancy/scoped-store.js";
import type { TenantContext } from "../../src/platform/types.js";

const SFX = `it${Date.now().toString(36)}`;
const caId = newId();
const orgAId = newId();
const orgBId = newId();
const aliceSub = `alice-${SFX}`;
const bobSub = `bob-${SFX}`;

let aliceId: string;
let bobId: string;
let ontA: { resourceId: string; ontologyId: string };
let ctxAlice: TenantContext;
let ctxBob: TenantContext;
const genEntity: EntitySchema = { name: `GenT${SFX}`, required: [], fields: [{ name: "id" }, { name: "label" }] };

beforeAll(async () => {
  await prisma.platCustomerAccount.create({ data: { id: caId, name: `CA ${SFX}` } });
  await prisma.platOrganization.create({ data: { id: orgAId, customerAccountId: caId, name: `OrgA ${SFX}`, slug: `orga-${SFX}` } });
  await prisma.platOrganization.create({ data: { id: orgBId, customerAccountId: caId, name: `OrgB ${SFX}`, slug: `orgb-${SFX}` } });

  aliceId = (await prisma.platIdentity.create({ data: { id: newId(), subject: aliceSub } })).id;
  bobId = (await prisma.platIdentity.create({ data: { id: newId(), subject: bobSub } })).id;
  await prisma.platOrgMembership.create({ data: { id: newId(), identityId: aliceId, organizationId: orgAId } });
  await prisma.platOrgMembership.create({ data: { id: newId(), identityId: bobId, organizationId: orgBId } });

  // Alice owns org A (DAC would allow); bob owns nothing in A.
  await assignRole({ organizationId: orgAId, principalId: aliceId, principalType: "identity", roleKey: "owner", scopeType: "organization", scopeId: orgAId });

  ontA = await ensureOntologyResource({ organizationId: orgAId, name: "workflow", ownerId: aliceId });
  await createVersion(orgAId, ontA.ontologyId, JSON.stringify({ boundedContext: "X", domainEvents: {}, roles: [] }), null, { source: "initial" });

  ctxAlice = { organizationId: orgAId, principal: { id: aliceId, type: "identity" }, identityId: aliceId, subject: aliceSub };
  ctxBob = { organizationId: orgBId, principal: { id: bobId, type: "identity" }, identityId: bobId, subject: bobSub };
});

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "gen_${genEntity.name}"`).catch(() => {});
  await prisma.platMarkingGrant.deleteMany({ where: { organizationId: orgAId } });
  await prisma.platResourceMarking.deleteMany({ where: { organizationId: orgAId } });
  await prisma.platMarking.deleteMany({ where: { organizationId: orgAId } });
  await prisma.platRoleAssignment.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.platAuditEvent.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.platOntologyBranch.deleteMany({ where: { organizationId: orgAId } });
  await prisma.platOntologyVersion.deleteMany({ where: { organizationId: orgAId } });
  await prisma.platOntology.deleteMany({ where: { organizationId: orgAId } });
  await prisma.platResource.deleteMany({ where: { organizationId: orgAId } });
  await prisma.platOrgMembership.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } });
  await prisma.platIdentity.deleteMany({ where: { id: { in: [aliceId, bobId] } } });
  await prisma.platOrganization.deleteMany({ where: { id: { in: [orgAId, orgBId] } } });
  await prisma.platCustomerAccount.deleteMany({ where: { id: caId } });
});

describe("multi-tenant isolation", () => {
  it("#1 derives org_id from membership and ignores client-supplied org", async () => {
    const ctx = await resolveTenantContext({ authorization: `Bearer ${aliceSub}` });
    expect(ctx.organizationId).toBe(orgAId);
    expect(ctx.principal).toEqual({ id: aliceId, type: "identity" });

    // Alice claiming org B (she is not a member) is denied — the canonical org
    // is never taken from the client-supplied selector.
    await expect(resolveTenantContext({ authorization: `Bearer ${aliceSub}`, "x-org-id": orgBId })).rejects.toThrow();
    // A bogus selector is denied too.
    await expect(resolveTenantContext({ "x-identity-subject": aliceSub, "x-org-id": "no-such-org" })).rejects.toThrow();
  });

  it("#2 cross-org ontology read is empty; in-org read is found", async () => {
    expect(await getOntologyById(orgBId, ontA.ontologyId)).toBeNull(); // bob can't see A's model
    expect(await getOntologyById(orgAId, ontA.ontologyId)).not.toBeNull(); // alice can
  });

  it("#2 PDP denies cross-org by boundary; allows the in-org owner", async () => {
    const res = resourceRef({ id: ontA.resourceId, organizationId: orgAId });
    expect((await authorize("ontology.read", res, ctxBob)).allow).toBe(false);
    expect((await authorize("ontology.read", res, ctxAlice)).allow).toBe(true);
    expect((await authorize("ontology.write", res, ctxAlice)).allow).toBe(true); // owner ⇒ edit
  });

  it("deny-by-default: no tenant context throws; bound context resolves", () => {
    expect(() => requireTenant()).toThrow(TenantContextMissingError);
    expect(() => orgId()).toThrow();
    expect(runWithTenant(ctxAlice, () => orgId())).toBe(orgAId);
  });

  it("#5 MAC gate denies before DAC — a missing marking blocks even the owner", async () => {
    const res = resourceRef({ id: ontA.resourceId, organizationId: orgAId });
    expect((await authorize("ontology.read", res, ctxAlice)).allow).toBe(true); // baseline

    const markingId = newId();
    await prisma.platMarking.create({ data: { id: markingId, organizationId: orgAId, name: `PII-${SFX}` } });
    await prisma.platResourceMarking.create({ data: { id: newId(), organizationId: orgAId, resourceId: ontA.resourceId, markingId, source: "direct" } });

    const blocked = await authorize("ontology.read", res, ctxAlice);
    expect(blocked.allow).toBe(false);
    expect(blocked.reason).toMatch(/MAC/);

    await prisma.platMarkingGrant.create({ data: { id: newId(), organizationId: orgAId, markingId, principalId: aliceId, principalType: "identity" } });
    expect((await authorize("ontology.read", res, ctxAlice)).allow).toBe(true); // held ⇒ allowed
  });

  it("#9 audit chain verifies and detects tampering", async () => {
    await recordAudit({ organizationId: orgAId, action: "test.one", decision: "allow" });
    await recordAudit({ organizationId: orgAId, action: "test.two", decision: "allow" });
    const ok = await verifyAuditChain(orgAId);
    expect(ok.ok).toBe(true);
    expect(ok.length).toBeGreaterThanOrEqual(2);

    const last = await prisma.platAuditEvent.findFirst({ where: { organizationId: orgAId }, orderBy: { seq: "desc" } });
    await prisma.platAuditEvent.update({ where: { id: last!.id }, data: { reason: "tampered" } });
    expect((await verifyAuditChain(orgAId)).ok).toBe(false);
  });

  it("gen_ data plane scopes rows by organization", async () => {
    await store.ensureTable(genEntity);
    const rowId = newId();
    await runWithTenant(ctxAlice, () => store.insert(genEntity.name, { id: rowId, label: "secret-A" }));

    expect(await runWithTenant(ctxBob, () => store.findById(genEntity.name, rowId))).toBeNull();
    const manyB = await runWithTenant(ctxBob, () => store.findMany(genEntity.name));
    expect(manyB.find((r) => r.id === rowId)).toBeUndefined();
    expect(await runWithTenant(ctxAlice, () => store.findById(genEntity.name, rowId))).not.toBeNull();
  });
});
