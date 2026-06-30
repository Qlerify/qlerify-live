// Full-power connector runtime (Part 2.4). The "integrate to anything" engine.
//
// An AI-built connector is a plain ESM module — `<workspace>/<id>.mjs` — that
// exports `async fetchRows(ctx)` (and optionally `probe(ctx)`) and may import ANY
// npm package and speak ANY protocol (AWS SDK, pg, googleapis, soap, raw fetch…).
// Unlike the Part 2.3 authored body (HTTP-only, in-process, deny-scanned), this one
// is unrestricted — so it runs in a SANDBOXED child `node` process.
//
// SECURITY SANDBOX (Workstream D). Untrusted, AI-/tenant-influenced code, so the
// child is confined on several axes:
//   D1  Workspace lives OUTSIDE the repo (QLERIFY_DATA_DIR / ~/.qlerify-data), so
//       path traversal (`../../.env`, `../../prisma/dev.db`) cannot reach the
//       platform master key or the control-plane DB.
//   D2  Node permission model (`--experimental-permission` + `--allow-fs-read/write`
//       scoped to the workspace, no `--allow-child-process` / `--allow-worker` /
//       `--allow-addons`): the runtime — not a regex — denies any FS access outside
//       the workspace, re-spawns, worker threads, and native addons.
//   D3  `npm install --ignore-scripts` + a secret-free env (kills postinstall RCE
//       and stops a malicious dep from reading the host's secrets).
//   D4  The runner's `fetch` is SSRF-guarded (rejects loopback / link-local /
//       RFC1918 / the cloud metadata IP). An optional bubblewrap jail
//       (QLERIFY_CONNECTOR_JAIL=bwrap) adds OS-level egress/mount confinement on
//       Linux deployments.
// Residual (tracked): full per-(org,workflow) path namespacing of the workspace,
// and unifying the in-process authored path onto this same runner. The wall-clock +
// heap budget still bounds a hang/crash to the child.

import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { connectorsEnabled } from "../../config/features.js";
import type { EntitySchema } from "../../ontology/model.js";

// D1 — the workspace is OUTSIDE the repo tree. Override with QLERIFY_DATA_DIR (a
// persistent volume on Fly). The default is the user's home, never the checkout,
// so `../../` from here can never reach the repo's .env / prisma/dev.db.
const DATA_ROOT = process.env.QLERIFY_DATA_DIR || join(homedir(), ".qlerify-data");
export const CONNECTORS_DIR = join(DATA_ROOT, "connectors");

const RUN_BUDGET_MS = 30_000; // generous — real APIs + cold SDK init can be slow
const INSTALL_BUDGET_MS = 180_000; // npm install of a fat SDK over the network
const HEAP_MB = 512;

// D2 — detect once which permission-model flag this node accepts (renamed across
// versions: --experimental-permission on 20/22, --permission on 23.5+). null ⇒ the
// runtime has no permission model; we fall back to D1+D3+D4 with a logged warning.
let _permFlag: string | null | undefined;
export function permissionFlag(): string | null {
  if (_permFlag !== undefined) return _permFlag;
  for (const flag of ["--experimental-permission", "--permission"]) {
    try {
      const r = spawnSync(process.execPath, [flag, "-e", "0"], { encoding: "utf8", timeout: 5000 });
      if (r.status === 0) return (_permFlag = flag);
    } catch { /* try the next flag */ }
  }
  if (process.env.NODE_ENV === "production") {
    console.warn("[connector-sandbox] node has no permission model — connector FS confinement relies on D1 (out-of-repo workspace) only");
  }
  return (_permFlag = null);
}

// D2 — the fs-confinement argv for the run child: deny all fs except the workspace,
// and grant NO child_process / worker / addons. Returns [] when unsupported.
function sandboxArgs(): string[] {
  const flag = permissionFlag();
  if (!flag) return [];
  return [flag, `--allow-fs-read=${CONNECTORS_DIR}`, `--allow-fs-write=${CONNECTORS_DIR}`];
}

