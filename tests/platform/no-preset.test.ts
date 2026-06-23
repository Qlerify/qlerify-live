// No system org / no preset (2026-06-23). The single-tenant demo AND its system
// organization were removed. The boot seed (seedPlatform) creates the built-in
// roles + the superuser only — NO system org, NO system identity, NO preset
// workflow/model. A fresh install has ZERO orgs; the superuser creates the first.
// The off-request "system context" still resolves to an EMPTY ontology (no demo).
// This locks the decision so neither the system org nor a preset can come back.
// See [[canonical-flow-no-demo]].

import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { SYSTEM_ORG_ID } from "../../src/platform/ids.js";
import { createOrganization, seedPlatform } from "../../src/platform/provisioning/index.js";
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

describe("no system org, no preset (the demo and its system tenant were removed)", () => {
  it("seedPlatform() creates NO system org and NO system identity", async () => {
    await seedPlatform();
    expect(await prisma.platOrganization.findUnique({ where: { id: SYSTEM_ORG_ID } })).toBeNull();
    expect(await prisma.platIdentity.findUnique({ where: { subject: "system" } })).toBeNull();
  });

  it("the off-request system context resolves to an EMPTY ontology — no preloaded demo", () => {
    // No ALS store → off-request system context → empty model (no workflow.json on disk).
    const o = getOntology();
    expect(o.events.length).toBe(0);
    expect(o.roles.length).toBe(0);
    expect(emptyOntology().events.length).toBe(0);
  });

  it("createOrganization() provisions ZERO workflows — a fresh org is empty", async () => {
    const org = await createOrganization({ name: `No-Preset ${Date.now().toString(36)}` });
    created.push({ orgId: org.id, customerAccountId: org.customerAccountId });
    expect(await prisma.platWorkflow.count({ where: { organizationId: org.id } })).toBe(0);
    // …but it DOES get a default workspace to host the user's first workflow.
    expect(await prisma.platWorkspace.count({ where: { organizationId: org.id } })).toBeGreaterThan(0);
  });
});
