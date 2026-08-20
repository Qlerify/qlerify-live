import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import { runOne } from "../../src/packs/scheduler.js";
import { writeSidecar, readSidecar, deleteSidecar } from "../../src/packs/sidecar.js";
import { ingestPull } from "../../src/packs/ingest.js";
import { ensureWorkflowModelLoaded } from "../../src/platform/ontology-store/ontology-store.js";
import { getOntology, setWorkflowModel } from "../../src/ontology/model.js";
import { newId } from "../../src/platform/ids.js";
import { PURCHASE_ORDER_MODEL } from "../helpers/po-model.js";
import type { AdapterConfig } from "../../src/packs/types.js";

vi.mock("../../src/packs/ingest.js", { spy: true });
vi.mock("../../src/platform/ontology-store/ontology-store.js", { spy: true });

const SFX = `schedmodel${Date.now().toString(36)}`;

/** Model deliberately NOT bound: the state a freshly restarted process is in. */
const created: string[] = [];

function dueConnector(): AdapterConfig {
  const cfg = {
    id: `sched-${SFX}-${newId().slice(0, 8)}`,
    kind: "connector",
    boundedContext: "SAP",
    targetEntity: "PurchaseOrder",
    phase: "built",
    mode: "live",
    organizationId: newId(),
    workflowId: newId(),
    schedule: { enabled: true, everyMinutes: 60 },
  } as AdapterConfig;
  writeSidecar(cfg);
  created.push(cfg.id);
  return cfg;
}

afterAll(() => {
  for (const id of created) {
    deleteSidecar(id);
  }
});

/** Stand in for the DB read the real loader does, for one workflow only. */
function modelExistsFor(workflowId: string): void {
  vi.mocked(ensureWorkflowModelLoaded).mockImplementation(async (_org, wf) => {
    if (wf !== workflowId) return false;
    setWorkflowModel(wf, PURCHASE_ORDER_MODEL, null, `sched-${wf}`);
    return true;
  });
}

afterEach(() => {
  vi.mocked(ensureWorkflowModelLoaded).mockReset();
  vi.mocked(ingestPull).mockReset();
});

describe("a scheduled pull binds its own workflow's model", () => {
  it("resolves the model even though no HTTP request ever bound it", async () => {
    const cfg = dueConnector();
    modelExistsFor(cfg.workflowId!);
    const resolved: string[] = [];
    vi.mocked(ingestPull).mockImplementation(async () => {
      resolved.push(getOntology().entities[0]!.name);
      return {} as any;
    });

    await runOne(cfg);

    expect(resolved).toEqual(["PurchaseOrder"]);
    expect(readSidecar(cfg.id)?.schedule?.failures).toBe(0);
  });

  it("loads the model BEFORE pulling, not after", async () => {
    const cfg = dueConnector();
    const order: string[] = [];
    vi.mocked(ensureWorkflowModelLoaded).mockImplementation(async (_org, wf) => {
      order.push("load");
      setWorkflowModel(wf, PURCHASE_ORDER_MODEL, null, `sched-${wf}`);
      return true;
    });
    vi.mocked(ingestPull).mockImplementation(async () => {
      order.push("pull");
      return {} as any;
    });

    await runOne(cfg);

    expect(order).toEqual(["load", "pull"]);
  });

  it("asks for the connector's own tenant, never an ambient one", async () => {
    const cfg = dueConnector();
    modelExistsFor(cfg.workflowId!);
    vi.mocked(ingestPull).mockResolvedValue({} as any);

    await runOne(cfg);

    expect(vi.mocked(ensureWorkflowModelLoaded)).toHaveBeenCalledWith(cfg.organizationId, cfg.workflowId);
  });

  it("still journals a failure when the workflow genuinely has no model", async () => {
    const cfg = dueConnector();
    vi.mocked(ensureWorkflowModelLoaded).mockResolvedValue(false);
    vi.mocked(ingestPull).mockImplementation(async () => {
      getOntology();
      return {} as any;
    });

    await runOne(cfg);

    expect(readSidecar(cfg.id)?.schedule?.failures).toBe(1);
  });
});
