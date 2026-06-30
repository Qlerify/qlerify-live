import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runTool } from "../../src/chat/tools.js";
import { registerAdapter } from "../../src/packs/registry.js";
import { createSimulatedAdapter } from "../../src/packs/adapters/simulated.js";
import { modelHarness } from "../helpers/po-model.js";
import { runWithTenant } from "../../src/platform/tenancy/context.js";
import { newId } from "../../src/platform/ids.js";
import { prisma } from "../../src/db.js";
import type { TenantContext } from "../../src/platform/types.js";

const ID = "doctor-test-sap";

// adapter_dry_run synthesizes a sample by reading the model via getOntology(), so
// that one tool call runs inside a workflow tenant context with the model bound.
const model = modelHarness();

// Chat WRITE tools are now PDP-gated (guardData). To exercise the *confirmation*
// (UX) behaviour of a write tool, the call must run inside an AUTHORIZED context —
// the PDP runs first. A platform-admin break-glass context is the lightest such
// context (grants edit without provisioning an org + role assignment).
const adminOrg = newId();
const adminCtx: TenantContext = {
  organizationId: adminOrg,
  principal: { id: newId(), type: "identity" },
  workflowId: newId(),
  actingAsPlatformAdmin: true,
};
const asAdmin = <T>(fn: () => Promise<T> | T): Promise<T> => runWithTenant(adminCtx, async () => fn());

beforeAll(() => {
  registerAdapter(createSimulatedAdapter({ id: ID, boundedContext: "SAP", targetEntity: "PurchaseOrder", seed: 5 }));
});

afterAll(async () => {
  // Break-glass authorizations leave audit rows — clean up this test's org.
  await prisma.platAuditEvent.deleteMany({ where: { organizationId: adminOrg } });
});

function parse(r: { content: string }): any {
  return JSON.parse(r.content);
}

describe("Connection Doctor tools", () => {
  it("list_adapters includes the registered adapter", async () => {
    const r = await runTool("list_adapters", {});
    expect(r.isError).toBe(false);
    expect(parse(r).adapters.some((a: any) => a.id === ID)).toBe(true);
  });

  it("get_adapter_config returns config WITHOUT a secret", async () => {
    const c = parse(await runTool("get_adapter_config", { adapterId: ID }));
    expect(c.targetEntity).toBe("PurchaseOrder");
    expect(c.boundedContext).toBe("SAP");
    expect(c).not.toHaveProperty("secret");
  });

  it("check_adapter_credential reports presence as a boolean only", async () => {
    const c = parse(await runTool("check_adapter_credential", { adapterId: ID }));
    expect(c.present).toBe(false); // no credentialsRef configured
    expect(c).not.toHaveProperty("value");
  });

  it("run_adapter_healthcheck on a simulated adapter is ok", async () => {
    expect(parse(await runTool("run_adapter_healthcheck", { adapterId: ID })).ok).toBe(true);
  });

  it("adapter_dry_run returns a sample without writing", () =>
    model.run(async () => {
      const d = parse(await runTool("adapter_dry_run", { adapterId: ID, limit: 2 }));
      expect(d.ok).toBe(true);
      expect(d.count).toBe(2);
      expect(d.missingRequired).toEqual([]);
    }));

  it("regenerate_adapter_body refuses without confirmation", async () => {
    const r = await asAdmin(() => runTool("regenerate_adapter_body", { adapterId: ID, confirmed: false }));
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/confirmed=false/);
  });

  it("regenerate_adapter_body (confirmed) reports the missing API key", async () => {
    if (process.env.ANTHROPIC_API_KEY) return; // a key would actually generate — skip
    const r = await asAdmin(() => runTool("regenerate_adapter_body", { adapterId: ID, confirmed: true }));
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/ANTHROPIC_API_KEY/);
  });

  it("a write tool is refused for an unauthorized caller (PDP denies before confirmation)", async () => {
    // No tenant context → guardData fails closed: the PDP, not the confirmed flag,
    // is the security boundary, so a prompt-injected confirmed:true cannot escalate.
    const r = await runTool("regenerate_adapter_body", { adapterId: ID, confirmed: true });
    expect(r.isError).toBe(true);
  });

  it("unknown adapter id is handled gracefully", async () => {
    expect(parse(await runTool("get_adapter_config", { adapterId: "nope" })).error).toMatch(/no adapter/);
  });
});
