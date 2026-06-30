// Authored-adapter routes (Part 2.3, Slice 2): view the generated body, generate/
// repair it with AI (key-gated, stop-and-show — never auto-runs), and configure
// the endpoint + credential KEY. Additive, mounted from registerRoutes. The secret
// is set into process.env (dev) and only the KEY is persisted to the sidecar; an
// encrypted-at-rest store drops in behind this later with no call-site change.

import type { FastifyInstance } from "fastify";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { registerAdapter, getAdapter } from "../packs/registry.js";
import { writeSidecar, readSidecar } from "../packs/sidecar.js";
import { createAuthoredAdapter } from "../packs/adapters/authored.js";
import { createSimulatedAdapter } from "../packs/adapters/simulated.js";
import { adapterCfg, authorAdapterBody, resetAdapter, removeAdapter } from "../packs/author.js";
import { getOntology } from "../ontology/model.js";
import { resolveAnthropicStatus } from "../llm/anthropic.js";
import { guardData } from "../platform/authz.js";
import { ownsAdapterId } from "../packs/ownership.js";
import { connectorOwner } from "../packs/connector/orchestrate.js";
import type { AdapterConfig, ProvMode } from "../packs/types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MODES: ProvMode[] = ["simulated", "recorded", "live"];

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function registerAdapterCodeRoutes(app: FastifyInstance): void {
  // Bootstrap the FIRST adapter for a bounded context that has none. Creates a
  // SIMULATED adapter (the bottom of the mode ladder — runs immediately with
  // synthesized rows), persists a sidecar, and registers it. The workbench then
  // drives Configure → Generate (AI) → Test → Ingest to climb to recorded/live.
  app.post("/api/bc/:bc/adapter", async (req, reply) => {
    await guardData("connector.edit");
    const o = getOntology();
    const raw = (req.params as any).bc;
    const bc = o.boundedContexts.find((b) => b.toLowerCase() === String(raw).toLowerCase());
    if (!bc) return reply.code(404).send({ error: "UNKNOWN_BC" });
    const body = (req.body ?? {}) as any;
    const targetEntity =
      (typeof body.targetEntity === "string" && body.targetEntity) ||
      o.events.find((e) => e.boundedContext === bc && e.aggregateRoot)?.aggregateRoot;
    if (!targetEntity || !o.entity(targetEntity)) {
      return reply.code(400).send({ error: "NO_ENTITY", message: "targetEntity required and must exist in the model" });
    }
    const id = slug(typeof body.id === "string" && body.id ? body.id : `${bc}-${targetEntity}`);
    if (getAdapter(id) || readSidecar(id)) {
      return reply.code(409).send({ error: "EXISTS", message: `adapter "${id}" already exists` });
    }
    // Stamp the owning (org, workflow) so the adapter is tenant-isolated from
    // creation — without this an authored/simulated adapter is unstamped and
    // reachable cross-tenant via its id (the F-06 disclosure family).
    const cfg: AdapterConfig = { id, kind: "simulated", boundedContext: bc, targetEntity, phase: "draft", mode: "simulated", ...connectorOwner() };
    writeSidecar(cfg);
    registerAdapter(createSimulatedAdapter({ id, boundedContext: bc, targetEntity }));
    return { ok: true, id, boundedContext: bc, targetEntity, kind: "simulated", mode: "simulated" };
  });

  // View the current generated body source. Gated behind connector.read (so the
  // kill-switch covers this disclosure too) and tenant ownership (so one tenant
  // cannot read another's connector source by id — F-06).
  app.get("/api/adapters/:id/code", async (req, reply) => {
    const id = (req.params as any).id;
    await guardData("connector.read");
    if (!ownsAdapterId(id)) return reply.code(404).send({ error: "NOT_FOUND" });
    const cfg = adapterCfg(id);
    if (!cfg) return reply.code(404).send({ error: "NOT_FOUND" });
    let source = "";
    let exists = false;
    if (cfg.bodyPath) {
      const abs = isAbsolute(cfg.bodyPath) ? cfg.bodyPath : join(ROOT, cfg.bodyPath);
      if (existsSync(abs)) { source = readFileSync(abs, "utf8"); exists = true; }
    }
    return { id: cfg.id, kind: cfg.kind, bodyPath: cfg.bodyPath ?? null, source, exists, hasKey: (await resolveAnthropicStatus()).configured };
  });

  // Generate / repair the body with AI. Key-gated; stop-and-show — it writes a NEW
  // unique-path body and re-registers the adapter, but does NOT run or promote it.
  app.post("/api/adapters/:id/code/generate", async (req, reply) => {
    const id = (req.params as any).id;
    await guardData("connector.build"); // authoring code = special access (org admin)
    if (!ownsAdapterId(id)) return reply.code(404).send({ error: "NOT_FOUND" });
    const cfg = adapterCfg(id);
    if (!cfg) return reply.code(404).send({ error: "NOT_FOUND" });
    if (!(await resolveAnthropicStatus()).configured) {
      return reply.code(400).send({ error: "NO_API_KEY", message: "No Anthropic key — set your organization's key in Organisation admin, or the platform ANTHROPIC_API_KEY in .env" });
    }
    const errorReport = (req.body as any)?.errorReport;
    try {
      const r = await authorAdapterBody(cfg.id, typeof errorReport === "string" ? errorReport : undefined);
      return { ok: true, ...r };
    } catch (err: any) {
      return reply.code(400).send({ error: "GENERATE_FAILED", message: err?.message ?? String(err) });
    }
  });

  // Reset an adapter to a clean simulated draft (build from scratch). Deletes its
  // generated bodies + stored credentials; re-registers a simulated adapter.
  app.post("/api/adapters/:id/reset", async (req, reply) => {
    try {
      const id = (req.params as any).id;
      await guardData("connector.administer");
      // Same 404 for foreign-owned and unknown ids (no existence oracle).
      if (!ownsAdapterId(id) || !getAdapter(id)) return reply.code(404).send({ error: "NOT_FOUND" });
      return { ok: true, ...resetAdapter(id) };
    } catch (err: any) {
      return reply.code(404).send({ error: "NOT_FOUND", message: err?.message ?? String(err) });
    }
  });

  // Remove an adapter entirely (back to "Connect a system").
  app.delete("/api/adapters/:id", async (req, reply) => {
    try {
      const id = (req.params as any).id;
      await guardData("connector.administer");
      // Same 404 for foreign-owned and unknown ids (no existence oracle).
      if (!ownsAdapterId(id) || !getAdapter(id)) return reply.code(404).send({ error: "NOT_FOUND" });
      removeAdapter(id);
      return { ok: true, removed: id };
    } catch (err: any) {
      return reply.code(404).send({ error: "NOT_FOUND", message: err?.message ?? String(err) });
    }
  });

  // Configure endpoint / mode / credential KEY (no secret here).
  app.put("/api/bc/:bc/adapter/:id/config", async (req, reply) => {
    const id = (req.params as any).id;
    await guardData("connector.edit");
    if (!ownsAdapterId(id)) return reply.code(404).send({ error: "NOT_FOUND" });
    const cfg = adapterCfg(id);
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
    const id = (req.params as any).id;
    await guardData("connector.edit");
    if (!ownsAdapterId(id)) return reply.code(404).send({ error: "NOT_FOUND" });
    const cfg = adapterCfg(id);
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
