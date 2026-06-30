// SSRF guard for the in-process authored adapter path. Rejects loopback,
// link-local, RFC1918, CGNAT, and the cloud metadata IP (169.254.169.254) — for
// both literal-IP and resolved hostnames — so an adapter cannot pivot to internal
// services or steal instance credentials.
//
// The connector SUBPROCESS runner carries its own inline copy of this logic (in
// runtime.ts's RUNNER_SRC), because it executes as a standalone .mjs in another
// process and cannot import this module. Keep the two in sync.

import { lookup } from "node:dns/promises";

export function isBlockedIp(ip: string): boolean {
  if (!ip) return false;
  let s = ip;
  if (s.startsWith("::ffff:")) s = s.slice(7); // IPv4-mapped IPv6
  if (s === "::1") return true;
  const low = s.toLowerCase();
  if (low.startsWith("fe80") || low.startsWith("fc") || low.startsWith("fd")) return true; // v6 link-local / ULA
  const m = s.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const a = +m[1], b = +m[2];
  if (a === 127 || a === 10 || a === 0) return true;        // loopback / private / this-host
  if (a === 169 && b === 254) return true;                  // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;         // 172.16/12
  if (a === 192 && b === 168) return true;                  // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true;        // CGNAT 100.64/10
  return false;
}

/** Throw if `url`'s host is (or resolves to) a private/link-local address. */
export async function assertSafeUrl(url: string): Promise<void> {
  let host: string;
  try { host = new URL(url).hostname; } catch { throw new Error("fetch: invalid URL"); }
  const bare = host.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (/^[0-9.]+$/.test(bare) || bare.includes(":")) {
    if (isBlockedIp(bare)) throw new Error(`fetch blocked: ${bare} is a private/link-local address`);
    return;
  }
  const addrs = await lookup(host, { all: true });
  for (const a of addrs) {
    if (isBlockedIp(a.address)) throw new Error(`fetch blocked: ${host} resolves to a private address (${a.address})`);
  }
}
