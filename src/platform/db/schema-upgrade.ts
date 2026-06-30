// Idempotent, additive schema upgrades applied at boot.
//
// This project provisions its schema with `prisma db push`, but db push DROPS the
// runtime `gen_` projection tables (the standing gotcha — db push on a populated
// dev.db wipes the simulator's data plane). So new columns on the long-lived,
// Prisma-owned tables (EventLog, the audit log) are added here by additive ALTERs
// instead of a push:
//   - a fresh DB already has them (the first db push reads the updated schema),
//   - an existing populated DB gets them in place with zero data loss,
//   - and a re-run is a no-op (each column is checked for existence first, so we
//     never raise — and log — SQLite's "duplicate column" error).
// Keep every change strictly additive (ADD COLUMN / CREATE INDEX IF NOT EXISTS);
// never DROP or rewrite here.

import { prisma } from "../../db.js";

interface ColumnUpgrade {
  table: string;
  column: string;
  type: string;
}

// New columns to ensure. SQLite has no `ADD COLUMN IF NOT EXISTS`, so each is
// guarded by a PRAGMA existence check below rather than a swallowed error.
const COLUMNS: ColumnUpgrade[] = [
  // Workstream A — governance attribution on the event spine.
  { table: "EventLog", column: "actorPrincipalId", type: "TEXT" },
  { table: "EventLog", column: "actorKind", type: "TEXT" },
  // Workstream C — actor kind on audit rows, so guardrail-block-rate can isolate
  // AI-originated denials.
  { table: "plat_audit_events", column: "actorKind", type: "TEXT" },
];

// Indexes are already idempotent via IF NOT EXISTS — no existence check needed.
const INDEXES: string[] = [
  `CREATE INDEX IF NOT EXISTS "EventLog_workflowId_actorKind_idx" ON "EventLog"("workflowId", "actorKind")`,
];

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
    `PRAGMA table_info("${table}")`,
  );
  return rows.some((r) => r.name === column);
}

/** Apply all additive upgrades. Idempotent; safe to call on every boot. */
export async function ensureSchemaUpgrades(): Promise<void> {
  for (const { table, column, type } of COLUMNS) {
    if (await columnExists(table, column)) continue;
    await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${type}`);
  }
  for (const sql of INDEXES) {
    await prisma.$executeRawUnsafe(sql);
  }
}
