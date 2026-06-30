// Adapter lifecycle routes: reset an adapter to a clean simulated draft, remove
// it entirely, and set the secret for its credential KEY. Additive, mounted from
// registerRoutes. Every mutation is gated behind guardData (kill-switch + PDP) and
// tenant ownership (ownsAdapterId) so one tenant cannot touch another's adapter by
// id. The secret is set into process.env (dev) and only the KEY is persisted to
// the sidecar; an encrypted-at-rest store drops in behind this later with no
// call-site change.

import type { FastifyInstance } from "fastify";
import { getAdapter } from "../packs/registry.js";
import { writeSidecar } from "../packs/sidecar.js";
import { adapterCfg, resetAdapter, removeAdapter } from "../packs/author.js";
import { guardData } from "../platform/authz.js";
import { ownsAdapterId } from "../packs/ownership.js";

export function registerAdapterCodeRoutes(app: FastifyInstance): void {
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
