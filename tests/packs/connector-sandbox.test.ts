// Workstream D — the connector sandbox actually holds. Proves: (1) the SSRF guard
// blocks private/metadata addresses; (2) a legitimate connector still runs; (3)
// under the Node permission model, connector code cannot read outside the
// workspace (the repo's .env / dev.db) or spawn a child process; (4) the
// deployment kill-switch disables execution.

import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { isBlockedIp, assertSafeUrl } from "../../src/packs/net-guard.js";
import { writeModule, writeCredentials, deleteConnectorFiles, runConnector, permissionFlag } from "../../src/packs/connector/runtime.js";
import { UNCAPPED_PULL_ROWS } from "../../src/packs/types.js";

const ENTITY = { name: "Thing", required: [], fields: [] } as any;

describe("SSRF guard (net-guard)", () => {
  it("blocks loopback / link-local / RFC1918 / metadata, allows public", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "::1", "fe80::1"]) {
      expect(isBlockedIp(ip)).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "203.0.113.7"]) {
      expect(isBlockedIp(ip)).toBe(false);
    }
  });

  it("assertSafeUrl rejects the cloud metadata IP and accepts a public literal IP", async () => {
    await expect(assertSafeUrl("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/blocked/);
    await expect(assertSafeUrl("http://127.0.0.1:5432/")).rejects.toThrow(/blocked/);
    await expect(assertSafeUrl("https://1.1.1.1/")).resolves.toBeUndefined(); // public literal IP, no DNS
  });
});

describe("connector subprocess sandbox", () => {
  const ids: string[] = [];
  const mk = (id: string, code: string) => { ids.push(id); writeModule(id, code); writeCredentials(id, {}); };

  afterEach(() => { for (const id of ids.splice(0)) deleteConnectorFiles(id); });

  it("runs a legitimate static connector", async () => {
    mk("sbx-ok", `export async function fetchRows(ctx) { return [{ id: "1", ok: true }]; }`);
    const r = await runConnector("sbx-ok", { entity: ENTITY, limit: 10 });
    expect(r.ok).toBe(true);
    expect(r.rows).toEqual([{ id: "1", ok: true }]);
  });

  // Generated modules defend with `ctx.limit ?? <fallback>`, so a null ctx.limit
  // would silently shrink a full ingest to the module's fallback (the exactly-
  // 1,000-rows-from-Cognito bug). An uncapped run must see the real ceiling.
  it("an uncapped run (limit: null) hands the module the UNCAPPED_PULL_ROWS ceiling, never null", async () => {
    mk("sbx-limit", `export async function fetchRows(ctx) { return [{ id: "1", seen: ctx.limit ?? "null" }]; }`);
    const r = await runConnector("sbx-limit", { entity: ENTITY, limit: null });
    expect(r.ok).toBe(true);
    expect(r.rows).toEqual([{ id: "1", seen: UNCAPPED_PULL_ROWS }]);
  });

  // The FS / child_process confinement is enforced by the Node permission model.
  // Skip these assertions on a runtime that lacks it (D1 — out-of-repo workspace —
  // still applies there, but an absolute-path read is only blocked by the model).
  const hasPerm = permissionFlag() !== null;

  it.runIf(hasPerm)("cannot read the repo's .env (outside the workspace)", async () => {
    const envPath = join(process.cwd(), ".env");
    mk("sbx-fs", `export async function fetchRows(ctx) {
      const { readFileSync } = await import("node:fs");
      return [{ leaked: readFileSync(${JSON.stringify(envPath)}, "utf8") }];
    }`);
    const r = await runConnector("sbx-fs", { entity: ENTITY, limit: 1 });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("PLATFORM_ENCRYPTION_KEY");
  });

  it.runIf(hasPerm)("cannot spawn a child process", async () => {
    mk("sbx-cp", `export async function fetchRows(ctx) {
      const { execSync } = await import("node:child_process");
      return [{ out: String(execSync("id")) }];
    }`);
    const r = await runConnector("sbx-cp", { entity: ENTITY, limit: 1 });
    expect(r.ok).toBe(false);
  });

  // Workflow-table snapshots: the host serializes read-only COPIES of the
  // workflow's projection tables into the ctx file; the module reads them via
  // ctx.readTable — the real tables stay outside the sandbox.
  it("exposes host-provided tables via ctx.tables / ctx.readTable (case-insensitive, [] when absent)", async () => {
    mk("sbx-tables", `export async function fetchRows(ctx) {
      return [{
        id: "1",
        names: ctx.tables.join(","),
        exact: ctx.readTable("Quarter").length,
        ci: ctx.readTable("quarter")[0].id,
        missing: ctx.readTable("NoSuchTable").length,
      }];
    }`);
    const r = await runConnector("sbx-tables", {
      entity: ENTITY, limit: 5,
      tables: { Quarter: [{ id: "q1" }, { id: "q2" }] },
    });
    expect(r.ok).toBe(true);
    expect(r.rows).toEqual([{ id: "1", names: "Quarter", exact: 2, ci: "q1", missing: 0 }]);
  });

  it("a run without tables sees none — a previous run's snapshot never leaks", async () => {
    mk("sbx-tables-leak", `export async function fetchRows(ctx) { return [{ id: "1", names: ctx.tables.join(",") }]; }`);
    const first = await runConnector("sbx-tables-leak", { entity: ENTITY, limit: 1, tables: { Quarter: [{ id: "q1" }] } });
    expect(first.rows).toEqual([{ id: "1", names: "Quarter" }]);
    const second = await runConnector("sbx-tables-leak", { entity: ENTITY, limit: 1 });
    expect(second.ok).toBe(true);
    expect(second.rows).toEqual([{ id: "1", names: "" }]);
  });

  it("is fully disabled by the deployment kill-switch", async () => {
    const prev = process.env.QLERIFY_CONNECTORS_ENABLED;
    process.env.QLERIFY_CONNECTORS_ENABLED = "false";
    try {
      mk("sbx-off", `export async function fetchRows(ctx) { return [{ id: "x" }]; }`);
      const r = await runConnector("sbx-off", { entity: ENTITY, limit: 1 });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/disabled/);
    } finally {
      if (prev === undefined) delete process.env.QLERIFY_CONNECTORS_ENABLED;
      else process.env.QLERIFY_CONNECTORS_ENABLED = prev;
    }
  });
});
