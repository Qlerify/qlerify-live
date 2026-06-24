// Per-bounded-context projections over an ontology. Pure (the ontology is passed
// in, never read from global state) so they can be unit-tested against an inline
// model and reused anywhere — the BC workbench routes and the Systems health
// board both derive a BC's owned entities/value objects from here.

import type { Ontology, EntitySchema, OntologyEvent } from "./model.js";

/** Events declared in a bounded context. */
export function eventsForBc(ont: Ontology, bc: string): OntologyEvent[] {
  return ont.events.filter((e) => e.boundedContext === bc);
}

/** Entities a BC owns = the aggregate roots of its events. */
export function entitiesForBc(ont: Ontology, bc: string): EntitySchema[] {
  const roots = new Set(eventsForBc(ont, bc).map((e) => e.aggregateRoot).filter(Boolean));
  return ont.entities.filter((e) => roots.has(e.name));
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
