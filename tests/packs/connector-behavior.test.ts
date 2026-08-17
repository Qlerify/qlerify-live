// A connector's `behavior` says what RE-RUNNING it costs. The load-bearing case
// is `actuate`: its pull performs an action in another system, and a model
// rebuild (twin/apply.ts → reingestAll) re-pulls every connector. Without this
// classification, editing a model re-fires real side effects.

import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from "vitest";
import { prisma } from "../../src/db.js";
import { registerAdapter, unregisterAdapter } from "../../src/packs/registry.js";
import { reingestAll } from "../../src/packs/ingest.js";
import { buildConnectorPrompt } from "../../src/packs/connector/codegen.js";
import { readSidecar, writeSidecar, deleteSidecar } from "../../src/packs/sidecar.js";
import { deleteConnectorFiles, moduleExists, runConnector } from "../../src/packs/connector/runtime.js";
import { createConnectorAdapter } from "../../src/packs/adapters/connector.js";
import * as store from "../../src/twin/projection-store.js";
import { getOntology } from "../../src/ontology/model.js";
import { modelHarness } from "../helpers/po-model.js";
import type { AdapterBehavior } from "../../src/packs/types.js";

vi.mock("../../src/packs/connector/runtime.js", { spy: true });

const SFX = `bhv${Date.now().toString(36)}`;
const model = modelHarness();

const ids: string[] = [];

/** A connector whose pull RECORDS that it ran — the stand-in for a side effect. */
const spyAdapter = (id: string, calls: string[], behavior?: AdapterBehavior) => {
  writeSidecar({
    id,
    kind: "connector",
    behavior,
    boundedContext: "SAP",
    targetEntity: "PurchaseOrder",
    phase: "built",
    mode: "live",
    workflowId: model.workflowId,
    organizationId: model.orgId,
  });
  ids.push(id);
  registerAdapter({
    id,
    kind: "connector",
    boundedContext: "SAP",
    targetEntity: "PurchaseOrder",
    mode: "live" as const,
    async introspect() { return { entity: "PurchaseOrder", fields: [] }; },
    async mapping() { return {}; },
    async pull() {
      calls.push(id);
      return { rows: { PurchaseOrder: [] }, count: 0 };
    },
    async push() { return { pushed: 0 }; },
    async healthcheck() { return { ok: true }; },
  } as any);
};

afterEach(() => {
  for (const id of ids.splice(0)) {
    unregisterAdapter(id);
    deleteSidecar(id);
    deleteConnectorFiles(id);
  }
});

beforeAll(() => model.run(async () => {
  await store.ensureTable(getOntology().entity("PurchaseOrder")!);
}));

afterAll(async () => {
  await prisma.eventLog.deleteMany({ where: { workflowId: model.workflowId } });
  await store.dropProjectionTablesForWorkflow(model.workflowId);
});

describe("connector behavior", () => {
  it("re-pulls a sync connector on a rebuild", () =>
    model.run(async () => {
      const calls: string[] = [];
      spyAdapter(`sync-${SFX}`, calls, "sync");
      const r = await reingestAll({ limit: 1 });
      expect(calls).toEqual([`sync-${SFX}`]);
      expect(r.skipped).toEqual([]);
    }));

  it("re-pulls a connector with no behavior recorded (legacy = read-only)", () =>
    model.run(async () => {
      const calls: string[] = [];
      spyAdapter(`legacy-${SFX}`, calls, undefined);
      await reingestAll({ limit: 1 });
      expect(calls).toEqual([`legacy-${SFX}`]);
    }));

  it("NEVER re-runs an actuator on a rebuild, and says why", () =>
    model.run(async () => {
      const calls: string[] = [];
      spyAdapter(`act-${SFX}`, calls, "actuator");
      const r = await reingestAll({ limit: 1 });
      expect(calls).toEqual([]); // the side effect did not fire
      expect(r.skipped).toHaveLength(1);
      expect(r.skipped[0]!.id).toBe(`act-${SFX}`);
      expect(r.skipped[0]!.reason).toMatch(/performs actions/i);
      expect(r.failures).toEqual([]); // skipped is not a failure
    }));

  it("skips only the actuator when connectors are mixed", () =>
    model.run(async () => {
      const calls: string[] = [];
      spyAdapter(`mix-sync-${SFX}`, calls, "sync");
      spyAdapter(`mix-act-${SFX}`, calls, "actuator");
      spyAdapter(`mix-gen-${SFX}`, calls, "generator");
      const r = await reingestAll({ limit: 1 });
      expect(calls.sort()).toEqual([`mix-gen-${SFX}`, `mix-sync-${SFX}`]);
      expect(r.skipped.map((s) => s.id)).toEqual([`mix-act-${SFX}`]);
    }));

  it("records the behavior on the sidecar so it survives a restart", () =>
    model.run(async () => {
      const calls: string[] = [];
      spyAdapter(`persist-${SFX}`, calls, "actuator");
      expect(readSidecar(`persist-${SFX}`)?.behavior).toBe("actuator");
    }));
});

// healthcheck() runs on every connector detail read (GET /api/adapters/:id) and
// falls back to fetchRows when the module exports no probe(). For an actuator
// fetchRows IS the action, so opening the detail page would have performed it.
describe("actuator healthcheck", () => {
  it("asks the runtime not to fall back to fetchRows", async () => {
    vi.mocked(moduleExists).mockReturnValue(true);
    vi.mocked(runConnector).mockResolvedValue({ ok: true, probe: { ok: true, detail: "stub" }, trace: [] } as any);
    try {
      for (const behavior of ["actuator", "sync"] as const) {
        const a = createConnectorAdapter({
          id: `hc-${behavior}-${SFX}`, kind: "connector", behavior,
          boundedContext: "SAP", targetEntity: "PurchaseOrder", phase: "built", mode: "live",
          workflowId: model.workflowId, organizationId: model.orgId,
        } as any);
        await model.run(() => a.healthcheck());
      }
      const calls = vi.mocked(runConnector).mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[0]![1].op).toBe("probe");
      expect(calls[0]![1].probeOnly).toBe(true); // actuator: never falls back
      expect(calls[1]![1].probeOnly).toBe(false); // sync: fallback is harmless
    } finally {
      vi.mocked(runConnector).mockRestore();
      vi.mocked(moduleExists).mockRestore();
    }
  });
});

describe("connector build prompt", () => {
  const target = { name: "PurchaseOrder", required: ["id"], fields: [{ name: "id", dataType: "string" }] };
  const base = { target, targetKind: "entity" as const, instructions: "pull orders", credentialKeys: [] };

  it("tells an actuator to check before acting", () => {
    const prompt = buildConnectorPrompt({ ...base, behavior: "actuator" });
    expect(prompt).toMatch(/PERFORMS ACTIONS/);
    expect(prompt).toMatch(/Export a read-only probe/);
    expect(prompt).toMatch(/Never act blindly/);
    expect(prompt).toMatch(/ctx\.limit bounds ACTIONS/);
  });

  it("says nothing about actions for a read-only connector", () => {
    for (const behavior of ["sync", "generator", "extractor", undefined] as const) {
      const prompt = buildConnectorPrompt({ ...base, ...(behavior ? { behavior } : {}) });
      expect(prompt).not.toMatch(/PERFORMS ACTIONS/);
    }
  });
});
