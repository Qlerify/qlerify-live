// Static deny-scan for AI-authored adapter bodies (Part 2.3, Slice 2). Not a
// sandbox — a cheap gate that converts "trust the prompt" into "trust the prompt
// AND a check". Runs at write time (reject before persisting) AND at load time
// (defense in depth, in the host before import). A body should reach the outside
// world ONLY through ctx.fetch and authenticate ONLY with ctx.secret; it has no
// reason to touch the filesystem, spawn processes, read the environment, or eval.

const DENY: Array<{ re: RegExp; why: string }> = [
  { re: /\bchild_process\b/, why: "child_process (spawn/exec)" },
  { re: /\bworker_threads\b/, why: "worker_threads" },
  { re: /['"]node:fs['"]|['"]fs['"]|['"]fs\/promises['"]/, why: "filesystem module" },
  { re: /['"]node:net['"]|['"]net['"]|['"]node:dgram['"]/, why: "raw sockets" },
  { re: /['"]node:vm['"]|['"]vm['"]/, why: "vm" },
  { re: /\bprocess\s*\.\s*env\b/, why: "process.env" },
  { re: /\bprocess\s*\.\s*(exit|binding|kill|dlopen)\b/, why: "process internals" },
  { re: /\brequire\s*\(/, why: "require()" },
  { re: /\beval\s*\(/, why: "eval()" },
  { re: /\bnew\s+Function\s*\(/, why: "new Function()" },
  { re: /\bglobalThis\s*\.\s*process\b/, why: "globalThis.process" },
];

interface DenyScanResult {
  ok: boolean;
  violations: string[];
}

export function denyScan(source: string): DenyScanResult {
  const violations: string[] = [];
  for (const { re, why } of DENY) if (re.test(source)) violations.push(why);
  return { ok: violations.length === 0, violations };
}
