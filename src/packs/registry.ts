// In-process adapter registry (Part 2.2). Populated by loadPacks() at boot and on
// every ontology reload; read by the /api/adapters routes and the ingest path.

import type { SourceAdapter } from "./types.js";

const adapters = new Map<string, SourceAdapter>();

export function registerAdapter(adapter: SourceAdapter): void {
  adapters.set(adapter.id, adapter);
}

export function getAdapter(id: string): SourceAdapter | undefined {
  return adapters.get(id);
}

export function listAdapters(): SourceAdapter[] {
  return [...adapters.values()];
}

/** Reset the registry — called by loadPacks() before a fresh discovery pass. */
export function clearAdapters(): void {
  adapters.clear();
}
