// Adapter sidecars — `.qlerify/adapters/<id>.json`. The persisted config the
// wizard (2.3) builds up as it climbs the mode ladder. Code-defined pack adapters
// (e.g. packs/sap) don't need a sidecar to register; wizard-created ones do. I/O
// mirrors the overlay/source-override pattern in sync.ts.

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { QLERIFY_DIR } from "../ontology/model.js";
import type { AdapterConfig } from "./types.js";

const ADAPTERS_DIR = join(QLERIFY_DIR, "adapters");

function pathFor(id: string): string {
  return join(ADAPTERS_DIR, `${id}.json`);
}

export function readSidecar(id: string): AdapterConfig | null {
  const p = pathFor(id);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as AdapterConfig;
  } catch {
    return null;
  }
}

export function writeSidecar(cfg: AdapterConfig): void {
  mkdirSync(ADAPTERS_DIR, { recursive: true });
  writeFileSync(pathFor(cfg.id), JSON.stringify(cfg, null, 2) + "\n");
}

export function listSidecars(): AdapterConfig[] {
  if (!existsSync(ADAPTERS_DIR)) return [];
  return readdirSync(ADAPTERS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(ADAPTERS_DIR, f), "utf8")) as AdapterConfig;
      } catch {
        return null;
      }
    })
    .filter((c): c is AdapterConfig => c != null);
}

/** Merge a patch into an EXISTING sidecar (never creates one implicitly, so a
 * code-defined pack adapter or a test doesn't litter `.qlerify/adapters`). */
export function touchSidecar(id: string, patch: Partial<AdapterConfig>): void {
  const cur = readSidecar(id);
  if (!cur) return;
  writeSidecar({ ...cur, ...patch });
}
