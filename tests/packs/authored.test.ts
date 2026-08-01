import { describe, it, expect, afterAll, vi } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { denyScan } from "../../src/packs/codegen/deny-scan.js";
import { writeBody } from "../../src/packs/codegen/adapter-ai.js";
import { createAuthoredAdapter } from "../../src/packs/adapters/authored.js";
import { ingestPull } from "../../src/packs/ingest.js";
import { registerAdapter } from "../../src/packs/registry.js";
import { readDoc, deleteDoc } from "../../src/packs/connector/journal.js";
import { readSidecar, writeSidecar, deleteSidecar } from "../../src/packs/sidecar.js";
import { prisma } from "../../src/db.js";
import * as store from "../../src/twin/projection-store.js";
import { getOntology } from "../../src/ontology/model.js";
import { modelHarness } from "../helpers/po-model.js";
import { deriveFromData } from "../../src/twin/derive.js";
import type { AdapterConfig } from "../../src/packs/types.js";

// Spy mode: real derivation everywhere, overridable per test — used to prove a
// derive failure after a committed pull stays best-effort (no throw, no
// "failed" note), which a pull-phase failure test cannot cover.
vi.mock("../../src/twin/derive.js", { spy: true });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENTITY = "PurchaseOrder";

// A clean, deny-scan-passing body: synthesizes rows using ONLY ctx (no network).
const CLEAN_BODY = `
export async function fetchRows(ctx) {
  ctx.log("synthesizing " + ctx.entity.name);
  const rows = [];
  for (let i = 0; i < ctx.limit; i++) {
    rows.push({ id: "po-auth-" + i, projectId: "proj-1", partNumber: "PN-" + i, qty: i + 1, supplierId: "sup-1", status: "DRAFT" });
  }
  return rows;
}
`;

const cfg = (bodyPath?: string): AdapterConfig => ({
  id: "test-authored-sap", kind: "authored", boundedContext: "SAP", targetEntity: ENTITY, phase: "built", mode: "live", bodyPath,
});

// The model is bound per-workflow (no global .qlerify/workflow.json anymore);
// adapter pull/ingest call getOntology() internally, so they run inside the
// harness's tenant context, which also scopes the gen__p<hex>_ projection table.
const model = modelHarness();

// Extra ids used by the failure-journaling / lastPullAt tests below. Unique to
// this file; docs + sidecars are removed in afterAll so nothing leaks into a
// later loadPacks() scan.
const FAIL_ID = "test-authored-sap-missing";
const STAMP_ID = "test-authored-sap-stamp";
const DERIVE_FAIL_ID = "test-authored-sap-derive-fail";

let writtenPath = "";
afterAll(async () => {
  if (writtenPath && existsSync(join(ROOT, writtenPath))) rmSync(join(ROOT, writtenPath));
  for (const id of [FAIL_ID, STAMP_ID, DERIVE_FAIL_ID]) { deleteDoc(id); deleteSidecar(id); }
  await model.run(async () => {
    const e = getOntology().entity(ENTITY);
    if (e) await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${store.tableFor(e)}"`);
  });
});

describe("deny-scan", () => {
  it("rejects dangerous APIs, accepts a clean body", () => {
    expect(denyScan(CLEAN_BODY).ok).toBe(true);
    expect(denyScan(`import cp from "child_process"; export async function fetchRows(){}`).ok).toBe(false);
    expect(denyScan(`export async function fetchRows(){ return process.env.SECRET }`).ok).toBe(false);
    expect(denyScan(`export async function fetchRows(){ eval("x") }`).ok).toBe(false);
    expect(denyScan(`import fs from "node:fs"; export function fetchRows(){}`).ok).toBe(false);
  });
});

describe("writeBody — unique-path (Fix 1) + deny-scan gate", () => {
  it("writes a content-hash path, is idempotent, and refuses denied code", () => {
    const r1 = writeBody(cfg(), CLEAN_BODY);
    writtenPath = r1.bodyPath;
    expect(r1.bodyPath).toContain("src/packs/sap/generated/test-authored-sap.");
    expect(r1.skipped).toBe(false);

    const r2 = writeBody(cfg(), CLEAN_BODY);
    expect(r2.bodyPath).toBe(r1.bodyPath); // identical content → same path → skipped
    expect(r2.skipped).toBe(true);

    const r3 = writeBody(cfg(), CLEAN_BODY + "\n// changed\n");
    expect(r3.bodyPath).not.toBe(r1.bodyPath); // new content → new path (fresh import)
    rmSync(join(ROOT, r3.bodyPath));

    expect(() => writeBody(cfg(), `import cp from "child_process"; export async function fetchRows(){}`)).toThrow(/deny-scan/);
  });
});

