// Organisation portfolio dashboard — the cross-workflow aggregation that powers
// the #org control tower. Model-INDEPENDENT: builds its own org + two workflows
// (each with its own small 3-step model) + EventLog instances at varied progress,
// then asserts the rollups, exception feed, bottlenecks, and the capability-gating
// + attribute-mapping flow (the locked → partial → ready lifecycle).
//
// computePortfolio() reads instances from the append-only EventLog (not the gen_
// projection tables) and takes organizationId explicitly, so no ALS/tenant context
// is needed here — exactly the property that makes the org rollup safe to run
// without disturbing the live single-workflow data plane.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { newId } from "../../src/platform/ids.js";
import { ensureOntologyResource, createVersion } from "../../src/platform/ontology-store/ontology-store.js";
import { setMeta } from "../../src/twin/projection-store.js";
import {
  computePortfolio,
  mappingConfig,
  setWorkflowMapping,
  getOrgMappings,
} from "../../src/twin/org-dashboard.js";

const SFX = `od${Date.now().toString(36)}`;
const caId = newId();
const orgId = newId();
const wsId = newId();
const wf1 = newId(); // "Hardware"
const wf2 = newId(); // "Maintenance"
const aliceSub = `od-alice-${SFX}`;
let aliceId: string;

const DAY = 86_400_000;
const now = new Date();
const past = new Date(now.getTime() - 10 * DAY).toISOString().slice(0, 10);
const future = new Date(now.getTime() + 10 * DAY).toISOString().slice(0, 10);
const fiveDaysAgo = new Date(now.getTime() - 5 * DAY);

// A minimal but valid 3-step linear model: Created → Planned → Delivered.
const MODEL = JSON.stringify({
  boundedContext: "Sales",
  roles: ["Planner", "Buyer"],
  domainEvents: {
    DemandCreated: { event: "Demand Created", role: "Planner", command: { $ref: "#/commands/CreateDemand" }, aggregateRoot: { $ref: "#/entities/Demand" } },
    DemandPlanned: { event: "Demand Planned", role: "Planner", follows: [{ $ref: "#/domainEvents/DemandCreated" }], command: { $ref: "#/commands/PlanDemand" }, aggregateRoot: { $ref: "#/entities/Demand" } },
    DemandDelivered: { event: "Demand Delivered", role: "Buyer", follows: [{ $ref: "#/domainEvents/DemandPlanned" }], command: { $ref: "#/commands/DeliverDemand" }, aggregateRoot: { $ref: "#/entities/Demand" } },
  },
  schemas: {
    entities: { Demand: { fields: [{ name: "id" }, { name: "dueDate", dataType: "date" }, { name: "customer" }] } },
    commands: {
      CreateDemand: { fields: [{ name: "dueDate", dataType: "date" }, { name: "customer" }] },
      PlanDemand: { fields: [{ name: "id" }] },
      DeliverDemand: { fields: [{ name: "id" }] },
    },
  },
});

const REF = (k: string) => `#/domainEvents/${k}`;
const ROLE: Record<string, string> = { DemandCreated: "Planner", DemandPlanned: "Planner", DemandDelivered: "Buyer" };

async function ev(
  workflowId: string,
  demandId: string,
  key: string,
  opts: { provenance?: string | null; payload?: Record<string, unknown>; occurredAt?: Date; soft?: boolean } = {},
) {
  await prisma.eventLog.create({
    data: {
      id: newId(),
      eventName: key,
      eventRef: REF(key),
      boundedContext: "Sales",
      aggregateRoot: "Demand",
      aggregateId: opts.soft ? "" : newId(),
      demandId,
      role: ROLE[key] ?? "Planner",
      payload: JSON.stringify(opts.payload ?? {}),
      occurredAt: opts.occurredAt ?? now,
      businessAt: now,
      provenance: opts.provenance ?? null,
      organizationId: orgId,
      workflowId,
    },
  });
}

