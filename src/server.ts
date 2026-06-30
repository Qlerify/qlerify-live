import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

import { registerRoutes } from "./http/routes.js";
import { loadPacks } from "./packs/loadPacks.js";
import { getMeta, setMeta } from "./twin/projection-store.js";
import { dataModelSignature } from "./twin/sim.js";
import { prisma } from "./db.js";
import { registerTenantPlugin } from "./platform/http/tenant-plugin.js";
import { registerControlRoutes } from "./platform/http/control-routes.js";
import { seedPlatform } from "./platform/provisioning/index.js";
import { ensureSchemaUpgrades } from "./platform/db/schema-upgrade.js";
import { isHandledError } from "./errors.js";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..", "web");

// Content-Security-Policy — defense-in-depth behind output escaping. script-src
// has NO 'unsafe-inline', so injected <script> and inline event handlers
// (onerror=, onclick=) cannot run even if an escaping sink is ever missed; foreign
// script origins are blocked. 'unsafe-eval' + the Tailwind Play CDN are required
// by its in-browser JIT; Google Fonts + the page's inline <style> need the style
// allowances. All data fetches are same-origin (connect-src 'self').
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval' https://cdn.tailwindcss.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.tailwindcss.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join("; ");

export async function buildServer() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  await app.register(cors, { origin: true });

  // Security headers on every response (static shell + API). CSP is the big one;
  // nosniff + a tight referrer policy round it out.
  app.addHook("onRequest", (_req, reply, done) => {
    reply.header("Content-Security-Policy", CSP);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    done();
  });

  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot, prefix: "/" });
  }

  // Multi-tenant control plane: seed platform basics (built-in roles + the
  // superuser; remove any legacy system org) BEFORE serving, then bind a tenant
  // context to every request (org_id derived from identity, never from client
  // input). Requests must authenticate — there is no header-less demo and no
  // system org; the static web shell is the only public surface so the login
  // screen can load. A fresh install has zero orgs: the superuser signs in and
  // creates the first one.
  // Apply additive schema upgrades (new columns on EventLog / the audit log)
  // before anything reads or writes them — seedPlatform may record audit rows.
  // Idempotent + push-free, so it never drops the runtime gen_ tables.
  await ensureSchemaUpgrades();
  try {
    await seedPlatform();
  } catch (err) {
    app.log.error({ err }, "platform seed failed — sign-in/provisioning may be unavailable until fixed");
  }
  registerTenantPlugin(app, webRoot);

  // Uniform error mapping — a safety net for routes that let a handled error
  // bubble (e.g. GET query routes with no local try/catch). Keeps NoActiveWorkflow
  // and friends as clean 4xx instead of a default 500. Real infra errors → 500.
  app.setErrorHandler((err, req, reply) => {
    if (isHandledError(err)) {
      return reply.code(err.status).send({ error: err.code, message: err.message, violations: (err as any).violations });
    }
    const status = (err as any)?.statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, "unhandled error"); // keep Fastify's default observability
    return reply.code(status).send({ error: (err as any)?.code ?? "INTERNAL", message: (err as any)?.message });
  });

  registerRoutes(app);
  registerControlRoutes(app);

  // Discover + register source-system packs (additive, fail-soft, dynamic import).
  try {
    const n = await loadPacks(app.log);
    app.log.info(`loaded ${n} adapter(s) from packs`);
  } catch (err) {
    app.log.warn({ err }, "pack loading skipped");
  }

  // Claim the existing transactional data for the currently-loaded model if it
  // isn't marked yet, so a later switch to a DIFFERENT model is detected and
  // triggers a clean-slate rebuild (instead of showing the previous model's rows).
  try {
    if ((await getMeta("dataModel")) === null) await setMeta("dataModel", dataModelSignature());
  } catch (err) {
    app.log.warn({ err }, "data-model marker init skipped");
  }
  return app;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const port = Number(process.env.PORT ?? 3001);
  const host = process.env.HOST ?? "0.0.0.0";
  buildServer().then(async (app) => {
    try {
      await app.listen({ port, host });
      app.log.info(`server listening on http://${host}:${port}`);
    } catch (err) {
      app.log.error(err);
      await prisma.$disconnect();
      process.exit(1);
    }
  });
}
