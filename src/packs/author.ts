// Orchestrates "author / repair an adapter body": resolve the adapter's config,
// generate the body via AI (unique-path, deny-scanned), persist the sidecar, and
// re-register the adapter. Shared by the HTTP code/generate route and the chat
// Connection Doctor so both behave identically (stop-and-show: this writes +
// registers a new body but never runs or promotes it).

import { getAdapter, registerAdapter, unregisterAdapter } from "./registry.js";
import { readSidecar, writeSidecar, deleteSidecar } from "./sidecar.js";
import { createAuthoredAdapter } from "./adapters/authored.js";
import { createSimulatedAdapter } from "./adapters/simulated.js";
import { generateAdapterBody, deleteGeneratedBodies, type GenerateResult } from "./codegen/adapter-ai.js";
import type { AdapterConfig } from "./types.js";

/** The sidecar config for an adapter: the persisted one, else derived from the
 * registered adapter (so a code-pack simulated adapter can become authored). */
export function adapterCfg(id: string): AdapterConfig | null {
  const sc = readSidecar(id);
  if (sc) return sc;
  const a = getAdapter(id);
  if (!a) return null;
  return { id: a.id, kind: a.kind, boundedContext: a.boundedContext, targetEntity: a.targetEntity, phase: "draft", mode: a.mode };
}

export async function authorAdapterBody(id: string, errorReport?: string): Promise<GenerateResult> {
  const cfg = adapterCfg(id);
  if (!cfg) throw new Error(`no adapter "${id}"`);
  const authored: AdapterConfig = { ...cfg, kind: "authored", mode: cfg.mode === "simulated" ? "recorded" : cfg.mode, phase: "built" };
  const r = await generateAdapterBody(authored, errorReport);
  const next: AdapterConfig = { ...authored, bodyPath: r.bodyPath, bodyPromptHash: r.bodyPromptHash };
  writeSidecar(next);
  registerAdapter(createAuthoredAdapter(next)); // lazy — body imported on next run, not here
  return r;
}

/** Clear an adapter's in-process secret(s) (dev: process.env). */
function clearAdapterSecrets(cfg: AdapterConfig): void {
  if (cfg.credentialsRef && cfg.credentialsRef in process.env) delete process.env[cfg.credentialsRef];
  // (future: also clear per-field secrets resolved via the connection form)
}

/** Wipe an adapter back to a clean SIMULATED draft so it can be built from
 * scratch: delete its generated bodies + in-process secret, reset the sidecar to
 * just id/boundedContext/targetEntity, and re-register a simulated adapter (so the
 * workbench keeps running on synthesized data). Ingested rows are left untouched. */
export function resetAdapter(id: string): AdapterConfig {
  const cfg = adapterCfg(id);
  if (!cfg) throw new Error(`no adapter "${id}"`);
  deleteGeneratedBodies(cfg);
  clearAdapterSecrets(cfg);
  const fresh: AdapterConfig = {
    id: cfg.id, kind: "simulated", boundedContext: cfg.boundedContext, targetEntity: cfg.targetEntity,
    phase: "draft", mode: "simulated",
  };
  writeSidecar(fresh);
  registerAdapter(createSimulatedAdapter({ id: fresh.id, boundedContext: fresh.boundedContext, targetEntity: fresh.targetEntity }));
  return fresh;
}

/** Remove an adapter entirely: delete its generated bodies, secret, sidecar, and
 * registry entry. A code-pack adapter (defined in src/packs/<bc>/) reappears on
 * the next loadPacks/reboot — only its sidecar override is removed. */
export function removeAdapter(id: string): void {
  const cfg = adapterCfg(id);
  if (!cfg) throw new Error(`no adapter "${id}"`);
  deleteGeneratedBodies(cfg);
  clearAdapterSecrets(cfg);
  deleteSidecar(id);
  unregisterAdapter(id);
}
