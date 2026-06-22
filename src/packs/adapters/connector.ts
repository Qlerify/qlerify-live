// Connector adapter HOST (Part 2.4) — wraps a full-power AI-built connector behind
// the standard SourceAdapter contract, so ingestPull, the /test dry-run, and the
// explorer all consume it unchanged. The difference from the Part 2.3 authored
// adapter: the body is unrestricted and runs in an ISOLATED child process (see
// connector/runtime), not in-process. The target may be an entity OR a value
// object — value objects become their own gen_<VO> table when populated directly.

import { getOntology, type EntitySchema } from "../../ontology/model.js";
import type { AdapterConfig, SourceAdapter } from "../types.js";
import { runConnector, moduleExists } from "../connector/runtime.js";

/** Resolve the connector's target schema — an entity, or a value object. */
export function resolveTargetSchema(name: string): EntitySchema | undefined {
  const o = getOntology();
  return o.entity(name) ?? o.valueObject(name);
}

export function createConnectorAdapter(cfg: AdapterConfig): SourceAdapter {
  function target(): EntitySchema {
    const e = resolveTargetSchema(cfg.targetEntity);
    if (!e) throw new Error(`connector "${cfg.id}": target "${cfg.targetEntity}" is not in the loaded model`);
    return e;
  }

  return {
    id: cfg.id,
    kind: "connector",
    boundedContext: cfg.boundedContext,
    targetEntity: cfg.targetEntity,
    mode: cfg.mode ?? "live",
    async introspect() {
      const e = target();
      return { entity: e.name, fields: e.fields.map((f) => ({ name: f.name, dataType: f.dataType, sample: f.exampleData?.[0] })) };
    },
    async mapping() {
      return cfg.fieldMap ?? {};
    },
    async pull(opts = {}) {
      const e = target();
      const limit = opts.limit ?? cfg.limits?.limit ?? 25;
      const r = await runConnector(cfg.id, { entity: e, limit, endpoint: cfg.endpoint });
      if (!r.ok) {
        const trace = r.trace?.length ? `\nTrace:\n${r.trace.slice(-12).join("\n")}` : "";
        throw new Error(`${r.error ?? "connector run failed"}${trace}`);
      }
      const arr = (r.rows ?? []).slice(0, limit);
      return { rows: { [e.name]: arr }, count: arr.length };
    },
    async push() {
      return { pushed: 0 };
    },
    async healthcheck() {
      try {
        if (!moduleExists(cfg.id)) return { ok: false, detail: "no connector code yet — build it first" };
        const e = target();
        const r = await runConnector(cfg.id, { entity: e, limit: 1, op: "probe" });
        if (r.probe) return r.probe;
        if (!r.ok) return { ok: false, detail: r.error };
        return { ok: true, detail: `reached the source, fetched ${r.count ?? r.rows?.length ?? 0} row(s)` };
      } catch (err: any) {
        return { ok: false, detail: err?.message ?? String(err) };
      }
    },
  };
}
