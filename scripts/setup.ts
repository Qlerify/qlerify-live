/**
 * One-command, idempotent first-run setup. Run automatically by the guarded
 * `predev` / `prestart` hooks, or directly via `npm run setup`. The goal: a
 * non-technical client goes `npm ci && npm run dev` and never opens .env.
 *
 * What it does (never clobbering a value you set yourself):
 *   - creates .env from .env.example if missing
 *   - fills DATABASE_URL with the project's absolute prisma/dev.db path
 *   - generates PLATFORM_ENCRYPTION_KEY (only when blank/absent — rotation would
 *     invalidate every org's stored BYOK secret, so a present key is left alone)
 *   - neutralises the ANTHROPIC_API_KEY placeholder (the real key is entered per
 *     org in the UI, never in .env)
 *   - runs `prisma generate` (when the client is missing) and `prisma db push`
 *     (only on a fresh DB — pushing an existing dev.db would drop the runtime
 *     gen_ projection tables)
 *
 * Cross-platform: pure Node, no bash. Prisma is spawned via process.execPath
 * (not npx) to dodge the Windows .cmd resolution hazard.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  PLACEHOLDER_DATABASE_URL,
  PROJECT_ROOT,
  defaultSqliteUrl,
  isAbsoluteFileUrl,
} from "../src/db-url.js";

const ENV_PATH = join(PROJECT_ROOT, ".env");
const EXAMPLE_PATH = join(PROJECT_ROOT, ".env.example");
const IF_NEEDED = process.argv.includes("--if-needed");

main();

function main(): void {
  // Fast path for the predev/prestart hooks: a warm, fully provisioned tree is a
  // no-op (and crucially skips `db push`, which would drop the gen_ tables).
  if (IF_NEEDED && isProvisioned()) return;

  ensureEnvFile();
  fillEnv();

  const url = readEnvKey("DATABASE_URL") ?? defaultSqliteUrl();

  // Generate the client when it's missing (idempotent; never touches data).
  if (!existsSync(clientDir())) runPrisma(["generate"], url);

  // Create the SQLite schema ONLY on a truly fresh DB. Never `db push` an
  // existing dev.db — it drops the runtime gen_ projection tables. Additive
  // control-plane columns are applied at server boot by ensureSchemaUpgrades().
  if (!existsSync(dbFileFromUrl(url))) runPrisma(["db", "push", "--skip-generate"], url);

  printSummary();
}

// --- provisioning state --------------------------------------------------------

function clientDir(): string {
  return join(PROJECT_ROOT, "node_modules", ".prisma", "client");
}

function dbFileFromUrl(url: string): string {
  return url.replace(/^file:/, "");
}

function isProvisioned(): boolean {
  if (!existsSync(ENV_PATH)) return false;
  const url = readEnvKey("DATABASE_URL");
  if (!url) return false;
  return existsSync(dbFileFromUrl(url)) && existsSync(clientDir());
}

// --- .env management -----------------------------------------------------------

function ensureEnvFile(): void {
  if (existsSync(ENV_PATH)) return;
  if (existsSync(EXAMPLE_PATH)) copyFileSync(EXAMPLE_PATH, ENV_PATH);
  else writeFileSync(ENV_PATH, "");
}

function fillEnv(): void {
  const original = readFileSync(ENV_PATH, "utf8");
  let lines = original.split(/\r?\n/);

  // DATABASE_URL — fill when blank / relative / placeholder; keep a real absolute path.
  lines = upsert(
    lines,
    "DATABASE_URL",
    defaultSqliteUrl(),
    (cur) => cur === "" || cur === PLACEHOLDER_DATABASE_URL || !isAbsoluteFileUrl(cur),
  );

  // PLATFORM_ENCRYPTION_KEY — generate only when blank/absent; never overwrite.
  lines = upsert(
    lines,
    "PLATFORM_ENCRYPTION_KEY",
    randomBytes(32).toString("hex"),
    (cur) => cur === "",
  );

  // ANTHROPIC_API_KEY — never fill (entered per org in the UI). Only neutralise the
  // literal placeholder so platformClient() gives the friendly "no key" error
  // instead of a 401 on the first AI call. Don't add the key if it's absent.
  lines = upsert(lines, "ANTHROPIC_API_KEY", "", (cur) => cur === "sk-ant-...", false);

  const next = lines.join("\n");
  if (next !== original) writeFileSync(ENV_PATH, next);
}

/** Set `KEY=value` when `shouldSet(currentValue)` is true. If the key is absent,
 *  append it only when `appendWhenMissing` (and the empty-value predicate passes).
 *  Commented (`# KEY=`) lines are ignored. */
function upsert(
  lines: string[],
  key: string,
  value: string,
  shouldSet: (currentValue: string) => boolean,
  appendWhenMissing = true,
): string[] {
  const re = new RegExp(`^\\s*${key}\\s*=(.*)$`);
  const idx = lines.findIndex((l) => !l.trimStart().startsWith("#") && re.test(l));
  if (idx === -1) {
    if (appendWhenMissing && shouldSet("")) lines.push(`${key}=${formatValue(value)}`);
    return lines;
  }
  const current = unquote((lines[idx].match(re)![1] ?? "").trim());
  if (shouldSet(current)) lines[idx] = `${key}=${formatValue(value)}`;
  return lines;
}

function readEnvKey(key: string): string | undefined {
  if (!existsSync(ENV_PATH)) return undefined;
  const re = new RegExp(`^\\s*${key}\\s*=(.*)$`);
  for (const line of readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
    if (line.trimStart().startsWith("#")) continue;
    const m = line.match(re);
    if (m) return unquote((m[1] ?? "").trim());
  }
  return undefined;
}

function formatValue(v: string): string {
  return /\s/.test(v) ? `"${v}"` : v;
}

function unquote(v: string): string {
  if (
    v.length >= 2 &&
    ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
  ) {
    return v.slice(1, -1);
  }
  return v;
}

// --- prisma ------------------------------------------------------------------

function runPrisma(args: string[], url: string): void {
  const entry = join(PROJECT_ROOT, "node_modules", "prisma", "build", "index.js");
  const useEntry = existsSync(entry);
  const exe = useEntry ? process.execPath : "npx";
  const argv = useEntry ? [entry, ...args] : ["prisma", ...args];
  const label = `prisma ${args.join(" ")}`;
  console.log(`\n▸ ${label}`);
  const res = spawnSync(exe, argv, {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url },
    shell: !useEntry, // only the npx fallback needs a shell (Windows .cmd)
  });
  if (res.status !== 0) {
    console.error(
      `\n✖ \`${label}\` failed. Fix the error above, then re-run \`npm run setup\`.`,
    );
    process.exit(res.status ?? 1);
  }
}

// --- summary -----------------------------------------------------------------

function printSummary(): void {
  const port = readEnvKey("PORT") ?? process.env.PORT ?? "3001";
  console.log(
    [
      "",
      "✓ Setup complete — no .env editing needed.",
      "",
      "  Start the app:   npm run dev",
      `  Open:            http://localhost:${port}`,
      '  Sign in:         username "superadmin"',
      "                   the one-time password is written to",
      "                   .qlerify/superadmin.local.txt the first time the server starts.",
      "  Anthropic key:   optional — paste it in Organisation admin once signed in",
      "                   (no .env edit required).",
      "",
    ].join("\n"),
  );
}
