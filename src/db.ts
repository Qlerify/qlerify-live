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

// SQLite's default page cache is ~2 MB per connection, so over EFS every scan
// re-reads the file across the network. The pragma is per-connection: fan out a
// few concurrent statements to reach the pool (best-effort).
export async function applySqliteTuning(): Promise<void> {
  const mb = Number(process.env.SQLITE_CACHE_MB);
  if (!Number.isFinite(mb) || mb <= 0) {
    return;
  }
  const kib = Math.round(mb * 1024);
  await Promise.all(
    Array.from({ length: 8 }, () => prisma.$queryRawUnsafe(`PRAGMA cache_size = -${kib}`).catch(() => null)),
  );
}
