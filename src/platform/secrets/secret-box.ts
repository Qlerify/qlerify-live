// Symmetric encryption-at-rest for small per-org secrets (the Anthropic API key
// today). AES-256-GCM via node:crypto — the first reversible crypto in the repo;
// password/session hashing in ../authn/sessions.ts is one-way and not usable to
// store a recoverable key.
//
// Stored format mirrors the `scrypt$salt$hash` convention in sessions.ts:
//   "gcm$<ivHex>$<tagHex>$<ctHex>"
// The 96-bit IV is random per encryption; the 128-bit GCM auth tag makes a
// tampered ciphertext fail to decrypt rather than yield garbage.
//
// The master key comes from PLATFORM_ENCRYPTION_KEY (64 hex chars = 32 bytes).
// It is read lazily so the server still boots without it — only an attempt to
// store/read a per-org key requires it, with a clear error pointing at setup.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { DomainError } from "../../errors.js";

const IV_BYTES = 12; // 96-bit nonce, the GCM standard
const KEY_BYTES = 32; // AES-256

/** Resolve the 32-byte master key from PLATFORM_ENCRYPTION_KEY, or throw a
 * setup-oriented error. Not cached — these operations are rare (admin writes /
 * cold client builds), and re-reading keeps key rotation via env trivial. */
function masterKey(): Buffer {
  const hex = process.env.PLATFORM_ENCRYPTION_KEY;
  if (!hex) {
    throw new DomainError(
      "PLATFORM_ENCRYPTION_KEY is not set — generate one with `openssl rand -hex 32` " +
        "and add it to .env to enable per-organization Anthropic keys.",
    );
  }
  let key: Buffer;
  try {
    key = Buffer.from(hex.trim(), "hex");
  } catch {
    throw new DomainError("PLATFORM_ENCRYPTION_KEY must be hex (run `openssl rand -hex 32`).");
  }
  if (key.length !== KEY_BYTES) {
    throw new DomainError(
      `PLATFORM_ENCRYPTION_KEY must be ${KEY_BYTES} bytes (${KEY_BYTES * 2} hex chars); ` +
        `got ${key.length}. Run \`openssl rand -hex 32\`.`,
    );
  }
  return key;
}

/** Encrypt UTF-8 plaintext → "gcm$iv$tag$ct" (all hex). */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `gcm$${iv.toString("hex")}$${tag.toString("hex")}$${ct.toString("hex")}`;
}

/** Decrypt a "gcm$iv$tag$ct" string back to UTF-8. Throws if the format is bad
 * or the auth tag fails (tampered/ wrong key). */
export function decryptSecret(stored: string): string {
  const parts = (stored ?? "").split("$");
  if (parts.length !== 4 || parts[0] !== "gcm") {
    throw new DomainError("stored secret is malformed");
  }
  const [, ivHex, tagHex, ctHex] = parts;
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const pt = Buffer.concat([decipher.update(Buffer.from(ctHex, "hex")), decipher.final()]);
  return pt.toString("utf8");
}

/** A non-secret preview for the UI: keep a short readable prefix + last 4 chars,
 * mask the middle. Never reveals enough to reconstruct the key. */
export function maskSecret(key: string): string {
  const k = (key ?? "").trim();
  if (k.length <= 8) return "…"; // too short to show anything safely
  const head = k.slice(0, Math.min(7, k.length - 4)); // e.g. "sk-ant-"
  return `${head}…${k.slice(-4)}`;
}
