// Audit log (spec §17) — append-only, per-organization, hash-chained.
//
// "Immutable" is engineered, not declared. Each event carries the hash of the
// previous event in its org's stream, so any tampering (edit, delete, reorder)
// breaks the chain and is detectable by recomputation (verifyAuditChain). The
// application role is never granted UPDATE/DELETE on plat_audit_events.
//
// Increment-1 scope vs §17: tamper-EVIDENT now (hash chain). Tamper-PROOF later
// — WORM / object-lock storage and external SIEM export are deferred. Writes are
// serialized PER ORG (an in-process promise queue) so two concurrent mutations
// can't assign the same seq or race the prev-hash; on the single SQLite writer
// this is sufficient. Same-transaction-as-the-mutation is the Postgres-era
// hardening.

import { prisma } from "../../db.js";
import { newId, sha256 } from "../ids.js";

interface AuditInput {
  organizationId: string;
  actorPrincipalId?: string | null;
  action: string;
  targetRef?: string | null;
  decision?: "allow" | "deny" | null;
  reason?: string | null;
  // The surface that drove the action (human/ai/system/adapter). Supplementary
  // attribution for governance analytics (guardrail-block-rate). Deliberately
  // OUTSIDE the hash material: adding it there would invalidate every pre-existing
  // chain. Integrity stays on principal + action + decision + reason.
  actorKind?: string | null;
}

interface ChainRow {
  organizationId: string;
  streamId: string;
  seq: number;
  prevHash: string | null;
  actorPrincipalId: string | null;
  action: string;
  targetRef: string | null;
  decision: string | null;
  reason: string | null;
  occurredAt: Date;
}

/** Deterministic material hashed into the chain — must be byte-identical between
 * append and verify, so it is derived only from stored fields. */
function material(row: ChainRow): string {
  return JSON.stringify({
    organizationId: row.organizationId,
    streamId: row.streamId,
    seq: row.seq,
    prevHash: row.prevHash ?? null,
    actorPrincipalId: row.actorPrincipalId ?? null,
    action: row.action,
    targetRef: row.targetRef ?? null,
    decision: row.decision ?? null,
    reason: row.reason ?? null,
    occurredAt: row.occurredAt.toISOString(),
  });
}

function hashRow(row: ChainRow): string {
  return sha256((row.prevHash ?? "") + "\n" + material(row));
}

// Per-org serialization queue: keeps appends to one stream strictly ordered.
const chains = new Map<string, Promise<unknown>>();

function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn); // run regardless of the previous append's outcome
  chains.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/** Append one audit event to its org's chain. Returns the assigned seq + hash. */
export function recordAudit(input: AuditInput): Promise<{ seq: number; thisHash: string }> {
  const streamId = input.organizationId; // one stream per org in inc 1
  return serialize(streamId, async () => {
    const last = await prisma.platAuditEvent.findFirst({
      where: { organizationId: input.organizationId, streamId },
      orderBy: { seq: "desc" },
      select: { seq: true, thisHash: true },
    });
    const row: ChainRow = {
      organizationId: input.organizationId,
      streamId,
      seq: (last?.seq ?? -1) + 1,
      prevHash: last?.thisHash ?? null,
      actorPrincipalId: input.actorPrincipalId ?? null,
      action: input.action,
      targetRef: input.targetRef ?? null,
      decision: input.decision ?? null,
      reason: input.reason ?? null,
      occurredAt: new Date(),
    };
    const thisHash = hashRow(row);
    // actorKind is stored but NOT part of `row`/the hash material (see AuditInput).
    await prisma.platAuditEvent.create({ data: { id: newId(), ...row, thisHash, actorKind: input.actorKind ?? null } });
    return { seq: row.seq, thisHash };
  });
}

interface ChainVerification {
  ok: boolean;
  length: number;
  brokenAtSeq?: number;
}

/** Recompute an org's chain end-to-end; ok=false (with brokenAtSeq) on any
 * tampering — a gap, a hash mismatch, or a broken prev-link. */
export async function verifyAuditChain(organizationId: string): Promise<ChainVerification> {
  const rows = await prisma.platAuditEvent.findMany({
    where: { organizationId, streamId: organizationId },
    orderBy: { seq: "asc" },
  });
  let prevHash: string | null = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.seq !== i) return { ok: false, length: rows.length, brokenAtSeq: r.seq };
    const recomputed = hashRow({
      organizationId: r.organizationId,
      streamId: r.streamId,
      seq: r.seq,
      prevHash: r.prevHash ?? null,
      actorPrincipalId: r.actorPrincipalId ?? null,
      action: r.action,
      targetRef: r.targetRef ?? null,
      decision: r.decision ?? null,
      reason: r.reason ?? null,
      occurredAt: r.occurredAt,
    });
    if ((r.prevHash ?? null) !== prevHash || recomputed !== r.thisHash) {
      return { ok: false, length: rows.length, brokenAtSeq: r.seq };
    }
    prevHash = r.thisHash;
  }
  return { ok: true, length: rows.length };
}
