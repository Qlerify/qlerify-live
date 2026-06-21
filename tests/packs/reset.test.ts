import { describe, it, expect, afterAll } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeBody } from "../../src/packs/codegen/adapter-ai.js";
import { resetAdapter, removeAdapter } from "../../src/packs/author.js";
import { registerAdapter, getAdapter } from "../../src/packs/registry.js";
import { createAuthoredAdapter } from "../../src/packs/adapters/authored.js";
import { readSidecar, writeSidecar } from "../../src/packs/sidecar.js";
import type { AdapterConfig } from "../../src/packs/types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ID = "reset-test";
const ENV_KEY = "RESET_TEST_SECRET";
const BODY = `export async function fetchRows(ctx) { return [{ id: "x" }]; }\n`;

afterAll(() => {
  try { removeAdapter(ID); } catch { /* ignore */ }
  rmSync(join(ROOT, "src/packs/testbc"), { recursive: true, force: true });
  delete process.env[ENV_KEY];
});

describe("reset / remove adapter (build from scratch)", () => {
  it("reset wipes an authored adapter back to a clean simulated draft", () => {
    const base: AdapterConfig = {
      id: ID, kind: "authored", boundedContext: "TestBC", targetEntity: "ResetTestEntity",
      phase: "built", mode: "live", credentialsRef: ENV_KEY,
    };
    const { bodyPath } = writeBody(base, BODY);
    writeSidecar({ ...base, bodyPath });
    process.env[ENV_KEY] = "supersecret";
    registerAdapter(createAuthoredAdapter({ ...base, bodyPath }));
    expect(existsSync(join(ROOT, bodyPath))).toBe(true);

    const fresh = resetAdapter(ID);

    expect(fresh.kind).toBe("simulated");
    expect(fresh.mode).toBe("simulated");
    expect(fresh.bodyPath).toBeUndefined();
    expect(fresh.credentialsRef).toBeUndefined();
    expect(existsSync(join(ROOT, bodyPath))).toBe(false);   // generated body deleted
    expect(process.env[ENV_KEY]).toBeUndefined();           // in-process secret cleared
    const sc = readSidecar(ID);
    expect(sc?.kind).toBe("simulated");
    expect(sc?.bodyPath).toBeUndefined();
    expect(getAdapter(ID)?.kind).toBe("simulated");         // re-registered as simulated
  });

  it("remove deletes the adapter entirely", () => {
    removeAdapter(ID);
    expect(getAdapter(ID)).toBeUndefined();
    expect(readSidecar(ID)).toBeNull();
  });
});
