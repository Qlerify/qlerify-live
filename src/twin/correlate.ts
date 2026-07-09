// Model-driven case correlation.
//
// A "case" is one end-to-end run of a workflow. Its id (EventLog.caseId) is the
// id of the instance that STARTED the run — the first aggregate created. A single
// case can span SEVERAL aggregate roots: the workflow moves from aggregate A into
// aggregate B, and B's events must stay attached to the SAME case as A.
//
// The simulator pins this explicitly (bus.withScope), so its runs never break.
// The break happens on the DERIVE / fallback path — events reconstructed from
// ingested rows, or a one-off command dispatched outside a run — where each
// aggregate would otherwise be scoped to its OWN id and start a separate case,
// fragmenting one real-world case into one-per-aggregate.
//
// This module reconnects them with a model-agnostic heuristic: if the aggregate
// we are moving into carries a foreign-key reference back to an aggregate that is
// already part of a case, it belongs to that same case. Because the parent was
// correlated the same way, inheriting its caseId transitively walks all the way
// back to the case root. Nothing here is workflow-specific: the FK relationships
// come entirely from the loaded model.
//
// SHAPE (mirrors twin/derive.ts): decideCaseId() is the PURE model-driven core —
// given the model, the aggregate, its payload, and a resolver from instance-id to
// caseId, it returns the case with no DB or I/O. correlateCaseId() is the thin
// wrapper: it batches the one EventLog lookup (tenant-scoped) the resolver needs.

import { prisma } from "../db.js";
import { getOntology, type Ontology } from "../ontology/model.js";
import { eventLogOrgWhere } from "../platform/tenancy/event-scope.js";

/** The entity an `<name>Id` field points at (the FK-by-name heuristic, shared
 * with the simulator's arg-linking). Matched case-insensitively so acronym
 * entities resolve too — "gprId" → "GPR", "soaId" → "SoA" — and the entity's
 * REAL name is returned. Undefined when the field isn't `*Id`-shaped or no
 * entity matches. */
export function fkTargetEntity(fieldName: string, ont: Ontology): string | undefined {
  const m = /^(.+)Id$/.exec(fieldName);
  if (!m) return undefined;
  const want = m[1]!.toLowerCase();
  return ont.entities.find((e) => e.name.toLowerCase() === want)?.name;
}

/** Foreign-key fields on `aggregateRoot` that point at ANOTHER aggregate entity,
 * resolved from the model: a field whose declared `relatedEntity` is an entity,
 * or an `<name>Id` field whose `<Name>` is an entity (the FK-by-name heuristic,
 * the same one the simulator uses to link args). The aggregate's own surrogate
 * `id` is never an FK, and a self-reference is ignored. References that point
 * straight at the case ROOT aggregate are tried first — that's the spine of the
 * case — so a row linking to several aggregates prefers the most direct anchor. */
export function foreignKeyFields(aggregateRoot: string, ont: Ontology): Array<{ name: string; target: string }> {
  const entity = ont.entity(aggregateRoot);
  if (!entity) return [];
  const root = ont.rootAggregate;
  const out: Array<{ name: string; target: string }> = [];
  for (const f of entity.fields) {
    if (f.name === "id") continue;
    let target: string | undefined;
    if (f.relatedEntity && ont.entity(f.relatedEntity)) {
      target = f.relatedEntity;
    } else {
      target = fkTargetEntity(f.name, ont);
    }
    if (target && target !== aggregateRoot) out.push({ name: f.name, target });
  }
  out.sort((a, b) => Number(b.target === root) - Number(a.target === root));
  return out;
}

/** PURE correlation decision. Given the model, the aggregate being scoped, its
 * payload, and `caseOf` (an instance-id → caseId resolver over already-recorded
 * events), decide the caseId:
 *
 *  1. An explicit `caseId` in the payload always wins.
 *  2. The root aggregate starts its own case (caseId = its own id).
 *  3. An instance already attached to a case keeps that case (idempotent
 *     re-derive; a later event on an aggregate whose create already correlated).
 *  4. Otherwise follow a foreign-key reference back to a parent aggregate already
 *     in a case, and inherit it.
 *  5. With no resolvable link, start a fresh case (its own id).
 *
 * No DB or I/O — that's correlateCaseId()'s job. */
export function decideCaseId(
  ont: Ontology,
  aggregateRoot: string,
  aggregateId: string,
  payload: Record<string, unknown>,
  caseOf: (instanceId: string) => string | null,
): string | null {
  if (typeof payload.caseId === "string" && payload.caseId) return payload.caseId;
  if (!aggregateId) return null;
  if (aggregateRoot === ont.rootAggregate) return aggregateId;

  const self = caseOf(aggregateId);
  if (self) return self;

  for (const fk of foreignKeyFields(aggregateRoot, ont)) {
    const ref = payload[fk.name];
    if (typeof ref !== "string" || !ref) continue;
    const parentCase = caseOf(ref);
    if (parentCase) return parentCase;
  }

  return aggregateId;
}

/** The caseId an aggregate instance belongs to (the thin I/O wrapper around
 * decideCaseId). Resolves `caseOf` with ONE tenant-scoped EventLog lookup over
 * the candidate ids — the instance itself plus the FK references its payload
 * carries — so it never correlates across orgs/workflows. */
export async function correlateCaseId(
  aggregateRoot: string,
  aggregateId: string,
  payload: Record<string, unknown>,
): Promise<string | null> {
  if (typeof payload.caseId === "string" && payload.caseId) return payload.caseId;
  if (!aggregateId) return null;

  let ont: Ontology;
  try {
    ont = getOntology();
  } catch {
    return aggregateId; // no model loaded → degrade to per-aggregate scoping
  }
  if (aggregateRoot === ont.rootAggregate) return aggregateId;

  // Candidate instance ids whose case we might inherit: this aggregate itself,
  // plus every FK reference the payload carries.
  const candidates = new Set<string>([aggregateId]);
  for (const fk of foreignKeyFields(aggregateRoot, ont)) {
    const ref = payload[fk.name];
    if (typeof ref === "string" && ref) candidates.add(ref);
  }

  const rows = await prisma.eventLog.findMany({
    where: { aggregateId: { in: [...candidates] }, caseId: { not: null }, ...eventLogOrgWhere() },
    orderBy: { occurredAt: "asc" },
    select: { aggregateId: true, caseId: true },
  });
  const caseByInstance = new Map<string, string>();
  for (const r of rows) {
    if (r.aggregateId && r.caseId && !caseByInstance.has(r.aggregateId)) caseByInstance.set(r.aggregateId, r.caseId);
  }

  return decideCaseId(ont, aggregateRoot, aggregateId, payload, (id) => caseByInstance.get(id) ?? null);
}