// D4 (strong, OPT-IN) — an OS-level jail for the run child via bubblewrap. The
// Node permission model confines the filesystem but NOT raw sockets; this adds a
// fresh mount/pid/ipc namespace that exposes only {node, workspace, runtime libs,
// CA certs}. Enabled only on Linux deployments where bwrap exists AND
// QLERIFY_CONNECTOR_JAIL=bwrap is set, so local/dev runs are unaffected. The
// concrete bind set is deployment-tunable. NOT exercised on macOS dev.
let _bwrap: boolean | undefined;
function bwrapAvailable(): boolean {
  if (process.env.QLERIFY_CONNECTOR_JAIL !== "bwrap") return false;
  if (_bwrap !== undefined) return _bwrap;
  try { _bwrap = spawnSync("bwrap", ["--version"], { timeout: 3000 }).status === 0; }
  catch { _bwrap = false; }
  return _bwrap;
}
function jailWrap(bin: string, args: string[]): { cmd: string; cmdArgs: string[] } {
  if (!bwrapAvailable()) return { cmd: bin, cmdArgs: args };
  const bwrapArgs = [
    "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--die-with-parent", "--new-session",
    "--ro-bind", "/usr", "/usr",
    "--ro-bind-try", "/lib", "/lib", "--ro-bind-try", "/lib64", "/lib64", "--ro-bind-try", "/bin", "/bin",
    "--ro-bind-try", "/etc/ssl", "/etc/ssl", "--ro-bind-try", "/etc/resolv.conf", "/etc/resolv.conf",
    "--ro-bind", bin, bin,
    "--bind", CONNECTORS_DIR, CONNECTORS_DIR,
    "--proc", "/proc", "--dev", "/dev",
    "--chdir", CONNECTORS_DIR,
    "--", bin, ...args,
  ];
  return { cmd: "bwrap", cmdArgs: bwrapArgs };
}

// ---------------------------------------------------------------------------
// Workspace — one shared dir so a fat SDK (e.g. @aws-sdk) installs once and every
// connector resolves it. Per-connector throwaway is the <id>.* files, not the deps.
// ---------------------------------------------------------------------------

function modulePath(id: string): string { return join(CONNECTORS_DIR, `${id}.mjs`); }
function credPath(id: string): string { return join(CONNECTORS_DIR, `${id}.cred.json`); }
function ctxPath(id: string): string { return join(CONNECTORS_DIR, `${id}.ctx.json`); }
function resultPath(id: string): string { return join(CONNECTORS_DIR, `${id}.result.json`); }
const RUNNER = join(CONNECTORS_DIR, "runner.mjs");

/** The generic child-process runner. Imports the connector by file URL, builds the
 * capability `ctx`, runs fetchRows/probe, and writes the result JSON to a file. It
 * is written verbatim (idempotent) so it ships with no separate build step. */
const RUNNER_SRC = `// AUTO-GENERATED by src/packs/connector/runtime.ts — do not edit.
import { readFileSync, writeFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
const [, , modUrl, ctxFile, credFile, outFile] = process.argv;
const input = JSON.parse(readFileSync(ctxFile, "utf8"));
let credentials = {};
try { credentials = JSON.parse(readFileSync(credFile, "utf8")); } catch {}
const trace = [];
const log = (m) => { trace.push(typeof m === "string" ? m : JSON.stringify(m)); };
const pick = (...k) => { for (const x of k) if (credentials && credentials[x] != null) return credentials[x]; return undefined; };

// D4 — SSRF guard. Reject loopback / link-local / RFC1918 / CGNAT / the cloud
// metadata IP (169.254.169.254), for both literal-IP and resolved hostnames, so a
// connector cannot pivot to internal services or steal instance credentials.
function ipBlocked(ip) {
  if (!ip) return false;
  let s = String(ip);
  if (s.startsWith("::ffff:")) s = s.slice(7);
  if (s === "::1") return true;
  const low = s.toLowerCase();
  if (low.startsWith("fe80") || low.startsWith("fc") || low.startsWith("fd")) return true;
  const m = s.match(/^(\\d+)\\.(\\d+)\\.(\\d+)\\.(\\d+)$/);
  if (!m) return false;
  const a = +m[1], b = +m[2];
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}
async function safeFetch(url, opts) {
  let host;
  try { host = new URL(typeof url === "string" ? url : (url && url.url) || "").hostname; }
  catch { throw new Error("connector fetch: invalid URL"); }
  const bare = host.replace(/^\\[|\\]$/g, "");
  if (/^[0-9.]+$/.test(bare) || bare.includes(":")) {
    if (ipBlocked(bare)) throw new Error("connector fetch blocked: " + bare + " is a private/link-local address");
  } else {
    const addrs = await lookup(host, { all: true });
    for (const ad of addrs) if (ipBlocked(ad.address)) throw new Error("connector fetch blocked: " + host + " resolves to a private address (" + ad.address + ")");
  }
  return globalThis.fetch(url, opts);
}

const ctx = {
  entity: input.entity,
  limit: input.limit,
  endpoint: input.endpoint,
  credentials,
  secret: pick("secret", "apiKey", "api_key", "token", "accessToken", "key", "password"),
  fetch: (...a) => safeFetch(...a),
  log,
  trace,
};
async function main() {
  const mod = await import(modUrl);
  if (input.op === "probe" && typeof mod.probe === "function") {
    return { ok: true, probe: await mod.probe(ctx), trace };
  }
  if (typeof mod.fetchRows !== "function") throw new Error("connector must export 'async fetchRows(ctx)'");
  const rows = await mod.fetchRows(ctx);
  const arr = Array.isArray(rows) ? rows : (rows == null ? [] : [rows]);
  return { ok: true, rows: arr.slice(0, input.limit ?? 100), count: arr.length, trace };
}
main()
  .then((out) => { writeFileSync(outFile, JSON.stringify(out)); process.exit(0); })
  .catch((err) => {
    const msg = err && (err.stack || err.message) ? (err.stack || err.message) : String(err);
    writeFileSync(outFile, JSON.stringify({ ok: false, error: msg, trace }));
    process.exit(1);
  });
`;

