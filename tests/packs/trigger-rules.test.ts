// Trigger-rule persistence + loading, end-to-end through the real derive pass:
// the deny-scan gate, content-hash file naming, the sidecar record (gwtHash
// provenance), the authored evidence kind firing from a REAL rule module on
// disk, the fail-soft-and-visible path when the file breaks, and the static
// fallback resuming after delete. Shares the suite DB (order-independent:
// unique ids + a dedicated modelHarness workflow namespace).

import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "../../src/db.js";
import { deriveFromData } from "../../src/twin/derive.js";
import * as store from "../../src/twin/projection-store.js";
import { modelHarness } from "../helpers/po-model.js";
import { readSidecar, writeSidecar } from "../../src/packs/sidecar.js";
import { removeConnector } from "../../src/packs/connector/orchestrate.js";
import { listConnectorIds, deleteRuleFiles, writeRuleFile } from "../../src/packs/connector/runtime.js";
import {
  ruleScan, saveTriggerRuleCode, deleteTriggerRule, previewRule, gwtHashOf,
} from "../../src/packs/connector/rules.js";
import { getOntology } from "../../src/ontology/model.js";
import { DomainError } from "../../src/errors.js";

const WORKFLOW = JSON.stringify({
  version: 1,
  boundedContext: "Sales",
  roles: ["Rep"],
  domainEvents: {
    DealCreated: {
      event: "Deal Created",
      role: "Rep",
      command: { $ref: "#/schemas/commands/PlaceDeal" },
      aggregateRoot: { $ref: "#/schemas/entities/Deal" },
    },
    UpsellDealCreated: {
      event: "Upsell Deal Created",
      role: "Rep",
      follows: [{ $ref: "#/domainEvents/DealCreated" }],
      command: { $ref: "#/schemas/commands/CategorizeDeal" },
      aggregateRoot: { $ref: "#/schemas/entities/Deal" },
      acceptanceCriteria: ["Given a deal, When its category is upsell and the amount exceeds 20000, Then an upsell deal is recorded"],
    },
    WidgetMade: {
      event: "Widget Made",
      role: "Rep",
      command: { $ref: "#/schemas/commands/MakeWidget" },
      aggregateRoot: { $ref: "#/schemas/entities/Widget" },
    },
  },
  schemas: {
    entities: {
      Deal: {
        required: ["id"],
        fields: [
          { name: "id", dataType: "string" },
          { name: "category", dataType: "string" },
          { name: "amount", dataType: "number" },
        ],
      },
      Widget: {
        required: ["id"],
        fields: [{ name: "id", dataType: "string" }],
      },
    },
    commands: {
      PlaceDeal: { required: [], fields: [{ name: "amount" }] },
      CategorizeDeal: { required: [], fields: [{ name: "category" }] },
      MakeWidget: { required: [], fields: [] },
    },
  },
});

const model = modelHarness(WORKFLOW);
const CONN = "test-rules-deal";

const RULE_CODE = `// upsell deals over 20 000
export function detect(row, ctx, previous) {
  const amount = Number(row.amount ?? 0);
  const fired = String(row.category) === "upsell" && amount > 20000;
  return { fired, evidence: "category=" + row.category + ", amount=" + amount };
}
`;

function sidecarConnector(id: string): void {
  writeSidecar({
    id, kind: "connector", boundedContext: "Sales", targetEntity: "Deal",
    phase: "built", mode: "recorded", targetKind: "entity",
    workflowId: model.workflowId, organizationId: model.orgId,
  });
}

afterAll(async () => {
  try { removeConnector(CONN); } catch { /* already gone */ }
  deleteRuleFiles(CONN);
  await prisma.eventLog.deleteMany({ where: { workflowId: model.workflowId } });
  await store.dropProjectionTablesForWorkflow(model.workflowId);
});

