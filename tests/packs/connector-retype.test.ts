// `behavior` used to be write-once at create time, which left every connector
// built before the axis existed permanently untyped — and the only workaround,
// deleting and recreating, destroys an actuator's record of the actions it
// already performed. Retyping has to be possible, and it has to take effect on
// the protections immediately.

import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import { runTool, TOOLS } from "../../src/chat/tools.js";
import { setConnectorBehavior } from "../../src/packs/connector/orchestrate.js";
import { assertActionsConfirmed, performsActions, systemName } from "../../src/packs/behavior.js";
import { reingestAll } from "../../src/packs/ingest.js";
import { registerAdapter, unregisterAdapter, getAdapter } from "../../src/packs/registry.js";
import { readSidecar, writeSidecar, deleteSidecar } from "../../src/packs/sidecar.js";
import { deleteConnectorFiles, moduleExists, runConnector } from "../../src/packs/connector/runtime.js";
import { createConnectorAdapter } from "../../src/packs/adapters/connector.js";
import { readDoc } from "../../src/packs/connector/journal.js";
import { runWithTenant } from "../../src/platform/tenancy/context.js";
import { prisma } from "../../src/db.js";
import * as store from "../../src/twin/projection-store.js";
import { getOntology } from "../../src/ontology/model.js";
import { modelHarness } from "../helpers/po-model.js";
import type { AdapterBehavior } from "../../src/packs/types.js";

vi.mock("../../src/packs/connector/runtime.js", { spy: true });

const SFX = `rt${Date.now().toString(36)}`;
const model = modelHarness();
const asBuilder = <T>(fn: () => Promise<T> | T): Promise<T> =>
  runWithTenant({ ...model.ctx, actingAsPlatformAdmin: true }, async () => fn());
const parse = (r: { content: string }) => JSON.parse(r.content);

const ids: string[] = [];

/** setConnectorBehavior re-registers the adapter (healthcheck captures cfg, so
 * probeOnly has to follow the retype). That replaces the spy, so any test
 * asserting on pulls AFTER a retype must put it back — otherwise an empty call
 * log proves nothing about the skip. */
const registerSpy = (id: string, calls: string[]) => {
  registerAdapter({
    id, kind: "connector", boundedContext: "SAP", targetEntity: "PurchaseOrder", mode: "live" as const,
    async introspect() { return { entity: "PurchaseOrder", fields: [] }; },
    async mapping() { return {}; },
    async pull() { calls.push(id); return { rows: { PurchaseOrder: [] }, count: 0 }; },
    async push() { return { pushed: 0 }; },
    async healthcheck() { return { ok: true }; },
  } as any);
};

const spyAdapter = (id: string, behavior: AdapterBehavior | undefined, calls: string[]) => {
  writeSidecar({
    id, kind: "connector", ...(behavior ? { behavior } : {}),
    boundedContext: "SAP", targetEntity: "PurchaseOrder",
    phase: "built", mode: "live", workflowId: model.workflowId, organizationId: model.orgId,
  });
  ids.push(id);
  registerSpy(id, calls);
};

afterEach(() => {
  for (const id of ids.splice(0)) {
    unregisterAdapter(id);
    deleteSidecar(id);
    deleteConnectorFiles(id);
  }
});

afterAll(async () => {
  await prisma.eventLog.deleteMany({ where: { workflowId: model.workflowId } });
  await store.dropProjectionTablesForWorkflow(model.workflowId);
  await prisma.platAuditEvent.deleteMany({ where: { organizationId: model.orgId } });
});