describe("authored host — the Lambda execution", () => {
  it("runs the body via a capability ctx and shapes rows; respects limit", () =>
    model.run(async () => {
      const a = createAuthoredAdapter(cfg(writtenPath));
      expect(a.mode).toBe("live");
      const pulled = await a.pull({ limit: 3 });
      expect(pulled.count).toBe(3);
      expect(pulled.rows[ENTITY]).toHaveLength(3);
      expect(pulled.rows[ENTITY][0].status).toBe("DRAFT");
      expect((await a.healthcheck()).ok).toBe(true);
    }));

  it("ingests authored rows into gen_ stamped with the adapter's mode", () =>
    model.run(async () => {
      const a = createAuthoredAdapter(cfg(writtenPath));
      registerAdapter(a);
      const summary = await ingestPull(a.id, { limit: 4 });
      expect(summary.inserted).toBe(4);
      expect(summary.mode).toBe("live");
      const rows = await store.findMany(ENTITY, 50);
      expect(rows.length).toBeGreaterThanOrEqual(4);
      for (const r of rows) expect(r._provenance).toBe("live");
    }));

  it("fails soft on a missing body — registers fine, never throws at boot", () =>
    model.run(async () => {
      const a = createAuthoredAdapter(cfg("src/packs/sap/generated/does-not-exist.logic.ts"));
      expect((await a.healthcheck()).ok).toBe(false); // no throw
      await expect(a.pull({ limit: 1 })).rejects.toThrow(/missing/);
    }));
});

describe("ingestPull timing + failure journaling", () => {
  it("journals EXACTLY ONE 'failed' note (error + attempt duration) when the pull throws, and leaves the sidecar unstamped", () =>
    model.run(async () => {
      deleteDoc(FAIL_ID); // a crashed earlier run must not inflate the count below
      const c = { ...cfg("src/packs/sap/generated/does-not-exist.logic.ts"), id: FAIL_ID };
      writeSidecar(c);
      registerAdapter(createAuthoredAdapter(c));
      await expect(ingestPull(FAIL_ID, { limit: 1 })).rejects.toThrow(/missing/);

      const doc = readDoc(FAIL_ID);
      // Exactly one note total: the single "failed" entry — proves neither
      // ingestPull nor any caller journals the same failure twice.
      expect(doc?.notes.length).toBe(1);
      const last = doc?.notes[doc.notes.length - 1];
      expect(last?.kind).toBe("failed");
      expect(last?.text).toMatch(/^Pull failed: /);
      expect(last?.text).toMatch(/missing/);
      expect(typeof last?.durationMs).toBe("number");
      // A failed attempt is not a pull: no freshness stamp.
      expect(readSidecar(FAIL_ID)?.lastPullAt).toBeUndefined();
    }));

  it("a derive failure after a committed pull is best-effort: no throw, derived null, no 'failed' note", () =>
    model.run(async () => {
      deleteDoc(DERIVE_FAIL_ID);
      const c = { ...cfg(writtenPath), id: DERIVE_FAIL_ID };
      registerAdapter(createAuthoredAdapter(c));
      vi.mocked(deriveFromData).mockRejectedValueOnce(new Error("derive boom"));

      const summary = await ingestPull(DERIVE_FAIL_ID, { limit: 2 }); // resolves despite the derive throw
      expect(summary.derived).toBeNull();
      expect(typeof summary.durationMs).toBe("number");

      const doc = readDoc(DERIVE_FAIL_ID);
      expect(doc?.notes.some((n) => n.kind === "failed")).toBe(false);
      const last = doc?.notes[doc.notes.length - 1];
      expect(last?.kind).toBe("ingested"); // the pull note — rows are committed
      expect(last?.text).toMatch(/^Ingested /);
    }));

  it("does not create a journal doc for an unknown adapter id (pre-run failure)", async () => {
    await expect(ingestPull("no-such-adapter-xyz")).rejects.toThrow(/unknown adapter/);
    expect(readDoc("no-such-adapter-xyz")).toBeNull();
  });

  it("stamps lastPullAt + lastPullDurationMs on the sidecar after a successful pull", () =>
    model.run(async () => {
      const c = { ...cfg(writtenPath), id: STAMP_ID };
      writeSidecar(c);
      registerAdapter(createAuthoredAdapter(c));
      const before = Date.now();
      const summary = await ingestPull(STAMP_ID, { limit: 2 });

      const stamped = readSidecar(STAMP_ID);
      expect(stamped?.lastPullAt).toBeDefined();
      expect(new Date(stamped!.lastPullAt!).getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(stamped?.lastPullDurationMs).toBe(summary.durationMs);
    }));
});
