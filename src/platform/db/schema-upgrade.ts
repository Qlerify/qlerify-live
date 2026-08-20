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
// Keep every change strictly additive (ADD COLUMN / CREATE INDEX IF NOT EXISTS /
// CREATE TABLE IF NOT EXISTS); never DROP or rewrite here. A brand-new table's
// DDL must mirror what `db push` would create from schema.prisma (same column
// types, same index names) so a fresh install and an upgraded install converge
// on the identical schema.

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
  // Authentication-issuance increment — a member's admin-issued temp password must
  // be changed on first use. NOT NULL DEFAULT 0 backfills every existing row.
  { table: "plat_identities", column: "mustChangePassword", type: "BOOLEAN NOT NULL DEFAULT 0" },
  // Timestamp trust on the event spine: businessAtKind = known | estimated,
  // stamped by data derivation (twin/derive.ts) so the UI can grey out inferred
  // business times. Null = simulator/live rows, pre-existing derived rows, and
  // derived events with no source anchor (businessAt NULL — nothing to qualify).
  { table: "EventLog", column: "businessAtKind", type: "TEXT" },
  // Per-org LLM provider choice + AWS Bedrock BYOK (org's own AWS credentials).
  { table: "plat_organizations", column: "llmProvider", type: "TEXT" },
  { table: "plat_organizations", column: "bedrockRegion", type: "TEXT" },
  { table: "plat_organizations", column: "bedrockModel", type: "TEXT" },
  { table: "plat_organizations", column: "bedrockAccessKeyId", type: "TEXT" },
  { table: "plat_organizations", column: "bedrockSecretCiphertext", type: "TEXT" },
  { table: "plat_organizations", column: "bedrockSecretHint", type: "TEXT" },
];

// Indexes are already idempotent via IF NOT EXISTS — no existence check needed.
// The dashboard indexes stay OUT of schema.prisma on purpose: a schema-hash
// change makes the entrypoint's db push fallback drop populated gen_ tables.
const INDEXES: string[] = [
  `CREATE INDEX IF NOT EXISTS "EventLog_workflowId_actorKind_idx" ON "EventLog"("workflowId", "actorKind")`,
  `CREATE INDEX IF NOT EXISTS "EventLog_workflowId_caseId_eventRef_idx" ON "EventLog"("workflowId", "caseId", "eventRef")`,
  `CREATE INDEX IF NOT EXISTS "EventLog_workflowId_caseId_occurredAt_idx" ON "EventLog"("workflowId", "caseId", "occurredAt")`,
];

// Whole new tables (with their indexes), idempotent via IF NOT EXISTS. Mirrors
// the schema.prisma model exactly — including Prisma's generated index names —
// so a fresh `db push` install and an upgraded one are indistinguishable.
const TABLES: string[] = [
  // Domain-role mapping (PlatDomainRoleAssignment): who plays which model lane
  // in which workflow. Powers whoami.domainRoles + the To do "my roles" filter.
  `CREATE TABLE IF NOT EXISTS "plat_domain_role_assignments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "identityId" TEXT NOT NULL,
    "domainRole" TEXT NOT NULL,
    "grantedBy" TEXT,
    "grantedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "plat_domain_role_assignments_organizationId_workflowId_identityId_domainRole_key" ON "plat_domain_role_assignments"("organizationId", "workflowId", "identityId", "domainRole")`,
  `CREATE INDEX IF NOT EXISTS "plat_domain_role_assignments_organizationId_workflowId_idx" ON "plat_domain_role_assignments"("organizationId", "workflowId")`,
  `CREATE INDEX IF NOT EXISTS "plat_domain_role_assignments_organizationId_identityId_idx" ON "plat_domain_role_assignments"("organizationId", "identityId")`,
];

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
    `PRAGMA table_info("${table}")`,
  );
  return rows.some((r) => r.name === column);
}

/** Apply all additive upgrades. Idempotent; safe to call on every boot. */
export async function ensureSchemaUpgrades(): Promise<void> {
  // Tables first: a column upgrade may target a table introduced here.
  for (const sql of TABLES) {
    await prisma.$executeRawUnsafe(sql);
  }
  for (const { table, column, type } of COLUMNS) {
    if (await columnExists(table, column)) continue;
    await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${type}`);
  }
  for (const sql of INDEXES) {
    await prisma.$executeRawUnsafe(sql);
  }
}
