// The tenant plugin — the single entry point where every request is bound to a
// tenant context (spec §11). org_id is derived from the request's identity →
// active membership and bound in AsyncLocalStorage for the handler. No handler
// downstream reads org identity from input.
//
// Two hooks, deliberately split:
//   onRequest (async)  — resolve the context (DB lookups) and stash it on req;
//                        reject the request on an auth failure.
//   preHandler (sync)  — bind the context with als.enterWith RIGHT BEFORE the
//                        handler. This runs AFTER Fastify's async body-parsing
//                        hop, so there is no async boundary between enterWith and
//                        the handler — which is exactly what makes the binding
//                        reliable (enterWith in the async onRequest hook is lost
//                        across the POST body-parse hop).
//
// The existing demo's header-less requests authenticate as the seeded system
// identity (no TENANCY=off bypass); that common context is cached so static
// assets and demo calls don't pay three DB round-trips each.

import type { FastifyInstance, FastifyRequest } from "fastify";
import { isHandledError } from "../../errors.js";
import { resolveTenantContext, type AuthnHeaders } from "../authn/index.js";
import { SYSTEM_PROJECT_ID } from "../ids.js";
import { ensureProjectModelLoaded } from "../ontology-store/ontology-store.js";
import { enterTenant } from "../tenancy/context.js";
import type { TenantContext } from "../types.js";

let cachedSystemCtx: TenantContext | undefined;

function hasCredentials(h: AuthnHeaders): boolean {
  // X-Project-Id counts: a request that selects a project must go through full
  // resolution (and project-model loading), not the cached system context.
  return !!(h.authorization || h["x-identity-subject"] || h["x-org-id"] || h["x-org-slug"] || h["x-project-id"]);
}

export function registerTenantPlugin(app: FastifyInstance) {
  app.addHook("onRequest", async (req: FastifyRequest, reply) => {
    // Auth endpoints must stay reachable even with a stale/expired/garbage bearer
    // token in the request: they run their own credential check and never read
    // requireTenant(). Skipping resolution here is what prevents an expired
    // session from locking a user out of /v1/auth/login.
    if ((req.url || "").startsWith("/v1/auth/")) return;
    const headers = req.headers as AuthnHeaders;
    try {
      if (!hasCredentials(headers) && cachedSystemCtx) {
        (req as any).tenant = cachedSystemCtx;
        return;
      }
      const ctx = await resolveTenantContext(headers);
      if (!hasCredentials(headers)) cachedSystemCtx = ctx;
      (req as any).tenant = ctx;
      // Bind the active project's model BEFORE the handler so the synchronous
      // getOntology() resolves the right model. The system default project reads
      // from disk, so there is nothing to load for it.
      if (ctx.projectId && ctx.projectId !== SYSTEM_PROJECT_ID) {
        await ensureProjectModelLoaded(ctx.organizationId, ctx.projectId);
      }
    } catch (err) {
      if (isHandledError(err)) {
        return reply.code(err.status).send({ error: err.code, message: err.message });
      }
      req.log.error({ err }, "tenant resolution failed");
      return reply.code(401).send({ error: "UNAUTHENTICATED", message: (err as Error).message });
    }
  });

  // Bind the resolved context for the handler's async context. Sync + last hook
  // before the handler ⇒ enterWith propagates reliably (no async hop in between).
  app.addHook("preHandler", (req: FastifyRequest, _reply, done) => {
    const ctx = (req as any).tenant as TenantContext | undefined;
    if (ctx) enterTenant(ctx);
    done();
  });
}

/** Test-only: drop the cached system context (e.g. after re-seeding). */
export function _resetTenantCache(): void {
  cachedSystemCtx = undefined;
}