describe("ruleScan — the static gate", () => {
  const cases: Array<[string, string, RegExp]> = [
    ["an import", `import fs from "node:fs";\nexport function detect(){return {fired:false}}`, /imports/],
    ["fetch", `export function detect(row){ fetch("http://x"); return {fired:false} }`, /network \(fetch\)/],
    ["async detect", `export async function detect(row){ return {fired:false} }`, /async/],
    ["await", `export function detect(row){ const p = await x; return {fired:false} }`, /async/],
    ["process.env", `export function detect(row){ return {fired: !!process.env.KEY} }`, /process\.env/],
    ["eval", `export function detect(row){ eval("1"); return {fired:false} }`, /eval/],
    ["a missing detect export", `function detect(row){ return {fired:false} }`, /missing/],
  ];
  for (const [what, code, why] of cases) {
    it(`rejects ${what}`, () => {
      const scan = ruleScan(code);
      expect(scan.ok).toBe(false);
      expect(scan.violations.join(", ")).toMatch(why);
    });
  }

  it("accepts a clean synchronous rule", () => {
    expect(ruleScan(RULE_CODE)).toEqual({ ok: true, violations: [] });
  });

  // The sandbox-escape primitives a regex `process.env` / `new Function` gate
  // misses — all must be rejected (rule code runs in the main process).
  const ESCAPES: Array<[string, string]> = [
    ["bracket process", `export function detect(row){ return {fired: !!process["env"]} }`],
    ["Function constructor", `export function detect(row){ return {fired: !!Function("return 1")()} }`],
    ["constructor escape", `export function detect(row){ return {fired: !!(function(){}).constructor} }`],
    ["globalThis", `export function detect(row){ return {fired: !!globalThis} }`],
    ["mainModule require", `export function detect(row){ const r = process.mainModule.require; return {fired:!!r} }`],
    ["prototype pollution", `export function detect(row){ row.__proto__.polluted = 1; return {fired:true} }`],
  ];
  for (const [what, code] of ESCAPES) {
    it(`rejects ${what}`, () => {
      expect(ruleScan(code).ok).toBe(false);
    });
  }
});

describe("rule files — content-hash naming, idempotent writes, workspace hygiene", () => {
  it("writes <id>.rule.<eventKey>.<hash12>.mjs, skips an identical rewrite, and stays out of listConnectorIds", () => {
    const first = writeRuleFile(CONN, "UpsellDealCreated", RULE_CODE);
    expect(first.file).toBe(`${CONN}.rule.UpsellDealCreated.${first.codeHash}.mjs`);
    expect(first.codeHash).toHaveLength(12);
    expect(first.skipped).toBe(false);
    const again = writeRuleFile(CONN, "UpsellDealCreated", RULE_CODE);
    expect(again).toEqual({ ...first, skipped: true });
    // A different content is a NEW path (tsx caches by path).
    const other = writeRuleFile(CONN, "UpsellDealCreated", RULE_CODE + "\n// v2\n");
    expect(other.file).not.toBe(first.file);
    // Rule files share the workspace + .mjs extension but are NOT connectors.
    expect(listConnectorIds().some((id) => id.includes(".rule."))).toBe(false);
    deleteRuleFiles(CONN);
  });
});