export function ensureWorkspace(): void {
  mkdirSync(CONNECTORS_DIR, { recursive: true });
  const pkg = join(CONNECTORS_DIR, "package.json");
  if (!existsSync(pkg)) {
    writeFileSync(pkg, JSON.stringify({ name: "qlerify-connectors", private: true, type: "module", dependencies: {} }, null, 2) + "\n");
  }
  // Keep the runner current with this file's RUNNER_SRC on every ensure.
  writeFileSync(RUNNER, RUNNER_SRC);
}

// ---------------------------------------------------------------------------
// Module + credentials persistence
// ---------------------------------------------------------------------------

export function writeModule(id: string, code: string): string {
  ensureWorkspace();
  const clean = code.endsWith("\n") ? code : code + "\n";
  writeFileSync(modulePath(id), clean);
  return modulePath(id);
}

export function readModule(id: string): string | null {
  const p = modulePath(id);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

export function moduleExists(id: string): boolean {
  return existsSync(modulePath(id));
}

/** Store the plaintext credentials blob (any shape). PoC — security deferred. */
export function writeCredentials(id: string, creds: Record<string, unknown>): void {
  ensureWorkspace();
  writeFileSync(credPath(id), JSON.stringify(creds ?? {}, null, 2) + "\n");
}

export function readCredentials(id: string): Record<string, unknown> {
  const p = credPath(id);
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>; } catch { return {}; }
}

/** The credential FIELD NAMES present (never the values) — safe to show in chat. */
export function credentialKeys(id: string): string[] {
  return Object.keys(readCredentials(id));
}

/** Remove a connector's files (module + creds + scratch). Shared deps are left in
 * place. Returns true if a module file existed. */
export function deleteConnectorFiles(id: string): boolean {
  const had = moduleExists(id);
  for (const p of [modulePath(id), credPath(id), ctxPath(id), resultPath(id)]) {
    if (existsSync(p)) rmSync(p);
  }
  return had;
}

// ---------------------------------------------------------------------------
// Dependency detection + install
// ---------------------------------------------------------------------------

const NODE_BUILTINS = new Set([
  "assert", "buffer", "child_process", "cluster", "console", "crypto", "dgram",
  "dns", "events", "fs", "http", "http2", "https", "net", "os", "path",
  "perf_hooks", "process", "querystring", "readline", "stream", "string_decoder",
  "timers", "tls", "tty", "url", "util", "v8", "vm", "worker_threads", "zlib",
]);

/** Bare npm package specifiers imported by the code (deps to install). Strips
 * subpaths ("@aws-sdk/lib-dynamodb/foo" → "@aws-sdk/lib-dynamodb"), node: builtins,
 * and relative/absolute paths. */
export function scanImports(code: string): string[] {
  const specs = new Set<string>();
  const patterns = [
    /\bimport\s+(?:[\w*${}\n\s,]+\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+[\w*${}\n\s,]+\s+from\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(code))) {
      const raw = m[1]!;
      if (raw.startsWith(".") || raw.startsWith("/") || raw.startsWith("node:")) continue;
      const parts = raw.split("/");
      const pkg = raw.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
      if (NODE_BUILTINS.has(pkg)) continue;
      specs.add(pkg);
    }
  }
  return [...specs];
}

function isInstalled(pkg: string): boolean {
  return existsSync(join(CONNECTORS_DIR, "node_modules", ...pkg.split("/"), "package.json"));
}

export interface InstallResult { installed: string[]; skipped: string[]; ok: boolean; log: string; }

