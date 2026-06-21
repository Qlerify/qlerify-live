import { describe, it, expect, afterAll } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { denyScan } from "../../src/packs/codegen/deny-scan.js";
import { writeBody } from "../../src/packs/codegen/adapter-ai.js";
import { createAuthoredAdapter } from "../../src/packs/adapters/authored.js";
import { ingestPull } from "../../src/packs/ingest.js";
import { registerAdapter } from "../../src/packs/registry.js";
import { prisma } from "../../src/db.js";
import * as store from "../../src/twin/projection-store.js";
import type { AdapterConfig } from "../../src/packs/types.js";

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

let writtenPath = "";
afterAll(async () => {
  if (writtenPath && existsSync(join(ROOT, writtenPath))) rmSync(join(ROOT, writtenPath));
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "gen_${ENTITY}"`);
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
    expect(r1.bodyPath).toContain("src/packs/SAP/generated/test-authored-sap.");
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
  it("runs the body via a capability ctx and shapes rows; respects limit", async () => {
    const a = createAuthoredAdapter(cfg(writtenPath));
    expect(a.mode).toBe("live");
    const pulled = await a.pull({ limit: 3 });
    expect(pulled.count).toBe(3);
    expect(pulled.rows[ENTITY]).toHaveLength(3);
    expect(pulled.rows[ENTITY][0].status).toBe("DRAFT");
    expect((await a.healthcheck()).ok).toBe(true);
  });

  it("ingests authored rows into gen_ stamped with the adapter's mode", async () => {
    const a = createAuthoredAdapter(cfg(writtenPath));
    registerAdapter(a);
    const summary = await ingestPull(a.id, { limit: 4 });
    expect(summary.inserted).toBe(4);
    expect(summary.mode).toBe("live");
    const rows = await store.findMany(ENTITY, 50);
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const r of rows) expect(r._provenance).toBe("live");
  });

  it("fails soft on a missing body — registers fine, never throws at boot", async () => {
    const a = createAuthoredAdapter(cfg("src/packs/SAP/generated/does-not-exist.logic.ts"));
    expect((await a.healthcheck()).ok).toBe(false); // no throw
    await expect(a.pull({ limit: 1 })).rejects.toThrow(/missing/);
  });
});
