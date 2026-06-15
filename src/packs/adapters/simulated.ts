// SimulatedAdapter (Part 2.2 / 2a) — the default adapter impl, so a freshly
// scaffolded pack runs end-to-end with ZERO credentials. It synthesizes
// model-native rows via the shared row synthesizer (twin/synthesize), so the
// "simulated source" and the generic simulator are one row-synthesis primitive.
// It's the bottom rung of the mode ladder: simulated → recorded → live.

import { getOntology, type EntitySchema } from "../../ontology/model.js";
import { synthesizeRow } from "../../twin/synthesize.js";
import type { FieldMap, SourceAdapter } from "../types.js";

export interface SimulatedAdapterConfig {
  id: string;
  boundedContext: string;
  targetEntity: string;
  /** Source→model alias map. Empty for the simulated rung (rows are already
   * model-native); authored when the real connector lands at recorded/live. */
  fieldMap?: FieldMap;
  /** Base seed → reproducible-but-varied synthesized rows. */
  seed?: number;
}

function resolveEntity(targetEntity: string): EntitySchema {
  const e = getOntology().entity(targetEntity);
  if (!e) throw new Error(`simulated adapter: entity "${targetEntity}" is not in the loaded model`);
  return e;
}

export function createSimulatedAdapter(cfg: SimulatedAdapterConfig): SourceAdapter {
  const baseSeed = cfg.seed ?? 1;
  return {
    id: cfg.id,
    kind: "simulated",
    boundedContext: cfg.boundedContext,
    targetEntity: cfg.targetEntity,
    mode: "simulated",
    async introspect() {
      const e = resolveEntity(cfg.targetEntity);
      return {
        entity: e.name,
        fields: e.fields.map((f) => ({ name: f.name, dataType: f.dataType, sample: f.exampleData?.[0] })),
      };
    },
    async mapping() {
      return cfg.fieldMap ?? {};
    },
    async pull(opts = {}) {
      const limit = opts.limit ?? 10;
      const e = resolveEntity(cfg.targetEntity);
      const rows = Array.from({ length: limit }, (_, i) => synthesizeRow(e, { seed: baseSeed * 1009 + i }));
      return { rows: { [e.name]: rows }, count: rows.length };
    },
    async push() {
      return { pushed: 0 };
    },
    async healthcheck() {
      return { ok: true, detail: "simulated source — always healthy" };
    },
  };
}
