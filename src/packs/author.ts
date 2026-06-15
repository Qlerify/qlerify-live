// Orchestrates "author / repair an adapter body": resolve the adapter's config,
// generate the body via AI (unique-path, deny-scanned), persist the sidecar, and
// re-register the adapter. Shared by the HTTP code/generate route and the chat
// Connection Doctor so both behave identically (stop-and-show: this writes +
// registers a new body but never runs or promotes it).

import { getAdapter, registerAdapter } from "./registry.js";
import { readSidecar, writeSidecar } from "./sidecar.js";
import { createAuthoredAdapter } from "./adapters/authored.js";
import { generateAdapterBody, type GenerateResult } from "./codegen/adapter-ai.js";
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
