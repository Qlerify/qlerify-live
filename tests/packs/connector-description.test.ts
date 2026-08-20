import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import { runTool, TOOLS } from "../../src/chat/tools.js";
import { regenerateConnectorSummary } from "../../src/packs/connector/orchestrate.js";
import { describeConnectorStructured } from "../../src/packs/connector/codegen.js";
import { unregisterAdapter } from "../../src/packs/registry.js";
import { writeSidecar, deleteSidecar } from "../../src/packs/sidecar.js";
import { deleteConnectorFiles } from "../../src/packs/connector/runtime.js";
import { readDoc, deleteDoc } from "../../src/packs/connector/journal.js";
import { runWithTenant } from "../../src/platform/tenancy/context.js";
import { prisma } from "../../src/db.js";
import * as store from "../../src/twin/projection-store.js";
import { modelHarness } from "../helpers/po-model.js";

vi.mock("../../src/packs/connector/codegen.js", { spy: true });

const SFX = `desc${Date.now().toString(36)}`;
const model = modelHarness();
const asBuilder = <T>(fn: () => Promise<T> | T): Promise<T> =>
  runWithTenant({ ...model.ctx, actingAsPlatformAdmin: true }, async () => fn());
const parse = (r: { content: string }) => JSON.parse(r.content);

const ids: string[] = [];

const connector = (id: string) => {
  writeSidecar({
    id, kind: "connector", boundedContext: "SAP", targetEntity: "PurchaseOrder",
    phase: "built", mode: "live", workflowId: model.workflowId, organizationId: model.orgId,
  } as any);
  ids.push(id);
  return id;
};

const described = (summary: string, filters: string[] = []) => {
  vi.mocked(describeConnectorStructured).mockResolvedValue({ summary, filters, structured: true } as any);
};

afterEach(() => {
  vi.mocked(describeConnectorStructured).mockReset();
  for (const id of ids.splice(0)) {
    unregisterAdapter(id);
    deleteSidecar(id);
    deleteDoc(id);
    deleteConnectorFiles(id);
  }
});

afterAll(async () => {
  await prisma.eventLog.deleteMany({ where: { workflowId: model.workflowId } });
  await store.dropProjectionTablesForWorkflow(model.workflowId);
  await prisma.platAuditEvent.deleteMany({ where: { organizationId: model.orgId } });
});

describe("update_connector_description (chat)", () => {
  it("is offered to the model, and asks for no confirmation", () => {
    const tool = TOOLS.find((t) => t.name === "update_connector_description");
    expect(tool).toBeTruthy();
    expect(Object.keys(tool!.input_schema.properties ?? {}).sort()).toEqual(["adapterId", "description"]);
    expect(tool!.input_schema.required).toEqual(["adapterId"]);
  });

  it("re-reads the code and rewrites the description", () =>
    model.run(async () => {
      const id = connector(`chat-ai-${SFX}`);
      described("Fetches purchase orders, keeping only those whose email contains qlerify.");

      const r = parse(await asBuilder(() => runTool("update_connector_description", { adapterId: id })));

      expect(r.source).toBe("ai");
      expect(r.description).toMatch(/qlerify/);
      expect(readDoc(id)?.summary).toMatch(/qlerify/);
    }));

  it("stores wording the user dictated without asking the AI", () =>
    model.run(async () => {
      const id = connector(`chat-dictated-${SFX}`);

      const r = parse(await asBuilder(() =>
        runTool("update_connector_description", { adapterId: id, description: "  The nightly SAP mirror.  " })));

      expect(r.source).toBe("dictated");
      expect(readDoc(id)?.summary).toBe("The nightly SAP mirror.");
      expect(vi.mocked(describeConnectorStructured)).not.toHaveBeenCalled();
      expect(readDoc(id)?.notes.some((n) => /set by hand/.test(n.text))).toBe(true);
    }));

  it("admits when the describer was unavailable instead of passing off the generic line", () =>
    model.run(async () => {
      const id = connector(`chat-degraded-${SFX}`);
      vi.mocked(describeConnectorStructured).mockRejectedValue(new Error("no Anthropic key available"));

      const r = parse(await asBuilder(() => runTool("update_connector_description", { adapterId: id })));

      expect(r.source).toBe("fallback");
      expect(r.degraded).toBe(true);
      expect(r.note).toMatch(/NOT a real description/);
    }));

  it("does not claim to have rewritten anything when the target is not in the model", () =>
    model.run(async () => {
      const id = `orphan-${SFX}`;
      writeSidecar({
        id, kind: "connector", boundedContext: "SAP", targetEntity: "NotInTheModel",
        phase: "built", mode: "live", workflowId: model.workflowId, organizationId: model.orgId,
      } as any);
      ids.push(id);

      const r = parse(await asBuilder(() => runTool("update_connector_description", { adapterId: id })));

      expect(r.source).toBe("skipped");
      expect(r.degraded).toBe(true);
      expect(r.note).toMatch(/not in the loaded model/);
      expect(vi.mocked(describeConnectorStructured)).not.toHaveBeenCalled();
    }));

  it("treats a blank dictated description as a request to re-derive", () =>
    model.run(async () => {
      const id = connector(`chat-blank-${SFX}`);
      described("Derived from the code.");

      const r = parse(await asBuilder(() => runTool("update_connector_description", { adapterId: id, description: "   " })));

      expect(r.source).toBe("ai");
      expect(readDoc(id)?.summary).toBe("Derived from the code.");
    }));

  it("refuses an unknown connector", () =>
    model.run(async () => {
      const r = await asBuilder(() => runTool("update_connector_description", { adapterId: `nope-${SFX}` }));
      expect(r.content).toMatch(/no connector/);
    }));
});

describe("a description that could not be written by AI says so", () => {
  it("journals the downgrade instead of silently storing a generic line", () =>
    model.run(async () => {
      const id = connector(`fallback-${SFX}`);
      vi.mocked(describeConnectorStructured).mockRejectedValue(new Error("no Anthropic key available"));

      await asBuilder(() => regenerateConnectorSummary(id));

      const doc = readDoc(id);
      expect(doc?.summary).toMatch(/Connector populating PurchaseOrder/);
      expect(doc?.notes.some((n) => /Could not describe this connector with AI/.test(n.text))).toBe(true);
    }));

  it("keeps the raw provider error out of the operator-visible journal", () =>
    model.run(async () => {
      const id = connector(`leak-${SFX}`);
      vi.mocked(describeConnectorStructured).mockRejectedValue(
        new Error("connect ECONNREFUSED 10.0.3.14:443 while POSTing sk-ant-secret to internal-proxy"),
      );

      await asBuilder(() => regenerateConnectorSummary(id));

      const notes = (readDoc(id)?.notes ?? []).map((n) => n.text).join("\n");
      expect(notes).toMatch(/Could not describe this connector with AI/);
      expect(notes).not.toMatch(/ECONNREFUSED|10\.0\.3\.14|sk-ant-secret|internal-proxy/);
    }));

  it("keeps the previous facets rather than wiping them on failure", () =>
    model.run(async () => {
      const id = connector(`facets-${SFX}`);
      described("Real description.", ["only rows with an email"]);
      await asBuilder(() => regenerateConnectorSummary(id));
      expect(readDoc(id)?.facets?.filters).toEqual(["only rows with an email"]);

      vi.mocked(describeConnectorStructured).mockRejectedValue(new Error("boom"));
      await asBuilder(() => regenerateConnectorSummary(id));

      expect(readDoc(id)?.facets?.filters).toEqual(["only rows with an email"]);
    }));
});