describe("trigger rules — save, derive (authored kind), break, delete", () => {
  it("binds only to events on the connector's own table, with scanned code", () =>
    model.run(() => {
      sidecarConnector(CONN);
      expect(() => saveTriggerRuleCode(CONN, "NoSuchEvent", RULE_CODE, { author: "human" }))
        .toThrow(/no event "NoSuchEvent"/);
      expect(() => saveTriggerRuleCode(CONN, "WidgetMade", RULE_CODE, { author: "human" }))
        .toThrow(/rooted on Widget/);
      expect(() => saveTriggerRuleCode(CONN, "UpsellDealCreated", `export function detect(){ fetch("x") }`, { author: "human" }))
        .toThrow(DomainError);
    }));

  it("records the rule on the sidecar with gwtHash provenance, resolving the event by NAME too", () =>
    model.run(() => {
      sidecarConnector(CONN);
      const { rule, skipped } = saveTriggerRuleCode(CONN, "Upsell Deal Created", RULE_CODE, {
        author: "human", condition: "upsell deals over 20 000",
      });
      expect(skipped).toBe(false);
      expect(rule.eventKey).toBe("UpsellDealCreated");
      expect(rule.eventRef).toContain("UpsellDealCreated");
      expect(rule.condition).toBe("upsell deals over 20 000");
      expect(rule.file).toContain(".rule.UpsellDealCreated.");
      expect(rule.gwtHash).toBe(gwtHashOf(getOntology().eventByKey("UpsellDealCreated")!));
    }));

  it("fires the authored kind from the real module on disk; a broken file falls back VISIBLY; delete restores the heuristic", () =>
    model.run(async () => {
      const ont = getOntology();
      await store.ensureTable(ont.entity("Deal")!);
      await store.insert("Deal", { id: "deal-upsell", category: "upsell", amount: 25000 });
      await store.insert("Deal", { id: "deal-cross", category: "cross sell", amount: 9000 });

      // The rule (saved in the previous test's sidecar record) drives derivation.
      const r1 = await deriveFromData();
      expect(r1.rules).toBeDefined();
      expect(r1.rules!.active).toBe(1);
      expect(r1.rules!.errors).toEqual([]);
      const upsell1 = r1.events.find((e) => e.key === "UpsellDealCreated")!;
      expect(upsell1.kind).toBe("authored");
      expect(upsell1.emitted).toBe(1);
      const logged = await prisma.eventLog.findMany({
        where: { workflowId: model.workflowId, eventRef: { contains: "UpsellDealCreated" } },
      });
      expect(logged.map((e) => e.aggregateId)).toEqual(["deal-upsell"]);
      expect(logged[0]!.evidenceKind).toBe("authored");
      expect(logged[0]!.evidence).toContain("rule: category=upsell");

      // Preview: the oracle view — fired counts + per-row evidence samples.
      const pv = await previewRule(CONN, "UpsellDealCreated");
      expect(pv.status).toBe("ok");
      expect(pv.fired).toBe(1);
      expect(pv.wouldEmitNow).toBe(0); // already in the log
      expect(pv.samples[0]).toEqual({ id: "deal-upsell", evidence: expect.stringContaining("rule:") });

      // Break the rule ON DISK (record kept): derive must still succeed, report
      // the error, and answer with the static heuristic — never silently skip.
      deleteRuleFiles(CONN, "UpsellDealCreated");
      const r2 = await deriveFromData();
      expect(r2.rules!.active).toBe(0);
      expect(r2.rules!.errors).toEqual([
        { eventKey: "UpsellDealCreated", connector: CONN, error: expect.stringContaining("missing") },
      ]);
      const upsell2 = r2.events.find((e) => e.key === "UpsellDealCreated")!;
      expect(upsell2.kind).toBe("fields"); // the sibling-less static classification
      // The static heuristic (category present) also fires the cross-sell row —
      // exactly the imprecision the rule existed to prevent, now visible.
      expect(upsell2.emitted).toBe(1);

      // Delete the rule record: no rules → no report, heuristic answers cleanly.
      deleteTriggerRule(CONN, "UpsellDealCreated");
      const r3 = await deriveFromData();
      expect(r3.rules).toBeUndefined();
      expect(r3.events.find((e) => e.key === "UpsellDealCreated")!.kind).toBe("fields");
    }));

  it("GWT drift marks the rule STALE (it still runs); an orphaned event disables it VISIBLY", () =>
    model.run(async () => {
      saveTriggerRuleCode(CONN, "UpsellDealCreated", RULE_CODE, { author: "ai", condition: "upsell over 20000" });

      // Simulate the model's GWT changing after compile: the stored hash drifts.
      const cfg = readSidecar(CONN)!;
      writeSidecar({
        ...cfg,
        triggerRules: cfg.triggerRules!.map((r) => ({ ...r, gwtHash: "0".repeat(64) })),
      });
      const stale = await deriveFromData({ preview: true });
      expect(stale.rules!.stale).toEqual([{ eventKey: "UpsellDealCreated", connector: CONN }]);
      expect(stale.rules!.active).toBe(1); // stale still RUNS — drift is surfaced, never auto-applied
      expect(stale.events.find((e) => e.key === "UpsellDealCreated")!.kind).toBe("authored");

      // Simulate the event vanishing from the model: the record points nowhere.
      const cfg2 = readSidecar(CONN)!;
      writeSidecar({
        ...cfg2,
        triggerRules: cfg2.triggerRules!.map((r) => ({ ...r, eventKey: "GhostEvent", eventRef: "#/domainEvents/GhostEvent" })),
      });
      const orphaned = await deriveFromData({ preview: true });
      expect(orphaned.rules!.active).toBe(0);
      expect(orphaned.rules!.disabled).toEqual([
        { eventKey: "GhostEvent", connector: CONN, reason: expect.stringContaining("orphaned") },
      ]);
      // The real event answers with its static heuristic again.
      expect(orphaned.events.find((e) => e.key === "UpsellDealCreated")!.kind).toBe("fields");

      // Restore + clean up the record for later tests.
      writeSidecar({ ...readSidecar(CONN)!, triggerRules: [] });
    }));
});
