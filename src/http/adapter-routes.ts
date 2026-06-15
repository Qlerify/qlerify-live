// Authored-adapter routes (Part 2.3, Slice 2): view the generated body, generate/
// repair it with AI (key-gated, stop-and-show — never auto-runs), and configure
// the endpoint + credential KEY. Additive, mounted from registerRoutes. The secret
// is set into process.env (dev) and only the KEY is persisted to the sidecar; an
// encrypted-at-rest store drops in behind this later with no call-site change.

import type { FastifyInstance } from "fastify";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { registerAdapter } from "../packs/registry.js";
import { writeSidecar } from "../packs/sidecar.js";
import { createAuthoredAdapter } from "../packs/adapters/authored.js";
import { adapterCfg, authorAdapterBody } from "../packs/author.js";
import type { AdapterConfig, ProvMode } from "../packs/types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MODES: ProvMode[] = ["simulated", "recorded", "live"];

export function registerAdapterCodeRoutes(app: FastifyInstance): void {
  // View the current generated body source.
  app.get("/api/adapters/:id/code", async (req, reply) => {
    const cfg = adapterCfg((req.params as any).id);
    if (!cfg) return reply.code(404).send({ error: "NOT_FOUND" });
    let source = "";
    let exists = false;
    if (cfg.bodyPath) {
      const abs = isAbsolute(cfg.bodyPath) ? cfg.bodyPath : join(ROOT, cfg.bodyPath);
      if (existsSync(abs)) { source = readFileSync(abs, "utf8"); exists = true; }
    }
    return { id: cfg.id, kind: cfg.kind, bodyPath: cfg.bodyPath ?? null, source, exists, hasKey: !!process.env.ANTHROPIC_API_KEY };
  });

  // Generate / repair the body with AI. Key-gated; stop-and-show — it writes a NEW
  // unique-path body and re-registers the adapter, but does NOT run or promote it.
  app.post("/api/adapters/:id/code/generate", async (req, reply) => {
    const cfg = adapterCfg((req.params as any).id);
    if (!cfg) return reply.code(404).send({ error: "NOT_FOUND" });
    if (!process.env.ANTHROPIC_API_KEY) {
      return reply.code(400).send({ error: "NO_API_KEY", message: "ANTHROPIC_API_KEY not set — cannot author an adapter body" });
    }
    const errorReport = (req.body as any)?.errorReport;
    try {
      const r = await authorAdapterBody(cfg.id, typeof errorReport === "string" ? errorReport : undefined);
      return { ok: true, ...r };
    } catch (err: any) {
      return reply.code(400).send({ error: "GENERATE_FAILED", message: err?.message ?? String(err) });
    }
  });

  // Configure endpoint / mode / credential KEY (no secret here).
  app.put("/api/bc/:bc/adapter/:id/config", async (req, reply) => {
    const cfg = adapterCfg((req.params as any).id);
    if (!cfg) return reply.code(404).send({ error: "NOT_FOUND" });
    const body = (req.body ?? {}) as any;
    const next: AdapterConfig = {
      ...cfg,
      endpoint: typeof body.endpoint === "string" ? body.endpoint : cfg.endpoint,
      credentialsRef: typeof body.credentialsRef === "string" ? body.credentialsRef : cfg.credentialsRef,
      mode: (MODES.includes(body.mode) ? body.mode : cfg.mode) as ProvMode,
    };
    writeSidecar(next);
    if (next.bodyPath) registerAdapter(createAuthoredAdapter(next)); // re-register only if authored
    return {
      id: next.id, endpoint: next.endpoint ?? null, credentialsRef: next.credentialsRef ?? null, mode: next.mode,
      credentialPresent: !!(next.credentialsRef && process.env[next.credentialsRef]),
    };
  });

  // Set the secret for the credential KEY (dev: process.env; only the KEY persists).
  app.put("/api/bc/:bc/adapter/:id/credential", async (req, reply) => {
    const cfg = adapterCfg((req.params as any).id);
    if (!cfg) return reply.code(404).send({ error: "NOT_FOUND" });
    const body = (req.body ?? {}) as any;
    const ref = (typeof body.credentialsRef === "string" && body.credentialsRef) ? body.credentialsRef : cfg.credentialsRef;
    if (!ref) return reply.code(400).send({ error: "NO_REF", message: "credentialsRef required" });
    if (typeof body.secret !== "string" || !body.secret) return reply.code(400).send({ error: "NO_SECRET", message: "secret required" });
    process.env[ref] = body.secret;                // dev only; encrypted store is the next increment
    writeSidecar({ ...cfg, credentialsRef: ref }); // KEY only — never the secret
    return { credentialPresent: true, credentialsRef: ref };
  });
}
