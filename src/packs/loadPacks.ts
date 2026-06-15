// Pack loader (Part 2.2). Discovers packs under src/packs/<dir>/pack.manifest.json
// and registers their adapters. DYNAMIC import (never a static boot import), so:
//   (1) adding a pack folder needs no edit to any barrel, and
//   (2) a broken pack can't crash boot — it's skipped, fail-soft.
// Re-runnable on onOntologyReload. This is the seam that forces src/packs/ into
// existence; commands/widgets/ingestion layers join the same Pack later.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerAdapter, clearAdapters } from "./registry.js";
import { listSidecars } from "./sidecar.js";
import { createAuthoredAdapter } from "./adapters/authored.js";
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

  // Authored adapters from sidecars (.qlerify/adapters/<id>.json with
  // kind:"authored"). Registration is LAZY — createAuthoredAdapter does NOT import
  // the body, so a broken body can never poison boot. Per-sidecar try/catch so one
  // malformed sidecar can't abort the rest (Trap 1 from the design review).
  for (const cfg of listSidecars()) {
    if (cfg.kind !== "authored") continue;
    try {
      registerAdapter(createAuthoredAdapter(cfg));
      count++;
    } catch (err) {
      log?.warn?.({ err, adapter: cfg.id }, "authored adapter failed to register (skipped)");
    }
  }
  return count;
}
