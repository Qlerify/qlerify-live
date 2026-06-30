// Single source of truth for the SQLite DATABASE_URL the runtime and the setup
// script use. The path is derived from this module's own location (NOT
// process.cwd()), so it is correct no matter which directory npm/tsx is invoked
// from. Imported by src/db.ts (the runtime Prisma client) and scripts/setup.ts.
//
// Why this exists: a relative `file:./dev.db` resolves to prisma/dev.db for the
// Prisma CLI but to node_modules/.prisma/client/dev.db for the generated client,
// silently splitting reads and writes across two files. Computing one absolute
// path here removes that footgun without anyone hand-editing .env.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // <root>/src
/** Absolute path to the project root (one level above src/). */
export const PROJECT_ROOT = join(here, "..");

/** The inert placeholder shipped in older .env.example files. Treated as "no
 *  value" so the runtime self-heals even if a stale .env still carries it. */
export const PLACEHOLDER_DATABASE_URL = "file:/absolute/path/to/qlerify-live/prisma/dev.db";

/** Build a `file:` SQLite URL from an absolute path, forward-slashed so it is
 *  also valid on Windows (file:C:/Users/.../dev.db). */
function toFileUrl(absPath: string): string {
  return "file:" + absPath.split("\\").join("/");
}

/** The project's canonical SQLite location: <root>/prisma/dev.db. */
export function defaultSqliteUrl(): string {
  return toFileUrl(join(PROJECT_ROOT, "prisma", "dev.db"));
}

/** True for an absolute `file:` URL — POSIX (`file:/…`, `file:///…`) or a
 *  Windows drive (`file:C:/…`). The .env.example placeholder is excluded so a
 *  stale copy of it never counts as a real value. */
export function isAbsoluteFileUrl(v: string): boolean {
  if (!v.startsWith("file:")) return false;
  if (v === PLACEHOLDER_DATABASE_URL) return false;
  const p = v.slice("file:".length);
  return p.startsWith("/") || /^[A-Za-z]:/.test(p);
}

/** Resolve the DATABASE_URL the runtime should use. An explicit ABSOLUTE file:
 *  URL (e.g. Docker/Fly's `file:/data/dev.db`) wins verbatim; anything missing,
 *  blank, relative, or the old placeholder self-heals to prisma/dev.db. */
export function resolveDatabaseUrl(
  envValue: string | undefined = process.env.DATABASE_URL,
): string {
  const v = (envValue ?? "").trim();
  if (isAbsoluteFileUrl(v)) return v;
  return defaultSqliteUrl();
}
