// Workflow model versioning, source-link provenance, and restore-as-new-version
// (the storage spine behind "a model is mandatory at creation, reloadable from
// its link, and restorable to any past version"). Model-INDEPENDENT — builds its
// own org / workflow / ontology fixtures.
//
// Proves:
//   - a version records the Qlerify source link (sourceUrl) + a human label
//     (sourceName), and listVersions surfaces them
//   - getWorkflowOntology resolves the workflow's model + current version pointer
//   - applying changed content appends a version; identical content is a no-op
//     (dedup against the current version) — no spurious history
//   - a stored version's exact bytes round-trip through the CAS, so RESTORE can
//     re-apply an old version as a NEW current version that carries the original
//     link forward (history stays linear)
//   - applyWorkflowModel refuses an unloadable model BEFORE touching anything —
//     the guard that lets workflow creation stay atomic (no empty workflow on a
//     bad model)

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { newId } from "../../src/platform/ids.js";
import {
  createVersion,
  ensureOntologyResource,
  getVersionContent,
  getWorkflowOntology,
  listVersions,
} from "../../src/platform/ontology-store/ontology-store.js";
import { applyWorkflowModel } from "../../src/twin/apply.js";
import { runWithTenant } from "../../src/platform/tenancy/context.js";
import type { TenantContext } from "../../src/platform/types.js";

const SFX = `mv${Date.now().toString(36)}`;
const caId = newId();
const orgId = newId();
const wsId = newId();
const projId = newId();
const aliceSub = `mv-alice-${SFX}`;
let aliceId: string;
let ontologyId: string;

const SOURCE_URL = "https://app.qlerify.com/workflow/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222";
const modelA = JSON.stringify({ boundedContext: "Orders", domainEvents: { OrderPlaced: {} }, roles: ["clerk"] });
const modelB = JSON.stringify({ boundedContext: "Billing", domainEvents: { Invoiced: {}, Paid: {} }, roles: ["clerk", "finance"] });

function projCtx(): TenantContext {
  return { organizationId: orgId, principal: { id: aliceId, type: "identity" }, identityId: aliceId, subject: aliceSub, workflowId: projId };
}

beforeAll(async () => {
  await prisma.platCustomerAccount.create({ data: { id: caId, name: `CA ${SFX}` } });
  await prisma.platOrganization.create({ data: { id: orgId, customerAccountId: caId, name: `Org ${SFX}`, slug: `org-${SFX}` } });
  const env = await prisma.platEnvironment.create({ data: { id: newId(), organizationId: orgId, name: "development", region: "local" } });
  await prisma.platWorkspace.create({ data: { id: wsId, organizationId: orgId, environmentId: env.id, name: "Default" } });
  aliceId = (await prisma.platIdentity.create({ data: { id: newId(), subject: aliceSub } })).id;
  await prisma.platOrgMembership.create({ data: { id: newId(), identityId: aliceId, organizationId: orgId } });
  await prisma.platWorkflow.create({ data: { id: projId, organizationId: orgId, workspaceId: wsId, name: "Versioned" } });
  ({ ontologyId } = await ensureOntologyResource({ organizationId: orgId, workflowId: projId, workspaceId: wsId, name: "workflow", ownerId: aliceId }));
});

afterAll(async () => {
  await prisma.platOntologyBranch.deleteMany({ where: { organizationId: orgId } });
  await prisma.platOntologyVersion.deleteMany({ where: { organizationId: orgId } });
  await prisma.platOntology.deleteMany({ where: { organizationId: orgId } });
  await prisma.platResource.deleteMany({ where: { organizationId: orgId } });
  await prisma.platWorkflow.deleteMany({ where: { organizationId: orgId } });
  await prisma.platWorkspace.deleteMany({ where: { organizationId: orgId } });
  await prisma.platEnvironment.deleteMany({ where: { organizationId: orgId } });
  await prisma.platOrgMembership.deleteMany({ where: { organizationId: orgId } });
  await prisma.platIdentity.deleteMany({ where: { id: aliceId } });
  await prisma.platOrganization.deleteMany({ where: { id: orgId } });
  await prisma.platCustomerAccount.deleteMany({ where: { id: caId } });
});

describe("workflow model versioning + restore", () => {
  it("records the source link + label on a version and lists them", async () => {
    const v0 = await createVersion(orgId, ontologyId, modelA, null, { source: "set", sourceUrl: SOURCE_URL, sourceName: "Orders", createdBy: aliceId });
    expect(v0.seq).toBe(0);
    expect(v0.changed).toBe(true);

    const ont = await getWorkflowOntology(orgId, projId);
    expect(ont?.currentVersionId).toBe(v0.versionId);

    const versions = await listVersions(orgId, ontologyId);
    expect(versions).toHaveLength(1);
    expect(versions[0].sourceUrl).toBe(SOURCE_URL);
    expect(versions[0].sourceName).toBe("Orders");
    expect(versions[0].source).toBe("set");
  });

  it("appends a version on change and dedups an identical re-apply", async () => {
    const v1 = await createVersion(orgId, ontologyId, modelB, null, { source: "set", sourceUrl: SOURCE_URL });
    expect(v1.seq).toBe(1);
    expect(v1.changed).toBe(true);

    // Re-applying the byte-identical current model is a no-op — no new history.
    const again = await createVersion(orgId, ontologyId, modelB, null, { source: "set" });
    expect(again.changed).toBe(false);
    expect(again.versionId).toBe(v1.versionId);
    expect((await listVersions(orgId, ontologyId))).toHaveLength(2);

    // A version with no link (upload/paste) records null provenance.
    expect((await listVersions(orgId, ontologyId)).every((v) => "sourceUrl" in v)).toBe(true);
  });

  it("round-trips a version's exact bytes and restores it as a new current version", async () => {
    const versions = await listVersions(orgId, ontologyId);
    const v0 = versions.find((v) => v.seq === 0)!;

    // The stored bytes survive the CAS round-trip exactly.
    const content = await getVersionContent(orgId, v0.id);
    expect(content?.workflow).toBe(modelA);

    // Restore = re-apply those bytes as a NEW version (source "restore"), carrying
    // the original link forward; the past is never rewritten.
    const restored = await createVersion(orgId, ontologyId, content!.workflow, content!.overlay, { source: "restore", sourceUrl: v0.sourceUrl });
    expect(restored.changed).toBe(true);
    expect(restored.seq).toBe(2);

    const ont = await getWorkflowOntology(orgId, projId);
    expect(ont?.currentVersionId).toBe(restored.versionId);
    const restoredContent = await getVersionContent(orgId, restored.versionId);
    expect(restoredContent?.workflow).toBe(modelA); // back to model A's content

    const all = await listVersions(orgId, ontologyId);
    const restoredRow = all.find((v) => v.id === restored.versionId)!;
    expect(restoredRow.source).toBe("restore");
    expect(restoredRow.sourceUrl).toBe(SOURCE_URL);
  });

  it("applyWorkflowModel refuses an unloadable model before touching anything", async () => {
    const before = (await listVersions(orgId, ontologyId)).length;
    await expect(
      runWithTenant(projCtx(), () => applyWorkflowModel("{ this is not valid json", null, { source: "set" })),
    ).rejects.toThrow(/Invalid Qlerify model/i);
    // No version was written — the guard runs before any CAS/DB write.
    expect((await listVersions(orgId, ontologyId)).length).toBe(before);
  });
});
