// Shared row synthesis (Part 2.2). Builds one complete projection row for a model
// entity from its field metadata: prefer the field's exampleData, fall back to a
// name-based placeholder; every `required` field is guaranteed present. The seed
// makes rows DIFFER (addressing the "every synthesized row is identical" gap) and
// keeps output deterministic so fixtures are reproducible. The simulated adapter
// (packs/adapters/simulated) pulls through this, so "simulated source" and the
// generic simulator draw from one row-synthesis primitive.
//
// FK coherence across related entities (relatedEntity) is a 2.5 concern; for now
// an FK-shaped field gets a synthetic id, not a real cross-row link.

import type { EntitySchema, SchemaField } from "../ontology/model.js";

/** Small deterministic PRNG (mulberry32) — seedable, unlike crypto randomUUID. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function placeholderFor(field: string, rng: () => number): string {
  const tag = Math.floor(rng() * 1e6).toString(36);
  if (/email/i.test(field)) return `user.${tag}@example.com`;
  if (/password|secret/i.test(field)) return "Passw0rd!";
  if (/phone/i.test(field)) return `+1-555-${String(Math.floor(rng() * 1e4)).padStart(4, "0")}`;
  if (/(name|title)/i.test(field)) return `Sample ${tag}`;
  if (/(date|week)/i.test(field)) return "2026-W30";
  return `${field}-${tag}`;
}

function coerce(value: unknown, dataType?: string): unknown {
  switch ((dataType ?? "string").toLowerCase()) {
    case "number":
    case "integer": {
      const n = Number(value);
      return Number.isFinite(n) ? Math.trunc(n) : 0;
    }
    case "float":
    case "decimal": {
      const n = Number(value);
      return Number.isFinite(n) ? n : 0;
    }
    case "boolean":
      return value === true || value === "true" || value === 1;
    default:
      return value == null ? "" : String(value);
  }
}

interface SynthesizeOpts {
  seed?: number;
  id?: string;
  overrides?: Record<string, unknown>;
}

export function synthesizeRow(entity: EntitySchema, opts: SynthesizeOpts = {}): Record<string, unknown> {
  const rng = mulberry32((opts.seed ?? 1) >>> 0);
  const byName = new Map(entity.fields.map((f) => [f.name, f] as const));
  // Fields first (insertion order), then any required name not declared as a field.
  const names = new Set<string>([...entity.fields.map((f) => f.name), ...entity.required]);
  const row: Record<string, unknown> = {};
  const genId = () => opts.id ?? `${entity.name.toLowerCase()}-${Math.floor(rng() * 1e9).toString(36)}`;
  for (const name of names) {
    if (name === "id") {
      row.id = genId();
      continue;
    }
    const f: SchemaField | undefined = byName.get(name);
    const examples = f?.exampleData;
    const value = examples && examples.length > 0 ? examples[Math.floor(rng() * examples.length)] : placeholderFor(name, rng);
    row[name] = coerce(value, f?.dataType);
  }
  if (!row.id) row.id = genId();
  return { ...row, ...(opts.overrides ?? {}) };
}
