// Per-bounded-context projections over an ontology. Pure (the ontology is passed
// in, never read from global state) so they can be unit-tested against an inline
// model and reused anywhere — the BC workbench routes and the Systems health
// board both derive a BC's owned entities/value objects from here.

import type { Ontology, EntitySchema, OntologyEvent } from "./model.js";

// Memoized: a health board asks every BC for its tables, and each ask would
// otherwise redo the topological sort.
const rankCache = new WeakMap<Ontology, Map<string, number>>();

/** Event key → position in the workflow's linear walk. */
export function eventRank(ont: Ontology): Map<string, number> {
  let ranks = rankCache.get(ont);
  if (!ranks) {
    ranks = new Map(ont.linearOrder().map((k, i) => [k, i]));
    rankCache.set(ont, ranks);
  }
  return ranks;
}

/** Events declared in a bounded context, in workflow order. */
export function eventsForBc(ont: Ontology, bc: string): OntologyEvent[] {
  const rank = eventRank(ont);
  return ont.events
    .filter((e) => e.boundedContext === bc)
    .sort((a, b) => (rank.get(a.key) ?? 0) - (rank.get(b.key) ?? 0));
}

/** Entities a BC owns = the aggregate roots of its events, first use first. */
export function entitiesForBc(ont: Ontology, bc: string): EntitySchema[] {
  const seen = new Set<string>();
  const owned: EntitySchema[] = [];
  for (const e of eventsForBc(ont, bc)) {
    if (!e.aggregateRoot || seen.has(e.aggregateRoot)) {
      continue;
    }
    const entity = ont.entity(e.aggregateRoot);
    if (entity) {
      seen.add(entity.name);
      owned.push(entity);
    }
  }
  return owned;
}

/** The entity whose raw rows the workbench shows by default (the first aggregate
 * root in the BC's events). */
export function defaultEntityForBc(ont: Ontology, bc: string): string | null {
  return eventsForBc(ont, bc).map((e) => e.aggregateRoot).find(Boolean) ?? null;
}

/** Value objects referenced by this BC's entities — listed as their own
 * populatable "tables" (a connector can fill a value object as its own table). */
export function valueObjectsForBc(ont: Ontology, bc: string): EntitySchema[] {
  const names = new Set<string>();
  for (const e of entitiesForBc(ont, bc)) {
    for (const f of e.fields) if (f.relatedEntity && ont.valueObject(f.relatedEntity)) names.add(f.relatedEntity);
  }
  return [...names].map((n) => ont.valueObject(n)).filter((v): v is EntitySchema => !!v);
}
