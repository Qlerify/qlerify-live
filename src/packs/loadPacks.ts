// Pack loader (Part 2.2). Discovers packs under src/packs/<dir>/pack.manifest.json
// and registers their adapters. DYNAMIC import (never a static boot import), so:
//   (1) adding a pack folder needs no edit to any barrel, and
//   (2) a broken pack can't crash boot — it's skipped, fail-soft.
// Re-runnable (idempotent registration). This is the seam that forces src/packs/
// into existence; commands/widgets/ingestion layers join the same Pack later.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerAdapter, clearAdapters } from "./registry.js";
import { listSidecars } from "./sidecar.js";
import { createAuthoredAdapter } from "./adapters/authored.js";
import { createSimulatedAdapter } from "./adapters/simulated.js";
import { createConnectorAdapter } from "./adapters/connector.js";
import type { Pack } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));

interface PackManifest {
  name: string;
  entry?: string; // default "index.js"
  description?: string;
  sourceSystem?: string;
}

interface Logger {
  warn: (obj: unknown, msg?: string) => void;
}

export async function loadPacks(log?: Logger): Promise<number> {
  clearAdapters();
  let count = 0;
  let entries: string[];
  try {
    entries = readdirSync(here);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const dir = join(here, name);
    const manifestPath = join(dir, "pack.manifest.json");
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PackManifest;
      const entry = manifest.entry ?? "index.js";
      // No-build repo: the entry exists as .ts on disk; prefer it, fall back to
      // a compiled .js for a future build. import() the absolute file URL.
      const tsPath = join(dir, entry.replace(/\.js$/, ".ts"));
      const target = existsSync(tsPath) ? tsPath : join(dir, entry);
      const mod = (await import(/* @vite-ignore */ pathToFileURL(target).href)) as { pack?: Pack };
      const pack = mod.pack;
      if (!pack?.adapters?.length) continue;
      for (const adapter of pack.adapters) {
        registerAdapter(adapter);
        count++;
      }
    } catch (err) {
      log?.warn?.({ err, pack: name }, "pack failed to load (skipped)");
    }
  }

  // Adapters from sidecars (.qlerify/adapters/<id>.json). These are the source of
  // truth for adapter STATE (a "Connect a system" draft, a reset, or an authored
  // adapter), so they OVERRIDE the code-pack defaults registered above. Authored
  // registration is LAZY (createAuthoredAdapter does NOT import the body), so a
  // broken body can never poison boot. Per-sidecar try/catch so one malformed
  // sidecar can't abort the rest (Trap 1 from the design review).
  // Defense in depth for the one-connector-per-table invariant: never let the
  // registry hold two CONNECTORS for the same (workflow, system, table). New dupes
  // are blocked at createConnector; this collapses any that already exist on disk,
  // keeping one deterministically (lowest id) and warning about the rest.
  const sidecars = listSidecars();
  const seenTargets = new Set<string>();
  const skip = new Set<string>();
  for (const cfg of [...sidecars].filter((c) => c.kind === "connector").sort((a, b) => a.id.localeCompare(b.id))) {
    const key = `${cfg.workflowId ?? ""}::${cfg.boundedContext}::${cfg.targetEntity}`;
    if (seenTargets.has(key)) {
      skip.add(cfg.id);
      log?.warn?.({ adapter: cfg.id, target: cfg.targetEntity }, "duplicate connector for table — skipped (one-per-table)");
    } else {
      seenTargets.add(key);
    }
  }
  for (const cfg of sidecars) {
    if (skip.has(cfg.id)) continue;
    try {
      registerAdapter(
        cfg.kind === "connector"
          ? createConnectorAdapter(cfg) // Part 2.4: isolated-subprocess connector (lazy — code runs only on pull)
          : cfg.kind === "authored"
            ? createAuthoredAdapter(cfg)
            : createSimulatedAdapter({ id: cfg.id, boundedContext: cfg.boundedContext, targetEntity: cfg.targetEntity }),
      );
      count++;
    } catch (err) {
      log?.warn?.({ err, adapter: cfg.id }, "adapter sidecar failed to register (skipped)");
    }
  }
  return count;
}
