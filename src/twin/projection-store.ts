// Model-driven projection tables, managed with raw SQL.
//
// Why raw SQL and not Prisma's typed client: the projection tables ARE
// projections — disposable, rebuildable, and defined by whatever model is loaded.
// Managing them with CREATE/DROP TABLE via $executeRawUnsafe means a model swap
// can drop and recreate them IN-PROCESS — no `prisma generate`, no server
// restart — which is what makes a live "apply" (with a loader) possible.
//
// CRITICAL: every projection table is namespaced with a `gen_` prefix so it can
// NEVER collide with a Prisma-managed table. The hand-written Ericsson schema and
// the append-only EventLog are pure Prisma (typed DateTime columns etc.); without
// the prefix, applying a model would DROP/recreate e.g. `Demand` as a raw-SQL
// table and corrupt Prisma's reads. Callers pass the logical entity name (e.g.
// "Account"); this module maps it to the physical table (`gen_Account`).

import { prisma } from "../db.js";
import type { Ontology, EntitySchema } from "../ontology/model.js";

// Physical table prefix that isolates raw-SQL projections from Prisma tables.
const TABLE_PREFIX = "gen_";

/** A safe SQL identifier — model entity/field names are simple identifiers, but
 * validate + quote defensively (raw DDL can't be parameterized). */
function ident(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`unsafe SQL identifier: ${JSON.stringify(name)}`);
  }
  return `"${name}"`;
}

/** Quoted PHYSICAL table identifier for a logical entity name. */
function phys(logical: string): string {
  return ident(TABLE_PREFIX + logical);
}

function sqliteType(dataType?: string): string {
  switch ((dataType ?? "string").toLowerCase()) {
    case "number":
    case "integer":
    case "boolean":
      return "INTEGER";
    case "float":
    case "decimal":
      return "REAL";
    default:
      return "TEXT";
  }
}

/** Logical table name for an entity (callers pass this; the physical table is
 * `gen_` + this). Identity today. */
export function tableFor(entity: EntitySchema): string {
  return entity.name;
}

function createTableSql(entity: EntitySchema): string {
  const cols: string[] = [];
  const declared = new Set(entity.fields.map((f) => f.name));
  for (const f of entity.fields) {
    if (f.name === "id") {
      cols.push(`${ident("id")} TEXT PRIMARY KEY`);
      continue;
    }
    cols.push(`${ident(f.name)} ${sqliteType(f.dataType)}`);
  }
  if (!declared.has("id")) cols.unshift(`${ident("id")} TEXT PRIMARY KEY`);
  // Platform columns the generic base command relies on (only if not declared).
  if (!declared.has("version")) cols.push(`${ident("version")} INTEGER NOT NULL DEFAULT 0`);
  if (!declared.has("createdAt")) cols.push(`${ident("createdAt")} TEXT`);
  if (!declared.has("updatedAt")) cols.push(`${ident("updatedAt")} TEXT`);
  return `CREATE TABLE ${phys(entity.name)} (${cols.join(", ")})`;
}

/** Logical names of the `gen_`-prefixed projection tables that currently exist. */
export async function listProjectionTables(): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '${TABLE_PREFIX}%'`,
  );
  return rows.map((r) => r.name.slice(TABLE_PREFIX.length));
}

export interface ApplyResult {
  dropped: string[];
  created: string[];
}

/** Drop every `gen_` projection table and recreate the current model's entity
 * tables. Prisma-managed tables (Ericsson schema, EventLog) are NEVER touched.
 * In-process, synchronous, no restart — the destructive "drop tables on swap". */
export async function applyModelTables(ontology: Ontology): Promise<ApplyResult> {
  const existing = await listProjectionTables();
  const dropped: string[] = [];
  for (const t of existing) {
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${phys(t)}`);
    dropped.push(t);
  }
  const created: string[] = [];
  for (const entity of ontology.entities) {
    await prisma.$executeRawUnsafe(createTableSql(entity));
    created.push(entity.name);
  }
  return { dropped, created };
}

/** Does a projection table exist for this logical entity name? */
export async function tableExists(logical: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*) as n FROM sqlite_master WHERE type='table' AND name = ?`,
    TABLE_PREFIX + logical,
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Generic row operations (parameterized values; identifiers validated). The
// `table` argument is the LOGICAL entity name; phys() maps it to gen_<name>.
// ---------------------------------------------------------------------------

function normalizeRow<T extends Record<string, unknown>>(row: T | undefined): T | null {
  if (!row) return null;
  // SQLite INTEGER columns can arrive as BigInt via $queryRaw — coerce to number.
  for (const k of Object.keys(row)) {
    if (typeof (row as any)[k] === "bigint") (row as any)[k] = Number((row as any)[k]);
  }
  return row;
}

export async function findById(table: string, id: string): Promise<Record<string, unknown> | null> {
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT * FROM ${phys(table)} WHERE ${ident("id")} = ? LIMIT 1`,
    id,
  );
  return normalizeRow(rows[0]);
}

export async function findMany(table: string, limit = 200): Promise<Array<Record<string, unknown>>> {
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT * FROM ${phys(table)} LIMIT ?`,
    limit,
  );
  return rows.map((r) => normalizeRow(r)!) as Array<Record<string, unknown>>;
}

export async function insert(table: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
  const now = new Date().toISOString();
  const full: Record<string, unknown> = { version: 0, createdAt: now, updatedAt: now, ...data };
  const cols = Object.keys(full);
  const placeholders = cols.map(() => "?").join(", ");
  const values = cols.map((c) => sqlValue(full[c]));
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${phys(table)} (${cols.map(ident).join(", ")}) VALUES (${placeholders})`,
    ...values,
  );
  return (await findById(table, String(full.id)))!;
}

/** Optimistic-locked update: bumps version, fails if the row changed under us. */
export async function update(
  table: string,
  id: string,
  changes: Record<string, unknown>,
  expectedVersion: number,
): Promise<Record<string, unknown>> {
  const cols = Object.keys(changes);
  const sets = cols.map((c) => `${ident(c)} = ?`);
  sets.push(`${ident("version")} = ${ident("version")} + 1`);
  sets.push(`${ident("updatedAt")} = ?`);
  const values = [...cols.map((c) => sqlValue(changes[c])), new Date().toISOString(), id, expectedVersion];
  const affected = await prisma.$executeRawUnsafe(
    `UPDATE ${phys(table)} SET ${sets.join(", ")} WHERE ${ident("id")} = ? AND ${ident("version")} = ?`,
    ...values,
  );
  if (Number(affected) === 0) throw new Error(`stale write on ${table} ${id}`);
  return (await findById(table, id))!;
}

export async function deleteById(table: string, id: string): Promise<void> {
  await prisma.$executeRawUnsafe(`DELETE FROM ${phys(table)} WHERE ${ident("id")} = ?`, id);
}

/** Delete all rows from every projection table (keeps the tables). */
export async function clearAll(): Promise<void> {
  for (const t of await listProjectionTables()) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${phys(t)}`);
  }
}

function sqlValue(v: unknown): unknown {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === undefined) return null;
  return v;
}