describe("setConnectorBehavior", () => {
  it("types a connector that was created before the axis existed", () =>
    model.run(async () => {
      const id = `legacy-${SFX}`;
      spyAdapter(id, undefined, []);
      expect(readSidecar(id)?.behavior).toBeUndefined();
      expect(setConnectorBehavior(id, "actuator")).toBe("actuator");
      expect(readSidecar(id)?.behavior).toBe("actuator");
    }));

  it("rejects a value that is not one of the four", () =>
    model.run(async () => {
      const id = `bad-${SFX}`;
      spyAdapter(id, "sync", []);
      expect(() => setConnectorBehavior(id, "destroyer" as any)).toThrow(/must be one of/);
      expect(readSidecar(id)?.behavior).toBe("sync"); // unchanged
    }));

  it("records the change and its consequence in the journal", () =>
    model.run(async () => {
      const id = `note-${SFX}`;
      spyAdapter(id, "sync", []);
      setConnectorBehavior(id, "actuator");
      const last = (readDoc(id)?.notes ?? []).at(-1);
      expect(last?.text).toMatch(/from sync to actuator/);
      expect(last?.text).toMatch(/no longer re-run/i);
    }));

  it("warns in the journal when protection is REMOVED, not just added", () =>
    model.run(async () => {
      const id = `unprotect-${SFX}`;
      spyAdapter(id, "actuator", []);
      setConnectorBehavior(id, "sync");
      expect((readDoc(id)?.notes ?? []).at(-1)?.text).toMatch(/no longer protected/i);
    }));
});

// The point of retyping: the protections have to follow immediately, with no
// restart and no re-registration by the caller.
describe("a retype takes effect at once", () => {
  it("stops a rebuild re-running a connector the moment it becomes an actuator", () =>
    model.run(async () => {
      await store.ensureTable(getOntology().entity("PurchaseOrder")!);
      const calls: string[] = [];
      const id = `live-${SFX}`;
      spyAdapter(id, "sync", calls);

      await reingestAll({ limit: 1 });
      expect(calls).toEqual([id]); // as a sync it runs

      setConnectorBehavior(id, "actuator");
      registerSpy(id, calls); // the retype swapped the adapter out — put the spy back
      calls.length = 0;
      const r = await reingestAll({ limit: 1 });
      expect(calls).toEqual([]); // the skip, not a missing adapter, is what stopped it
      expect(r.skipped.map((s) => s.id)).toEqual([id]);
      expect(r.failures).toEqual([]);
    }));

  it("restores the protection loss just as fast", () =>
    model.run(async () => {
      await store.ensureTable(getOntology().entity("PurchaseOrder")!);
      const calls: string[] = [];
      const id = `back-${SFX}`;
      spyAdapter(id, "actuator", calls);

      await reingestAll({ limit: 1 });
      expect(calls).toEqual([]);

      setConnectorBehavior(id, "sync");
      registerSpy(id, calls);
      const r = await reingestAll({ limit: 1 });
      expect(calls).toEqual([id]); // protection gone, it runs again
      expect(r.skipped).toEqual([]);
    }));

  it("moves the action gate with it", () =>
    model.run(async () => {
      const id = `gate-${SFX}`;
      spyAdapter(id, "sync", []);
      expect(performsActions(readSidecar(id))).toBe(false);
      setConnectorBehavior(id, "actuator");
      expect(performsActions(readSidecar(id))).toBe(true);
    }));

  // The registered adapter captures cfg, so healthcheck's probeOnly would keep
  // the OLD type forever if the retype did not re-register. Without this, opening
  // a freshly-typed actuator's page would still fire its action.
  it("re-registers so healthcheck stops falling back to fetchRows", async () => {
    vi.mocked(moduleExists).mockReturnValue(true);
    vi.mocked(runConnector).mockResolvedValue({ ok: true, probe: { ok: true, detail: "stub" }, trace: [] } as any);
    try {
      const id = `hc-${SFX}`;
      await model.run(async () => {
        writeSidecar({
          id, kind: "connector", behavior: "sync", boundedContext: "SAP", targetEntity: "PurchaseOrder",
          phase: "built", mode: "live", workflowId: model.workflowId, organizationId: model.orgId,
        });
        ids.push(id);
        registerAdapter(createConnectorAdapter(readSidecar(id)!));
        await getAdapter(id)!.healthcheck();
        setConnectorBehavior(id, "actuator");
        await getAdapter(id)!.healthcheck();
      });
      const calls = vi.mocked(runConnector).mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[0]![1].probeOnly).toBe(false); // was sync
      expect(calls[1]![1].probeOnly).toBe(true); // retyped, and the adapter followed
    } finally {
      vi.mocked(runConnector).mockRestore();
      vi.mocked(moduleExists).mockRestore();
    }
  });
});

