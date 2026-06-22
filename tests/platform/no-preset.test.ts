// No-preset contract (2026-06-22): the preset "Operations Day" demo was removed.
// A freshly provisioned org — and the seeded SYSTEM org — start with ZERO
// projects and NO model. The system context resolves to an EMPTY ontology
// (graceful-empty), never a preloaded demo. This locks the decision so the
// preset can't quietly come back. See [[remove-preset-project]].

import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { SYSTEM_ORG_ID, SYSTEM_PROJECT_ID } from "../../src/platform/ids.js";
import { createOrganization, seedSystemOrg } from "../../src/platform/provisioning/index.js";
import { getOntology, emptyOntology } from "../../src/ontology/model.js";

const created: { orgId: string; customerAccountId: string }[] = [];

afterAll(async () => {
  for (const c of created) {
    await prisma.platAuditEvent.deleteMany({ where: { organizationId: c.orgId } });
    await prisma.platTenantRegistry.deleteMany({ where: { organizationId: c.orgId } });
    await prisma.platWorkspace.deleteMany({ where: { organizationId: c.orgId } });
    await prisma.platEnvironment.deleteMany({ where: { organizationId: c.orgId } });
    await prisma.platOrganization.deleteMany({ where: { id: c.orgId } });
    await prisma.platCustomerAccount.deleteMany({ where: { id: c.customerAccountId } });
  }
});

describe("no preset project/model (the demo was removed)", () => {
  it("seedSystemOrg() seeds NO system project and NO system model", async () => {
    await seedSystemOrg();
    // The old byte-identical demo project must not exist as a row.
    expect(await prisma.platProject.findUnique({ where: { id: SYSTEM_PROJECT_ID } })).toBeNull();
    // No model was folded into an org-level (projectId=null) system ontology.
    expect(await prisma.platOntology.count({ where: { organizationId: SYSTEM_ORG_ID, projectId: null } })).toBe(0);
  });

  it("the system context resolves to an EMPTY ontology — no preloaded demo", () => {
    // No ALS store → system context → empty model (no workflow.json on disk).
    const o = getOntology();
    expect(o.events.length).toBe(0);
    expect(o.roles.length).toBe(0);
    expect(emptyOntology().events.length).toBe(0);
  });

  it("createOrganization() provisions ZERO projects — a fresh org is empty", async () => {
    const org = await createOrganization({ name: `No-Preset ${Date.now().toString(36)}` });
    created.push({ orgId: org.id, customerAccountId: org.customerAccountId });
    expect(await prisma.platProject.count({ where: { organizationId: org.id } })).toBe(0);
    // …but it DOES get a default workspace to host the user's first project.
    expect(await prisma.platWorkspace.count({ where: { organizationId: org.id } })).toBeGreaterThan(0);
  });
});
