import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { existsSync, readdirSync } from "node:fs";

import { registerRoutes } from "./http/routes.js";
import { loadPacks } from "./packs/loadPacks.js";
import { getMeta, setMeta } from "./twin/projection-store.js";
import { dataModelSignature } from "./twin/sim.js";
import { prisma } from "./db.js";
import { registerTenantPlugin } from "./platform/http/tenant-plugin.js";
import { assertLlmBootConfig } from "./llm/anthropic.js";
import { registerControlRoutes } from "./platform/http/control-routes.js";
import { seedPlatform } from "./platform/provisioning/index.js";
import { ensureSchemaUpgrades } from "./platform/db/schema-upgrade.js";
import { isHandledError } from "./errors.js";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..", "web");

// Self-hosted Monaco editor (the connector "Code" tab). CSP forbids foreign script
// origins, so we serve Monaco's prebuilt AMD bundle from node_modules over the same
// origin under /vendor/monaco/ (public — it carries no tenant data, and bearer-token
// auth isn't sent on <script>/Worker subresource requests anyway). The bundle's base
// editor worker has a content-hashed filename; we resolve it once at boot so the
// frontend doesn't have to hardcode a hash that changes on every Monaco upgrade.
const requireFromHere = createRequire(import.meta.url);
function monacoMinDir(): string | null {
  try {
    return join(dirname(requireFromHere.resolve("monaco-editor/package.json")), "min");
  } catch {
    return null;
  }
}

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
  // CORS: the UI is served from this same origin (CSP pins connect-src 'self'),
  // so no cross-origin caller is allowed by default — browsers get no CORS
  // headers. CORS_ORIGIN (comma-separated origins) opts specific frontends in
  // per deployment.
  const corsOrigins = (process.env.CORS_ORIGIN ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  await app.register(cors, { origin: corsOrigins.length > 0 ? corsOrigins : false });

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

  // Monaco editor assets (loader, language modes, workers) on the same origin.
  const monacoMin = monacoMinDir();
  if (monacoMin && existsSync(monacoMin)) {
    await app.register(fastifyStatic, { root: monacoMin, prefix: "/vendor/monaco/", decorateReply: false });
    // The base editor worker's filename is content-hashed; the language workers
    // (ts/json/css/html) self-resolve via Monaco's own require.toUrl, so only this
    // one needs to be told to the client. Resolve it from disk at boot.
    const assetsDir = join(monacoMin, "vs", "assets");
    const editorWorker = existsSync(assetsDir)
      ? (readdirSync(assetsDir).find((f) => /^editor\.worker-.*\.js$/.test(f)) ?? null)
      : null;
    app.get("/vendor/monaco/manifest.json", async () => ({
      loaderUrl: "/vendor/monaco/vs/loader.js",
      vsPath: "/vendor/monaco/vs",
      editorWorkerUrl: editorWorker ? `/vendor/monaco/vs/assets/${editorWorker}` : null,
    }));
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
  // Fail-safe for a locked LLM deployment: LLM_SETTINGS_LOCKED=true with no
  // working platform provider would disable AI for every org with no override —
  // refuse to boot with a setup-oriented error instead.
  assertLlmBootConfig();
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

/** Turn a pre-listen boot failure (almost always an uninitialised database)
 *  into a plain, actionable message instead of a raw unhandled-rejection stack. */
function reportStartupFailure(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  const dbNotReady =
    /no such table/i.test(msg) ||
    /unable to open.*database/i.test(msg) ||
    /Environment variable not found: DATABASE_URL/i.test(msg);
  console.error("\n✖ The server could not start.\n");
  if (dbNotReady) {
    console.error(
      "  The database isn't initialised yet. Run:\n\n" +
        "    npm run setup\n\n" +
        "  then start it again with `npm run dev`.\n",
    );
  } else {
    console.error(`  ${msg}\n`);
  }
  if (process.env.LOG_LEVEL === "debug") console.error(err);
}

// pathToFileURL (not string-prefixing) so the entrypoint check also holds on
// Windows, where argv[1] is C:\...-style and never string-matches a file: URL.
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = Number(process.env.PORT ?? 3001);
  // Loopback-only by default. Bind all interfaces (HOST=0.0.0.0) only behind a
  // reverse proxy — the Docker entrypoint does, for Fly's proxy.
  const host = process.env.HOST ?? "127.0.0.1";
  buildServer()
    .then(async (app) => {
      try {
        await app.listen({ port, host });
        app.log.info(`server listening on http://${host}:${port}`);
      } catch (err) {
        app.log.error(err);
        await prisma.$disconnect();
        process.exit(1);
      }
    })
    .catch(async (err) => {
      reportStartupFailure(err);
      try {
        await prisma.$disconnect();
      } catch {
        /* ignore — we're already exiting */
      }
      process.exit(1);
    });
}
