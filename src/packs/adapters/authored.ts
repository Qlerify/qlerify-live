// Authored adapter HOST (Part 2.3, Slice 2) — the deterministic ".gen" half. It
// implements the full SourceAdapter and runs an AI-authored BODY
// (src/packs/<bc>/generated/<id>.<hash>.logic.ts, the ".logic" half) the
// "user-friendly Lambda" way: dynamic-import the body, hand it a
// capability-restricted ctx, run under a wall-clock budget, shape the result into
// RowsByEntity so the existing ingestPull consumes it unchanged.
//
// TWO load-bearing rules (verified under tsx by the design's adversarial pass):
//   1. UNIQUE PATH per body version. tsx caches transpiled modules by file PATH
//      and ignores a `?v=mtime` query, so re-importing the same path returns STALE
//      code. The host imports cfg.bodyPath, which the generator bumps to a new
//      content-hash filename on every regeneration.
//   2. LAZY import. The body is imported INSIDE pull()/healthcheck(), never at
//      registration/boot — so a broken or hostile body can never reach the boot
//      path or the green demo; only its own workbench panel shows the error.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getOntology, type EntitySchema } from "../../ontology/model.js";
import type { AdapterConfig, SourceAdapter } from "../types.js";
import { createRunContext, runWithBudget, type AdapterBody } from "../authored-runtime.js";
import { denyScan } from "../codegen/deny-scan.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RUN_BUDGET_MS = 15000;

export function createAuthoredAdapter(cfg: AdapterConfig): SourceAdapter {
  function resolveEntity(): EntitySchema {
    const e = getOntology().entity(cfg.targetEntity);
    if (!e) throw new Error(`authored adapter "${cfg.id}": entity "${cfg.targetEntity}" not in the loaded model`);
    return e;
  }

  // LAZY: imported only when a run actually happens, after a deny-scan.
  async function loadBody(): Promise<AdapterBody> {
    if (!cfg.bodyPath) throw new Error(`adapter "${cfg.id}": no body authored yet — generate one first`);
    const abs = isAbsolute(cfg.bodyPath) ? cfg.bodyPath : join(ROOT, cfg.bodyPath);
    if (!existsSync(abs)) throw new Error(`adapter "${cfg.id}": body file missing (${cfg.bodyPath})`);
    const scan = denyScan(readFileSync(abs, "utf8"));
    if (!scan.ok) throw new Error(`adapter "${cfg.id}": body failed the deny-scan (${scan.violations.join(", ")})`);
    const mod = (await import(pathToFileURL(abs).href)) as Partial<AdapterBody>;
    if (typeof mod.fetchRows !== "function") throw new Error(`adapter "${cfg.id}": body must export async fetchRows(ctx)`);
    return mod as AdapterBody;
  }

  return {
    id: cfg.id,
    kind: cfg.kind || "authored",
    boundedContext: cfg.boundedContext,
    targetEntity: cfg.targetEntity,
    mode: cfg.mode ?? "recorded",
    async introspect() {
      const e = resolveEntity();
      return { entity: e.name, fields: e.fields.map((f) => ({ name: f.name, dataType: f.dataType, sample: f.exampleData?.[0] })) };
    },
    async mapping() {
      return cfg.fieldMap ?? {};
    },
    async pull(opts = {}) {
      const e = resolveEntity();
      const limit = opts.limit ?? cfg.limits?.limit ?? 10;
      const body = await loadBody();
      const ctx = await createRunContext(cfg, e, limit);
      const rows = await runWithBudget(() => body.fetchRows(ctx), RUN_BUDGET_MS);
      const arr = Array.isArray(rows) ? rows.slice(0, limit) : [];
      return { rows: { [e.name]: arr }, count: arr.length };
    },
    async push() {
      return { pushed: 0 };
    },
    async healthcheck() {
      try {
        const e = resolveEntity();
        const body = await loadBody();
        const ctx = await createRunContext(cfg, e, 1);
        if (body.probe) return await runWithBudget(() => body.probe!(ctx), RUN_BUDGET_MS);
        const r = await runWithBudget(() => body.fetchRows(ctx), RUN_BUDGET_MS);
        return { ok: Array.isArray(r), detail: `pulled ${Array.isArray(r) ? r.length : 0} row(s)` };
      } catch (err: any) {
        return { ok: false, detail: err?.message ?? String(err) };
      }
    },
  };
}
