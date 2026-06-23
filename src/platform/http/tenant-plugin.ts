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
// Auth is DENY-BY-DEFAULT: every request must authenticate. The only public
// paths are (a) the /v1/auth/* endpoints (they run their own credential check)
// and (b) the static web shell (index.html, app.js, …) — the browser must load
// it to render the login screen. A request with no credentials is rejected with
// 401; there is no header-less single-tenant demo default.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { isHandledError } from "../../errors.js";
import { resolveTenantContext, type AuthnHeaders } from "../authn/index.js";
import { ensureWorkflowModelLoaded } from "../ontology-store/ontology-store.js";
import { enterTenant } from "../tenancy/context.js";
import type { TenantContext } from "../types.js";

/** Public paths that skip tenant resolution. Deny-by-default: a new API route is
 * auth-gated automatically; only the auth endpoints and real static-shell files
 * are exempt. (Exempting a *missing* static file would be an availability bug,
 * not a security hole — every API path stays protected regardless.) */
function isPublicPath(req: FastifyRequest, webRoot: string | undefined): boolean {
  const url = (req.url || "").split("?")[0];
  // Auth endpoints must stay reachable even with a stale/expired/garbage bearer
  // token: they run their own credential check and never read requireTenant().
  if (url.startsWith("/v1/auth/")) return true;
  // The static web shell is public so the browser can load it and render the
  // login screen; every data fetch it then makes is auth-gated and 401s until
  // sign-in (the api() wrapper redirects to #login on a 401).
  if (!webRoot) return false;
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const rel = url === "/" ? "index.html" : url.replace(/^\/+/, "");
  if (!rel || rel.includes("..")) return false;
  return existsSync(join(webRoot, rel));
}

export function registerTenantPlugin(app: FastifyInstance, webRoot?: string) {
  app.addHook("onRequest", async (req: FastifyRequest, reply) => {
    if (isPublicPath(req, webRoot)) return;
    const headers = req.headers as AuthnHeaders;
    try {
      const ctx = await resolveTenantContext(headers);
      (req as any).tenant = ctx;
      // Bind the active workflow's model BEFORE the handler so the synchronous
      // getOntology() resolves the right model. A workflow with no model yet loads
      // nothing → getOntology() throws ModelNotLoadedError and the UI prompts to
      // set one. With no active workflow (empty org) there is nothing to load.
      if (ctx.workflowId) {
        await ensureWorkflowModelLoaded(ctx.organizationId, ctx.workflowId);
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
