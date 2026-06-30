// Password hashing + opaque session tokens for the login flow.
//
// Passwords: scrypt with a per-password random salt, stored as
// "scrypt$<saltHex>$<hashHex>". verifyPassword ALWAYS runs scrypt (even when the
// identity has no/garbage hash) so login timing does not reveal whether an
// account exists — no user-enumeration oracle.
//
// Sessions: the bearer value is a 256-bit random token; only its sha256 is
// stored, so a leaked DB row is not a usable credential. Tokens expire and can
// be revoked (logout).

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { prisma } from "../../db.js";
import { newId, sha256 } from "../ids.js";

const SCRYPT_KEYLEN = 32;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

/** A high-entropy, URL-safe one-time password for an issued credential (an
 * admin-invited member, an admin reset, or the auto-seeded superuser when no
 * SUPERADMIN_PASSWORD is set). 18 random bytes ≈ 144 bits, base64url ⇒ 24 chars,
 * no ambiguous separators. NEVER persisted in plaintext or written to the audit
 * log — the caller conveys it out-of-band exactly once. */
export function generatePassword(): string {
  return randomBytes(18).toString("base64url");
}

/** Constant-time-ish verify. Runs scrypt unconditionally (against a dummy salt
 * when `stored` is null/malformed) so a missing account is indistinguishable. */
export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  const parts = (stored ?? "").split("$");
  const ok = parts.length === 3 && parts[0] === "scrypt";
  const salt = ok ? Buffer.from(parts[1], "hex") : randomBytes(16);
  const expected = ok ? Buffer.from(parts[2], "hex") : randomBytes(SCRYPT_KEYLEN);
  const actual = scryptSync(password, salt, SCRYPT_KEYLEN);
  if (!ok || actual.length !== expected.length) {
    // Still consumed the scrypt cost above; now fail.
    return false;
  }
  return timingSafeEqual(actual, expected);
}

interface IssuedSession {
  token: string; // the raw bearer value (returned to the client, never stored)
  expiresAt: Date;
}

/** Create a session for an identity; returns the raw token (store sha256 only). */
export async function createSession(identityId: string, now: Date): Promise<IssuedSession> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await prisma.platSession.create({
    data: { id: newId(), tokenHash: sha256(token), identityId, expiresAt },
  });
  return { token, expiresAt };
}

/** Resolve a live session token to its identity id, or null. */
export async function resolveSession(token: string, now: Date): Promise<string | null> {
  const s = await prisma.platSession.findUnique({ where: { tokenHash: sha256(token) } });
  if (!s || s.revokedAt || s.expiresAt <= now) return null;
  return s.identityId;
}

/** Revoke a session by its raw token (logout). Idempotent. */
export async function revokeSession(token: string, now: Date): Promise<void> {
  const s = await prisma.platSession.findUnique({ where: { tokenHash: sha256(token) } });
  if (s && !s.revokedAt) {
    await prisma.platSession.update({ where: { id: s.id }, data: { revokedAt: now } });
  }
}
