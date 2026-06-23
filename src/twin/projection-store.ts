// Model-driven projection tables, managed with raw SQL.
//
// Why raw SQL and not Prisma's typed client: the projection tables ARE
// projections — disposable, rebuildable, and defined by whatever model is loaded.
// Managing them with CREATE/DROP TABLE via $executeRawUnsafe means a model swap
// can drop and recreate them IN-PROCESS — no `prisma generate`, no server
// restart — which is what makes a live "apply" (with a loader) possible.
//
// CRITICAL: every projection table is namespaced with a `gen_` prefix so it can
// NEVER collide with a Prisma-managed table. The control-plane tables and the
// append-only EventLog are pure Prisma (typed DateTime columns etc.); without the
// prefix, applying a model could DROP/recreate one of them as a raw-SQL table and
// corrupt Prisma's reads. Callers pass the logical entity name (e.g. "Account");
// this module maps it to the physical table (`gen_Account`).

import { prisma } from "../db.js";
import type { Ontology, EntitySchema } from "../ontology/model.js";
import { currentOrgId, currentWorkflowId, isSystemWorkflow } from "../platform/tenancy/context.js";

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

// Per-WORKFLOW namespacing. The SYSTEM default workflow uses the un-prefixed
// `gen_<Entity>` tables (the demo's data, untouched). Every OTHER workflow gets
// its own namespace `gen__p<projectHex>_<Entity>` (double underscore) so two
// workflows' models/data never collide. The active workflow comes from ALS.
const WORKFLOW_MARK = "gen__p";

/** Hex workflow key for the active workflow, or null for the system workflow. */
function projKey(): string | null {
  return isSystemWorkflow() ? null : currentWorkflowId().replace(/-/g, "");
}

/** Physical table prefix for the ACTIVE workflow's scope. */
function physPrefix(): string {
  const pk = projKey();
  return pk ? `${WORKFLOW_MARK}${pk}_` : TABLE_PREFIX;
}

/** Quoted PHYSICAL table identifier for a logical entity name, in the active
 * workflow's namespace. */
function phys(logical: string): string {
  return ident(physPrefix() + logical);
}

// --- Multi-tenant row scoping ------------------------------------------------
// Each projection row carries the organization that owns it, stamped from the
// resolved tenant context on insert and filtered on read. This is the data-plane
// half of the isolation spine. It is column-presence-guarded so a legacy gen_
// table created before this column existed keeps working (treated as the system
// org) until the next applyModelTables rebuild adds the column.
const orgColCache = new Map<string, boolean>();

async function hasOrgColumn(table: string): Promise<boolean> {
  const physName = physPrefix() + table; // cache per PHYSICAL table — one logical name maps to a different table per workflow
  const cached = orgColCache.get(physName);
  if (cached !== undefined) return cached;
  const has = (await tableColumns(table)).has("organization_id");
  orgColCache.set(physName, has);
  return has;
}

/** SQL fragment + params scoping a query to the current org. Empty for a legacy
 * table without the column. */
async function orgFilterSql(table: string): Promise<{ clause: string; params: unknown[] }> {
  if (!(await hasOrgColumn(table))) return { clause: "", params: [] };
  return { clause: `${ident("organization_id")} = ?`, params: [currentOrgId()] };
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
  // Guard the workflow namespace: a model entity named "_p…" could otherwise
  // collide with another workflow's gen__p<hex>_… tables.
  if (entity.name.startsWith("_")) {
    throw new Error(`reserved entity name "${entity.name}": model entity names may not start with "_"`);
  }
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
  // Provenance of the current row state (simulated | recorded | live). Null →
  // falls back to the bounded context's mode at read time. Written by adapters
  // when they pull real data; synthesized rows leave it null (= simulated).
  if (!declared.has("_provenance")) cols.push(`${ident("_provenance")} TEXT`);
  // Multi-tenant owner. Snake-cased so it never collides with a model field
  // named `organizationId`; stamped on insert, filtered on read.
  if (!declared.has("organization_id")) cols.push(`${ident("organization_id")} TEXT`);
  return `CREATE TABLE ${phys(entity.name)} (${cols.join(", ")})`;
}

