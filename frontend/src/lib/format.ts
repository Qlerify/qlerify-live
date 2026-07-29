// Display label for an entity/aggregate identifier. The raw identifier stays the
// source of truth everywhere; this is the single hook for prettifying it.
export const prettyEntity = (name: string) => name

// The most human-readable scalar inside an object: a name-ish field if present,
// else the first primitive; "" when there is nothing scalar to show.
export const attrScalar = (v: unknown): string => {
  if (v === null || v === undefined) {
    return ""
  }
  if (typeof v !== "object") {
    return String(v)
  }
  const o = v as Record<string, unknown>
  for (const k of ["name", "title", "label", "displayName", "value", "id"]) {
    if (typeof o[k] === "string" || typeof o[k] === "number") {
      return String(o[k])
    }
  }
  for (const k of Object.keys(o)) {
    const x = o[k]
    if (typeof x === "string" || typeof x === "number" || typeof x === "boolean") {
      return String(x)
    }
  }
  return ""
}

// Collapse a value to one readable scalar. Some models store a mandatory
// attribute as a value object or a JSON-encoded string, which would otherwise
// render as raw JSON.
export const attrText = (raw: unknown): string => {
  if (raw === undefined || raw === null || raw === "") {
    return "—"
  }
  let v: unknown = raw
  if (typeof raw === "string") {
    const t = raw.trim()
    if (t[0] !== "{" && t[0] !== "[") {
      return raw
    }
    try {
      v = JSON.parse(t)
    } catch {
      return raw
    }
  }
  if (typeof v !== "object" || v === null) {
    return String(v)
  }
  if (Array.isArray(v)) {
    const parts = v.map(attrScalar).filter((s) => s !== "")
    return parts.length ? parts.join(", ") : "—"
  }
  return attrScalar(v) || "—"
}

// One line per contained value, so a rich field renders readably instead of as
// raw JSON. Empty array = nothing to show.
export const attrLines = (raw: unknown): string[] => {
  if (raw === undefined || raw === null || raw === "") {
    return []
  }
  let v: unknown = raw
  if (typeof raw === "string") {
    const t = raw.trim()
    if (t[0] !== "{" && t[0] !== "[") {
      return [raw]
    }
    try {
      v = JSON.parse(t)
    } catch {
      return [raw]
    }
  }
  if (typeof v !== "object" || v === null) {
    return [String(v)]
  }
  const source = Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)
  return source.map(attrText).filter((s) => s !== "—")
}

// List columns derived from the root-aggregate rows of the loaded model.
export const genericColumns = (rows: Record<string, unknown>[]): string[] => {
  const reserved = new Set([
    "id",
    "version",
    "createdAt",
    "updatedAt",
    "status",
    "progress",
    "total",
    "lastEvent",
    "dwellSeconds",
  ])
  const first = rows[0] || {}
  return Object.keys(first)
    .filter((k) => !reserved.has(k))
    .slice(0, 4)
}
