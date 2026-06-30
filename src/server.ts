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
import { isHandledError } from "./errors.js";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..", "web");

export async function buildServer() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  await app.register(cors, { origin: true });

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