/** Install any not-yet-present deps into the shared workspace. Idempotent. */
export async function installDeps(deps: string[]): Promise<InstallResult> {
  ensureWorkspace();
  const want = [...new Set(deps)].filter(Boolean);
  const skipped = want.filter(isInstalled);
  const missing = want.filter((d) => !isInstalled(d));
  if (missing.length === 0) return { installed: [], skipped, ok: true, log: "" };

  return await new Promise<InstallResult>((resolve) => {
    // D3 — `--ignore-scripts` disables postinstall/preinstall RCE; the env is
    // stripped to PATH+HOME so a dependency (whose scripts are off anyway) can
    // never read PLATFORM_ENCRYPTION_KEY / ANTHROPIC_API_KEY / DATABASE_URL.
    const args = ["install", ...missing, "--no-audit", "--no-fund", "--ignore-scripts", "--loglevel=error", "--save"];
    const child = spawn("npm", args, { cwd: CONNECTORS_DIR, env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    let log = "";
    const cap = (b: Buffer) => { log += b.toString(); if (log.length > 8000) log = log.slice(-8000); };
    child.stdout.on("data", cap);
    child.stderr.on("data", cap);
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, INSTALL_BUDGET_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      const ok = missing.every(isInstalled);
      resolve({ installed: ok ? missing : missing.filter(isInstalled), skipped, ok, log: log.trim() });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ installed: [], skipped, ok: false, log: `npm spawn failed: ${err.message}` });
    });
  });
}

// ---------------------------------------------------------------------------
// Run — isolated subprocess
// ---------------------------------------------------------------------------

export interface RunRequest {
  entity: EntitySchema;
  limit: number;
  endpoint?: string;
  op?: "fetchRows" | "probe";
}

export interface RunResult {
  ok: boolean;
  rows?: Array<Record<string, unknown>>;
  count?: number;
  probe?: { ok: boolean; detail?: string };
  error?: string;
  trace: string[];
}

/** Run a connector in an isolated child process under a wall-clock + heap budget.
 * Credentials are read from the connector's cred file by the child (not passed via
 * argv/env). Captures the child's stdout/stderr into the trace so a crash or a
 * console.log surfaces to the AI troubleshooter for the iterate-and-fix loop. */
export async function runConnector(id: string, req: RunRequest): Promise<RunResult> {
  // D7 — defense at the execution chokepoint: even if a route is missed, a
  // locked-down deployment never runs connector code.
  if (!connectorsEnabled()) return { ok: false, error: "the connector subsystem is disabled for this deployment", trace: [] };
  ensureWorkspace();
  if (!moduleExists(id)) return { ok: false, error: `connector "${id}" has no code yet — build it first`, trace: [] };

  const input = { entity: req.entity, limit: req.limit, endpoint: req.endpoint, op: req.op ?? "fetchRows" };
  writeFileSync(ctxPath(id), JSON.stringify(input));
  if (!existsSync(credPath(id))) writeFileSync(credPath(id), "{}");
  if (existsSync(resultPath(id))) rmSync(resultPath(id));

  // Reduced env: give the child a PATH + HOME for module resolution and TLS, but
  // NOT the host's secrets (ANTHROPIC_API_KEY etc.). Credentials arrive via file.
  const childEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_OPTIONS: "",
  };

  const argv = [
    ...sandboxArgs(), // D2 — fs/cap confinement (empty if this node lacks the model)
    `--max-old-space-size=${HEAP_MB}`,
    RUNNER,
    pathToFileURL(modulePath(id)).href,
    ctxPath(id),
    credPath(id),
    resultPath(id),
  ];
  const { cmd, cmdArgs } = jailWrap(process.execPath, argv); // D4 — optional OS jail

  return await new Promise<RunResult>((resolve) => {
    const child = spawn(cmd, cmdArgs, { cwd: CONNECTORS_DIR, env: childEnv });
    let out = "";
    const cap = (b: Buffer) => { out += b.toString(); if (out.length > 16000) out = out.slice(-16000); };
    child.stdout.on("data", cap);
    child.stderr.on("data", cap);

    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, RUN_BUDGET_MS);

    child.on("close", () => {
      clearTimeout(timer);
      const childOut = out.trim();
      let parsed: RunResult | null = null;
      if (existsSync(resultPath(id))) {
        try { parsed = JSON.parse(readFileSync(resultPath(id), "utf8")) as RunResult; } catch { /* fall through */ }
      }
      if (parsed) {
        // Fold the child's console output into the trace for visibility.
        if (childOut) parsed.trace = [...(parsed.trace ?? []), ...childOut.split("\n").slice(-20)];
        resolve(parsed);
        return;
      }
      const error = timedOut
        ? `connector exceeded the ${RUN_BUDGET_MS / 1000}s run budget (killed)`
        : `connector process produced no result${childOut ? `:\n${childOut}` : " and no output"}`;
      resolve({ ok: false, error, trace: childOut ? childOut.split("\n").slice(-20) : [] });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `failed to start connector process: ${err.message}`, trace: [] });
    });
  });
}

/** List connector ids that have a module on disk (diagnostics). */
export function listConnectorIds(): string[] {
  if (!existsSync(CONNECTORS_DIR)) return [];
  return readdirSync(CONNECTORS_DIR)
    .filter((f) => f.endsWith(".mjs") && f !== "runner.mjs")
    .map((f) => f.slice(0, -4));
}
