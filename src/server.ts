import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

import { registerRoutes } from "./http/routes.js";
import { wireDerivedEvents } from "./events/derived.js";
import { startOntologyWatch } from "./ontology/model.js";
import { prisma } from "./db.js";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..", "web");

export async function buildServer() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  await app.register(cors, { origin: true });

  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot, prefix: "/" });
  }

  registerRoutes(app);
  wireDerivedEvents();
  startOntologyWatch(app.log);
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