/** Logical names of the projection tables in the ACTIVE workflow's namespace. */
export async function listProjectionTables(): Promise<string[]> {
  const prefix = physPrefix();
  const rows = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT name FROM sqlite_master WHERE type='table'`,
  );
  return rows
    .map((r) => r.name)
    // The SYSTEM scope must EXCLUDE the workflow namespace: a prefix match alone
    // would catch gen__p… because they also start with "gen_".
    .filter((n) => n.startsWith(prefix) && (prefix !== TABLE_PREFIX || !n.startsWith(WORKFLOW_MARK)))
    .map((n) => n.slice(prefix.length));
}

export interface ApplyResult {
  dropped: string[];
  created: string[];
}

/** Drop every `gen_` projection table and recreate the current model's entity
 * tables. Prisma-managed tables (control plane + EventLog) are NEVER touched.
 * In-process, synchronous, no restart — the destructive "drop tables on swap". */
export async function applyModelTables(ontology: Ontology): Promise<ApplyResult> {
  orgColCache.clear(); // tables are being rebuilt — drop the column-presence cache
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

/** Drop every projection table in a SPECIFIC workflow's namespace
 * (gen__p<projectHex>_*), independent of the active ALS context. This is the
 * control-plane teardown used by workflow deletion: it tears down a workflow's
 * whole data plane from outside that workflow's request scope. Returns the
 * physical table names dropped. The system default workflow's un-prefixed `gen_`
 * tables can NEVER match this `gen__p…` prefix, so the demo is structurally safe
 * even if this is somehow called with the system workflow id. */
export async function dropProjectionTablesForWorkflow(workflowId: string): Promise<string[]> {
  const prefix = `${WORKFLOW_MARK}${workflowId.replace(/-/g, "")}_`;
  const rows = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT name FROM sqlite_master WHERE type='table'`,
  );
  const tables = rows.map((r) => r.name).filter((n) => n.startsWith(prefix));
  for (const t of tables) {
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${ident(t)}`);
    orgColCache.delete(t); // physical name — evict the column-presence cache entry
  }
  return tables;
}

/** Create the projection table for ONE entity if it doesn't exist yet (additive;
 * never drops). Used by adapters that ingest into an entity's gen_ table without
 * a full model apply. */
export async function ensureTable(entity: EntitySchema): Promise<void> {
  if (await tableExists(entity.name)) return;
  await prisma.$executeRawUnsafe(createTableSql(entity));
  orgColCache.set(physPrefix() + entity.name, true); // freshly created → has the org column
}

/** Does a projection table exist for this logical entity name (active workflow)? */
export async function tableExists(logical: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*) as n FROM sqlite_master WHERE type='table' AND name = ?`,
    physPrefix() + logical,
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

/** Column names of a projection table (empty set if it doesn't exist). Used to
 * detect schema drift — a model whose entity gained a field needs a rebuild. */
export async function tableColumns(logical: string): Promise<Set<string>> {
  const rows = await prisma.$queryRawUnsafe<Array<{ name: string }>>(`PRAGMA table_info(${phys(logical)})`);
  return new Set(rows.map((r) => r.name));
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
  const f = await orgFilterSql(table);
  const where = f.clause ? `WHERE ${ident("id")} = ? AND ${f.clause}` : `WHERE ${ident("id")} = ?`;
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT * FROM ${phys(table)} ${where} LIMIT 1`,
    id,
    ...f.params,
  );
  return normalizeRow(rows[0]);
}

export async function findMany(table: string, limit = 200): Promise<Array<Record<string, unknown>>> {
  const f = await orgFilterSql(table);
  const where = f.clause ? `WHERE ${f.clause} ` : "";
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT * FROM ${phys(table)} ${where}LIMIT ?`,
    ...f.params,
    limit,
  );
  return rows.map((r) => normalizeRow(r)!) as Array<Record<string, unknown>>;
}

export async function insert(table: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
  const now = new Date().toISOString();
  const full: Record<string, unknown> = { version: 0, createdAt: now, updatedAt: now, ...data };
  if ((await hasOrgColumn(table)) && full.organization_id === undefined) {
    full.organization_id = currentOrgId(); // stamp the owner from the resolved context
  }
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
  const f = await orgFilterSql(table);
  const extra = f.clause ? ` AND ${f.clause}` : "";
  const values = [...cols.map((c) => sqlValue(changes[c])), new Date().toISOString(), id, expectedVersion, ...f.params];
  const affected = await prisma.$executeRawUnsafe(
    `UPDATE ${phys(table)} SET ${sets.join(", ")} WHERE ${ident("id")} = ? AND ${ident("version")} = ?${extra}`,
    ...values,
  );
  if (Number(affected) === 0) throw new Error(`stale write on ${table} ${id}`);
  return (await findById(table, id))!;
}

export async function deleteById(table: string, id: string): Promise<void> {
  const f = await orgFilterSql(table);
  const extra = f.clause ? ` AND ${f.clause}` : "";
  await prisma.$executeRawUnsafe(`DELETE FROM ${phys(table)} WHERE ${ident("id")} = ?${extra}`, id, ...f.params);
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

// ---------------------------------------------------------------------------
// App metadata key-value table (e.g. which model the current data belongs to).
// Not a projection (no gen_ prefix) and not a Prisma model, so it survives both
// applyModelTables and the Prisma reset — exactly what a data-ownership marker
// needs.
// ---------------------------------------------------------------------------

async function ensureMetaTable(): Promise<void> {
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "_app_meta" ("key" TEXT PRIMARY KEY, "value" TEXT)`);
}

export async function getMeta(key: string): Promise<string | null> {
  await ensureMetaTable();
  const rows = await prisma.$queryRawUnsafe<Array<{ value: string }>>(`SELECT value FROM "_app_meta" WHERE key = ?`, key);
  return rows[0]?.value ?? null;
}

export async function setMeta(key: string, value: string): Promise<void> {
  await ensureMetaTable();
  await prisma.$executeRawUnsafe(
    `INSERT INTO "_app_meta" (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    key,
    value,
  );
}
