import { PrismaClient } from "@prisma/client";
import { resolveDatabaseUrl } from "./db-url.js";

declare global {
  var __prisma: PrismaClient | undefined;
}

// Pin the datasource URL explicitly. An absolute file: URL from the environment
// (Docker/Fly's file:/data/dev.db) is honored verbatim; a missing/relative/
// placeholder value self-heals to <root>/prisma/dev.db so the runtime client and
// the Prisma CLI never split across two .db files. We also write it back to
// process.env so any in-process reader (and Prisma's own env lookup) agrees.
const url = resolveDatabaseUrl();
process.env.DATABASE_URL = url;

export const prisma: PrismaClient =
  global.__prisma ??
  new PrismaClient({ log: ["warn", "error"], datasources: { db: { url } } });

if (process.env.NODE_ENV !== "production") global.__prisma = prisma;
