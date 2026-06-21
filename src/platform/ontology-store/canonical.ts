// Canonical JSON serialization for content hashing.
//
// Qlerify re-exports the same model with keys in different orders; hashing the
// raw bytes would make two semantically-identical models look different and
// defeat dedup + the "immutable hash ⇒ never-stale cache" guarantee. We hash a
// CANONICAL form (recursively key-sorted) for the version IDENTITY, while the
// blob store still keeps the ORIGINAL bytes verbatim (so the round-trippable
// Qlerify shape is preserved exactly).

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** Stable, key-sorted serialization of a parsed JSON value. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
