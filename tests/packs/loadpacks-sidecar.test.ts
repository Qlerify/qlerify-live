import { describe, it, expect, afterAll } from "vitest";
import { loadPacks } from "../../src/packs/loadPacks.js";
import { getAdapter } from "../../src/packs/registry.js";
import { writeSidecar, deleteSidecar } from "../../src/packs/sidecar.js";
import type { AdapterConfig } from "../../src/packs/types.js";

// Regression: a reset/draft adapter writes a kind:"simulated" sidecar. loadPacks
// must register it (not only kind:"authored"), else it's orphaned on restart —
// the UI shows "Connect a system" while the create route 409s "already exists".
const ID = "loadpacks-sim-test";

afterAll(() => deleteSidecar(ID));

describe("loadPacks registers simulated sidecars, not just authored", () => {
  it("a kind:simulated sidecar is registered on load", async () => {
    const cfg: AdapterConfig = {
      id: ID, kind: "simulated", boundedContext: "TestBC", targetEntity: "TestEntity", phase: "draft", mode: "simulated",
    };
    writeSidecar(cfg);
    await loadPacks();
    const a = getAdapter(ID);
    expect(a).toBeDefined();
    expect(a?.kind).toBe("simulated");
    expect(a?.boundedContext).toBe("TestBC");
    expect(a?.targetEntity).toBe("TestEntity");
  });
});
