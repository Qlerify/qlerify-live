// Every "just have a look" affordance runs the connector's fetchRows, and on an
// actuator that IS the action. A real HubSpot connector was dry-run with the UI
// promising no writes and created three live contacts — so each of those paths
// now refuses unless the caller confirms the actions on purpose.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runTool, TOOLS } from "../../src/chat/tools.js";
import { assertActionsConfirmed, performsActions } from "../../src/packs/behavior.js";
import { discoverSourceFields } from "../../src/packs/connector/orchestrate.js";
import { registerAdapter, unregisterAdapter } from "../../src/packs/registry.js";
import { writeSidecar, deleteSidecar } from "../../src/packs/sidecar.js";
import { deleteConnectorFiles } from "../../src/packs/connector/runtime.js";
import { runWithTenant } from "../../src/platform/tenancy/context.js";
import { prisma } from "../../src/db.js";
import { DomainError } from "../../src/errors.js";
import { modelHarness } from "../helpers/po-model.js";
import type { AdapterBehavior } from "../../src/packs/types.js";

const SFX = `gate${Date.now().toString(36)}`;
const model = modelHarness();
const orgId = model.orgId;
const wfId = model.workflowId;

const asAdmin = <T>(fn: () => Promise<T> | T): Promise<T> => model.run(async () => fn());

/** Same workflow (so the model stays bound) but able to clear the capability
 * check, for the tools that are write-gated before the action gate runs. */
const asBuilder = <T>(fn: () => Promise<T> | T): Promise<T> =>
  runWithTenant({ ...model.ctx, actingAsPlatformAdmin: true }, async () => fn());
const parse = (r: { content: string }) => JSON.parse(r.content);

const ids: string[] = [];

/** Its pull appends to `calls` — the stand-in for the record it would create in
 * the other system. An empty `calls` is the proof nothing was performed. */
const spyAdapter = (id: string, behavior: AdapterBehavior, calls: string[]) => {
  writeSidecar({
    id,
    kind: "connector",
    behavior,
    boundedContext: "Hubspot",
    targetEntity: "PurchaseOrder",
    phase: "built",
    mode: "live",
    workflowId: wfId,
    organizationId: orgId,
  });
  ids.push(id);
  registerAdapter({
    id,
    kind: "connector",
    boundedContext: "Hubspot",
    targetEntity: "PurchaseOrder",
    mode: "live" as const,
    async introspect() { return { entity: "PurchaseOrder", fields: [] }; },
    async mapping() { return {}; },
    async pull() {
      calls.push(id);
      return { rows: { PurchaseOrder: [{ id: "po-1", status: "DRAFT" }] }, count: 1 };
    },
    async push() { return { pushed: 0 }; },
    async healthcheck() { return { ok: true }; },
  } as any);
};

const cfg = (behavior?: AdapterBehavior) => ({ id: "hubspot-contact", boundedContext: "Hubspot", behavior });

beforeAll(() => {
  spyAdapter(`act-${SFX}`, "actuator", []);
});

afterAll(async () => {
  for (const id of ids.splice(0)) {
    unregisterAdapter(id);
    deleteSidecar(id);
    deleteConnectorFiles(id);
  }
  await prisma.platAuditEvent.deleteMany({ where: { organizationId: orgId } });
});

describe("the action gate", () => {
  it("stops an actuator and names the system it would write to", () => {
    expect(() => assertActionsConfirmed(cfg("actuator"), "a dry run", undefined)).toThrow(DomainError);
    expect(() => assertActionsConfirmed(cfg("actuator"), "a dry run", undefined)).toThrow(/Hubspot/);
    expect(() => assertActionsConfirmed(cfg("actuator"), "a dry run", undefined)).toThrow(/no read-only pull/);
  });

  it("lets a confirmed caller through", () => {
    expect(() => assertActionsConfirmed(cfg("actuator"), "a dry run", true)).not.toThrow();
  });

  it("never gets in the way of a connector that only reads", () => {
    for (const behavior of ["sync", "generator", "extractor", undefined] as const) {
      expect(() => assertActionsConfirmed(cfg(behavior), "a dry run", undefined)).not.toThrow();
      expect(performsActions(cfg(behavior))).toBe(false);
    }
    expect(performsActions(cfg("actuator"))).toBe(true);
  });
});

describe("adapter_dry_run", () => {
  it("refuses on an actuator WITHOUT running its code", async () => {
    const calls: string[] = [];
    const id = `dry-act-${SFX}`;
    spyAdapter(id, "actuator", calls);
    const r = parse(await asAdmin(() => runTool("adapter_dry_run", { adapterId: id, limit: 3 })));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/performs actions/i);
    expect(calls).toEqual([]); // the whole point: nothing was created over there
  });

  it("runs it when the caller confirms the actions", async () => {
    const calls: string[] = [];
    const id = `dry-act-ok-${SFX}`;
    spyAdapter(id, "actuator", calls);
    const r = parse(await asAdmin(() => runTool("adapter_dry_run", { adapterId: id, limit: 3, confirmActions: true })));
    expect(r.ok).toBe(true);
    expect(calls).toEqual([id]);
  });

  it("still dry-runs a read-only connector with no ceremony", async () => {
    const calls: string[] = [];
    const id = `dry-sync-${SFX}`;
    spyAdapter(id, "sync", calls);
    const r = parse(await asAdmin(() => runTool("adapter_dry_run", { adapterId: id, limit: 3 })));
    expect(r.ok).toBe(true);
    expect(calls).toEqual([id]);
  });

  it("offers confirmActions to the model and stops promising no writes", () => {
    const tool = TOOLS.find((t) => t.name === "adapter_dry_run")!;
    expect(Object.keys(tool.input_schema.properties ?? {})).toContain("confirmActions");
    expect(tool.description).not.toMatch(/WITHOUT writing/);
    expect(tool.description).toMatch(/actuator/);
  });
});

describe("discover_source_fields", () => {
  it("refuses on an actuator WITHOUT running its code", async () => {
    const calls: string[] = [];
    const id = `disc-act-${SFX}`;
    spyAdapter(id, "actuator", calls);
    await expect(asAdmin(() => discoverSourceFields(id))).rejects.toThrow(/performs actions/i);
    expect(calls).toEqual([]);
  });

  it("samples it when the caller confirms the actions", async () => {
    const calls: string[] = [];
    const id = `disc-act-ok-${SFX}`;
    spyAdapter(id, "actuator", calls);
    await asAdmin(() => discoverSourceFields(id, true));
    expect(calls).toEqual([id]);
  });

  it("reaches the gate through the chat tool too", async () => {
    const calls: string[] = [];
    const id = `disc-chat-${SFX}`;
    spyAdapter(id, "actuator", calls);
    const r = await asBuilder(() => runTool("discover_source_fields", { adapterId: id }));
    expect(r.content).toMatch(/performs actions/i);
    expect(calls).toEqual([]);
  });
});