async function seedWorkflow(workflowId: string, name: string) {
  await prisma.platWorkflow.create({ data: { id: workflowId, organizationId: orgId, workspaceId: wsId, name } });
  const { ontologyId } = await ensureOntologyResource({ organizationId: orgId, workflowId, workspaceId: wsId, name: "workflow", ownerId: aliceId });
  await createVersion(orgId, ontologyId, MODEL, null, { source: "initial" });
}

// instance ids
const i1 = newId(), i2 = newId(), i3 = newId(), i4 = newId(), i5 = newId(), i6 = newId();

beforeAll(async () => {
  await prisma.platCustomerAccount.create({ data: { id: caId, name: `CA ${SFX}` } });
  await prisma.platOrganization.create({ data: { id: orgId, customerAccountId: caId, name: `Org ${SFX}`, slug: `org-${SFX}` } });
  const env = await prisma.platEnvironment.create({ data: { id: newId(), organizationId: orgId, name: "development", region: "local" } });
  await prisma.platWorkspace.create({ data: { id: wsId, organizationId: orgId, environmentId: env.id, name: "Default" } });
  aliceId = (await prisma.platIdentity.create({ data: { id: newId(), subject: aliceSub } })).id;
  await prisma.platOrgMembership.create({ data: { id: newId(), identityId: aliceId, organizationId: orgId } });

  await seedWorkflow(wf1, "Hardware Production");
  await seedWorkflow(wf2, "Base-Station Maintenance");

  // --- WF1 (Hardware): all events from a "live" source (real provenance) ---
  // i1: active at step 3, commitment in the PAST (overdue once mapped)
  await ev(wf1, i1, "DemandCreated", { provenance: "live", payload: { dueDate: past, customer: "cust-07" } });
  await ev(wf1, i1, "DemandPlanned", { provenance: "live" });
  // i2: completed
  await ev(wf1, i2, "DemandCreated", { provenance: "live", payload: { dueDate: future } });
  await ev(wf1, i2, "DemandPlanned", { provenance: "live" });
  await ev(wf1, i2, "DemandDelivered", { provenance: "live" });
  // i3: rework loop (DemandCreated fired twice), active, commitment in the FUTURE
  await ev(wf1, i3, "DemandCreated", { provenance: "live", payload: { dueDate: future } });
  await ev(wf1, i3, "DemandCreated", { provenance: "live", payload: { dueDate: future } });
  // i4: synthesis soft-fail at step 2, active, NO commitment (unscorable)
  await ev(wf1, i4, "DemandCreated", { provenance: "live", payload: { customer: "cust-22" } });
  await ev(wf1, i4, "DemandPlanned", { provenance: "live", soft: true });

  // --- WF2 (Maintenance): simulated provenance (null) ---
  // i5: only step 1, idle 5 days (aging exception)
  await ev(wf2, i5, "DemandCreated", { occurredAt: fiveDaysAgo });
  // i6: completed
  await ev(wf2, i6, "DemandCreated");
  await ev(wf2, i6, "DemandPlanned");
  await ev(wf2, i6, "DemandDelivered");
});