describe("set_connector_behavior (chat)", () => {
  it("is offered to the model with the arguments it needs", () => {
    const tool = TOOLS.find((t) => t.name === "set_connector_behavior");
    expect(tool).toBeTruthy();
    expect(Object.keys(tool!.input_schema.properties ?? {}).sort()).toEqual(
      ["adapterId", "behavior", "confirmed", "targetSystem"],
    );
    expect(tool!.input_schema.required).toContain("confirmed");
  });

  it("refuses without confirmation", async () => {
    const id = `chat-unconf-${SFX}`;
    spyAdapter(id, "sync", []);
    const r = await asBuilder(() => runTool("set_connector_behavior", { adapterId: id, behavior: "actuator", confirmed: false }));
    expect(r.content).toMatch(/confirmed=false/);
    expect(readSidecar(id)?.behavior).toBe("sync");
  });

  it("retypes on confirmation and says what changed", async () => {
    const id = `chat-ok-${SFX}`;
    spyAdapter(id, "sync", []);
    const r = parse(await asBuilder(() => runTool("set_connector_behavior", { adapterId: id, behavior: "actuator", confirmed: true })));
    expect(r.was).toBe("sync");
    expect(r.behavior).toBe("actuator");
    expect(r.note).toMatch(/skip it/i);
    expect(readSidecar(id)?.behavior).toBe("actuator");
  });

  // There is no UI for this, so if the assistant does not set it nobody does,
  // and every warning keeps naming the bounded context instead of the product.
  it("names the product it writes to, so warnings stop saying the bounded context", async () => {
    const id = `chat-sys-${SFX}`;
    spyAdapter(id, "sync", []);
    const r = parse(await asBuilder(() => runTool("set_connector_behavior", {
      adapterId: id, behavior: "actuator", targetSystem: "Slack", confirmed: true,
    })));
    expect(r.targetSystem).toBe("Slack");
    expect(readSidecar(id)?.targetSystem).toBe("Slack");
    // The gate is what the operator actually reads: it must say Slack, not the
    // bounded context this connector happens to sit under.
    expect(() => assertActionsConfirmed(readSidecar(id)!, "a dry run", undefined)).toThrow(/Slack/);
  });

  it("clears the name when handed an empty string", async () => {
    const id = `chat-sys-clear-${SFX}`;
    spyAdapter(id, "actuator", []);
    await asBuilder(() => runTool("set_connector_behavior", { adapterId: id, behavior: "actuator", targetSystem: "Slack", confirmed: true }));
    await asBuilder(() => runTool("set_connector_behavior", { adapterId: id, behavior: "actuator", targetSystem: "", confirmed: true }));
    expect(readSidecar(id)?.targetSystem).toBeUndefined();
  });

  it("falls back to the bounded context when no product is recorded", () => {
    expect(systemName({ boundedContext: "Hubspot" })).toBe("Hubspot");
    expect(systemName({ boundedContext: "Notifications", targetSystem: "Slack" })).toBe("Slack");
    expect(systemName({ boundedContext: "Notifications", targetSystem: "   " })).toBe("Notifications");
  });

  it("reports the current type through get_adapter_config", async () => {
    const id = `chat-read-${SFX}`;
    spyAdapter(id, "extractor", []);
    const cfg = parse(await asBuilder(() => runTool("get_adapter_config", { adapterId: id })));
    expect(cfg.behavior).toBe("extractor");
  });

  it("defaults an untyped connector to sync when reporting it", async () => {
    const id = `chat-legacy-${SFX}`;
    spyAdapter(id, undefined, []);
    const cfg = parse(await asBuilder(() => runTool("get_adapter_config", { adapterId: id })));
    expect(cfg.behavior).toBe("sync");
  });
});