afterAll(async () => {
  await setMeta(`orgdash:mappings:${orgId}`, "{}");
  await prisma.eventLog.deleteMany({ where: { organizationId: orgId } });
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

describe("org portfolio aggregation", () => {
  it("rolls up active / completed / trust / conformance across both workflows", async () => {
    const p = await computePortfolio(orgId);
    expect(p.workflows).toHaveLength(2);
    expect(p.northStar.activeInstances).toBe(4); // i1, i3, i4, i5
    expect(p.northStar.completedInstances).toBe(2); // i2, i6
    expect(p.northStar.totalInstances).toBe(6);
    // 9 of 13 events come from a real (live) source.
    expect(p.northStar.twinTrust).toMatchObject({ real: 9, total: 13, pct: 69 });
    // 12 of 13 steps are clean (one soft-fail on i4).
    expect(p.northStar.conformance).toMatchObject({ clean: 12, total: 13, pct: 92 });
    expect(p.northStar.modelledCount).toBe(2);
  });

  it("produces per-workflow cards with correct active/completed/rework/soft-fail", async () => {
    const p = await computePortfolio(orgId);
    const hw = p.workflows.find((w) => w.id === wf1)!;
    const mt = p.workflows.find((w) => w.id === wf2)!;
    expect(hw).toMatchObject({ hasModel: true, totalSteps: 3, active: 3, completed: 1, reworkCount: 1, softFailCount: 1 });
    expect(hw.twinTrust.pct).toBe(100);
    expect(mt).toMatchObject({ hasModel: true, active: 1, completed: 1 });
    expect(mt.oldestActive).toMatchObject({ ageDays: 5 }); // i5 idle 5 days
  });

  it("surfaces rework, soft-fail, and aging exceptions", async () => {
    const p = await computePortfolio(orgId);
    const kinds = p.exceptions.map((x) => x.kind).sort();
    expect(kinds).toEqual(["aging", "rework", "soft_fail"]);
    expect(p.exceptions.find((x) => x.kind === "rework")!.demandId).toBe(i3);
    expect(p.exceptions.find((x) => x.kind === "soft_fail")!.demandId).toBe(i4);
    expect(p.exceptions.find((x) => x.kind === "aging")!.demandId).toBe(i5);
  });

  it("ranks bottlenecks by the count of instances waiting at each step", async () => {
    const p = await computePortfolio(orgId);
    // i1 and i4 both sit at the final step (DemandDelivered) in WF1.
    const top = p.bottlenecks.find((b) => b.workflowId === wf1 && b.stepName === "Demand Delivered")!;
    expect(top.waiting).toBe(2);
    expect(top.boundedContext).toBe("Sales");
  });
});

describe("capability gating + attribute mapping", () => {
  it("starts LOCKED with no commitment date mapped", async () => {
    const p = await computePortfolio(orgId);
    const cap = p.capabilities.find((c) => c.key === "commitDate")!;
    expect(cap.state).toBe("locked");
    expect(cap.modelledCount).toBe(2);
    expect(cap.mappedCount).toBe(0);
    expect(p.timeliness).toBeNull();
  });

  it("the mapping dialog offers each workflow's fields and suggests the date field", async () => {
    const cfg = await mappingConfig(orgId);
    const hw = cfg.workflows.find((w) => w.id === wf1)!;
    expect(hw.hasModel).toBe(true);
    expect(hw.suggested).toBe("dueDate");
    expect(hw.fields.map((f) => f.name)).toContain("dueDate");
    expect(hw.fields.find((f) => f.name === "dueDate")!.dateish).toBe(true);
  });

  it("goes PARTIAL and computes overdue/on-time once one workflow is mapped", async () => {
    await setWorkflowMapping(orgId, wf1, "commitDate", "dueDate");
    expect(await getOrgMappings(orgId)).toMatchObject({ [wf1]: { commitDate: "dueDate" } });

    const p = await computePortfolio(orgId);
    const cap = p.capabilities.find((c) => c.key === "commitDate")!;
    expect(cap.state).toBe("partial");
    expect(cap.mappedCount).toBe(1);

    const t = p.timeliness!;
    expect(t).not.toBeNull();
    expect(t.overdue).toBe(1); // i1 (due in the past)
    expect(t.onTime).toBe(1); // i3 (due in the future)
    expect(t.unscorable).toBe(1); // i4 (no due date)
    expect(t.scorable).toBe(2);
    expect(t.rows[0]).toMatchObject({ demandId: i1 });
    expect(t.partial!.unmapped.map((w) => w.id)).toEqual([wf2]); // WF2 still unmapped
  });

  it("clearing the mapping returns to LOCKED", async () => {
    await setWorkflowMapping(orgId, wf1, "commitDate", null);
    const p = await computePortfolio(orgId);
    expect(p.capabilities.find((c) => c.key === "commitDate")!.state).toBe("locked");
    expect(p.timeliness).toBeNull();
  });
});
