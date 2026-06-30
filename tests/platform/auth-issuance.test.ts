// Authentication-issuance increment (the deploy-blocking auth criticals from the
// 2026-06-30 security review):
//   1. the forgeable dev shim is HARD-OFF in production (NODE_ENV guard),
//   2. invited members get a real, one-time issued credential + a forced change,
//   3. there is no default superadmin password (env or random, never clobbered),
//   4. /v1/auth/login is rate-limited.
//
// Unit blocks need no server; the end-to-end block drives the real Fastify routes
// via app.inject so the login → invite → first-login → change-password flow is
// exercised exactly as the browser would.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";
import { prisma } from "../../src/db.js";
import { newId } from "../../src/platform/ids.js";
import { hashPassword, verifyPassword } from "../../src/platform/authn/sessions.js";
import { resolveTenantContext } from "../../src/platform/authn/index.js";
import { LoginRateLimiter, SlidingWindowLimiter, loginRateLimiter } from "../../src/platform/authn/rate-limit.js";
import { assignRole, issueMemberCredential, resolveSuperadminCredential } from "../../src/platform/provisioning/index.js";

const SFX = `ai${Date.now().toString(36)}`;

// --- Unit: the dev-shim production guard ------------------------------------
describe("dev auth shim — production guard", () => {
  const caId = newId();
  const orgId = newId();
  const shimSub = `shim-${SFX}`;
  let shimId: string;

  beforeAll(async () => {
    await prisma.platCustomerAccount.create({ data: { id: caId, name: `CA ${SFX}` } });
    await prisma.platOrganization.create({ data: { id: orgId, customerAccountId: caId, name: `Org ${SFX}`, slug: `org-${SFX}` } });
    shimId = (await prisma.platIdentity.create({ data: { id: newId(), subject: shimSub } })).id; // passwordless
    await prisma.platOrgMembership.create({ data: { id: newId(), identityId: shimId, organizationId: orgId } });
  });
  afterAll(async () => {
    await prisma.platOrgMembership.deleteMany({ where: { organizationId: orgId } });
    await prisma.platIdentity.deleteMany({ where: { id: shimId } });
    await prisma.platOrganization.deleteMany({ where: { id: orgId } });
    await prisma.platCustomerAccount.deleteMany({ where: { id: caId } });
  });

  it("rejects the raw-subject and X-Identity-Subject shim under NODE_ENV=production", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await expect(resolveTenantContext({ "x-identity-subject": shimSub })).rejects.toThrow();
      await expect(resolveTenantContext({ authorization: `Bearer ${shimSub}` })).rejects.toThrow();
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it("still honours the shim outside production (local-dev/test convenience)", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    try {
      const ctx = await resolveTenantContext({ "x-identity-subject": shimSub });
      expect(ctx.organizationId).toBe(orgId);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});

// --- Unit: the sliding-window login limiter ---------------------------------
describe("login rate limiter", () => {
  it("blocks a subject after its window fills and reports a retry-after", () => {
    const lim = new LoginRateLimiter({ windowMs: 60_000, ipMax: 1000, subjectMax: 3 });
    const t0 = 1_000_000;
    expect(lim.check("1.2.3.4", "bob", t0).blocked).toBe(false);
    lim.recordFailure("1.2.3.4", "bob", t0);
    lim.recordFailure("1.2.3.4", "bob", t0);
    lim.recordFailure("1.2.3.4", "bob", t0);
    const gate = lim.check("1.2.3.4", "bob", t0);
    expect(gate.blocked).toBe(true);
    expect(gate.retryAfterSec).toBeGreaterThan(0);
  });

  it("a successful login clears that subject's throttle", () => {
    const lim = new LoginRateLimiter({ windowMs: 60_000, ipMax: 1000, subjectMax: 3 });
    const t0 = 2_000_000;
    for (let i = 0; i < 3; i++) lim.recordFailure("9.9.9.9", "carol", t0);
    expect(lim.check("9.9.9.9", "carol", t0).blocked).toBe(true);
    lim.recordSuccess("9.9.9.9", "carol");
    expect(lim.check("9.9.9.9", "carol", t0).blocked).toBe(false);
  });

  it("the window slides — failures expire after windowMs", () => {
    const win = new SlidingWindowLimiter(10_000, 2);
    win.recordFailure("k", 0);
    win.recordFailure("k", 0);
    expect(win.check("k", 0).blocked).toBe(true);
    expect(win.check("k", 10_001).blocked).toBe(false); // both fell out of the window
  });
});

// --- Unit: no default superadmin password -----------------------------------
describe("superadmin credential resolution", () => {
  it("uses SUPERADMIN_PASSWORD when set (operator-controlled rotation)", () => {
    const r = resolveSuperadminCredential({ envPassword: "Hunter2-rotated!", existingHash: "scrypt$deadbeef$cafe" });
    expect(r.generated).toBe(false);
    expect(r.plaintext).toBe("Hunter2-rotated!");
    expect(verifyPassword("Hunter2-rotated!", r.hash!)).toBe(true);
  });

  it("mints a strong RANDOM password on first boot when unset — never the literal default", () => {
    const r = resolveSuperadminCredential({ envPassword: undefined, existingHash: null });
    expect(r.generated).toBe(true);
    expect(r.plaintext).toBeTruthy();
    expect(r.plaintext).not.toBe("superadmin");
    expect((r.plaintext as string).length).toBeGreaterThanOrEqual(16);
    expect(verifyPassword(r.plaintext as string, r.hash!)).toBe(true);
  });

  it("leaves an existing password untouched on reboot (no clobber, no reset-to-default)", () => {
    const r = resolveSuperadminCredential({ envPassword: "", existingHash: "scrypt$deadbeef$cafe" });
    expect(r.generated).toBe(false);
    expect(r.hash).toBeUndefined();
    expect(r.plaintext).toBeUndefined();
  });
});

// --- DB: member credential issuance -----------------------------------------
describe("member credential issuance", () => {
  const caId = newId();
  const orgId = newId();
  const memberSub = `m-${SFX}`;
  let memberId: string;

  beforeAll(async () => {
    await prisma.platCustomerAccount.create({ data: { id: caId, name: `CA m ${SFX}` } });
    await prisma.platOrganization.create({ data: { id: orgId, customerAccountId: caId, name: `Org m ${SFX}`, slug: `org-m-${SFX}` } });
    memberId = (await prisma.platIdentity.create({ data: { id: newId(), subject: memberSub } })).id; // passwordless
    await prisma.platOrgMembership.create({ data: { id: newId(), identityId: memberId, organizationId: orgId } });
  });
  afterAll(async () => {
    await prisma.platAuditEvent.deleteMany({ where: { organizationId: orgId } });
    await prisma.platOrgMembership.deleteMany({ where: { organizationId: orgId } });
    await prisma.platIdentity.deleteMany({ where: { id: memberId } });
    await prisma.platOrganization.deleteMany({ where: { id: orgId } });
    await prisma.platCustomerAccount.deleteMany({ where: { id: caId } });
  });

  it("sets a verifiable hash + must-change flag and audits WITHOUT the plaintext", async () => {
    const pw = await issueMemberCredential(memberId, orgId, null);
    const row = await prisma.platIdentity.findUnique({ where: { id: memberId } });
    expect(verifyPassword(pw, row!.passwordHash)).toBe(true);
    expect(row!.mustChangePassword).toBe(true);
    const audits = await prisma.platAuditEvent.findMany({ where: { organizationId: orgId, action: "identity.credential.issue" } });
    expect(audits.length).toBe(1);
    expect(audits[0].reason ?? "").not.toContain(pw); // the plaintext is never written to the chain
  });
});

// --- End-to-end: login → invite → first-login → change-password -------------
describe("auth routes (e2e via inject)", () => {
  let app: FastifyInstance;
  const caId = newId();
  const orgId = newId();
  const adminSub = `admin-${SFX}`;
  const ADMIN_PW = "admin-pw-strong-1";
  let adminId: string;

  beforeAll(async () => {
    app = await buildServer();
    await prisma.platCustomerAccount.create({ data: { id: caId, name: `CA e2e ${SFX}` } });
    await prisma.platOrganization.create({ data: { id: orgId, customerAccountId: caId, name: `Org e2e ${SFX}`, slug: `org-e2e-${SFX}` } });
    adminId = (await prisma.platIdentity.create({ data: { id: newId(), subject: adminSub, status: "active", passwordHash: hashPassword(ADMIN_PW) } })).id;
    await prisma.platOrgMembership.create({ data: { id: newId(), identityId: adminId, organizationId: orgId } });
    // Owner ⇒ holds organization.administer, so the admin can invite + reset members.
    await assignRole({ organizationId: orgId, principalId: adminId, principalType: "identity", roleKey: "owner", scopeType: "organization", scopeId: orgId });
  });

  afterAll(async () => {
    const ids = (await prisma.platIdentity.findMany({ where: { subject: { contains: SFX } }, select: { id: true } })).map((r) => r.id);
    await prisma.platSession.deleteMany({ where: { identityId: { in: ids } } });
    await prisma.platRoleAssignment.deleteMany({ where: { organizationId: orgId } });
    await prisma.platAuditEvent.deleteMany({ where: { organizationId: orgId } });
    await prisma.platOrgMembership.deleteMany({ where: { organizationId: orgId } });
    await prisma.platIdentity.deleteMany({ where: { id: { in: ids } } });
    await prisma.platOrganization.deleteMany({ where: { id: orgId } });
    await prisma.platCustomerAccount.deleteMany({ where: { id: caId } });
    await app.close();
  });

  beforeEach(() => loginRateLimiter.clear()); // isolate rate-limit state per test

  const login = (subject: string, password: string) =>
    app.inject({ method: "POST", url: "/v1/auth/login", payload: { subject, password } });

  it("logs in a credentialed identity and reports mustChangePassword=false", async () => {
    const res = await login(adminSub, ADMIN_PW);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.token).toBeTruthy();
    expect(body.identity.mustChangePassword).toBe(false);
  });

  it("rate-limits repeated failed logins with a 429 + Retry-After", async () => {
    const sprayed = `ghost-${SFX}`;
    for (let i = 0; i < 8; i++) {
      const r = await login(sprayed, "wrong");
      expect(r.statusCode).toBe(401);
    }
    const blocked = await login(sprayed, "wrong");
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBeTruthy();
  });

  it("invites a member (one-time temp password), who must change it on first sign-in", async () => {
    const adminToken = (await login(adminSub, ADMIN_PW)).json().token;
    const memberSub = `invited-${SFX}`;

    const invite = await app.inject({
      method: "POST",
      url: "/v1/memberships",
      headers: { authorization: `Bearer ${adminToken}`, "x-org-id": orgId },
      payload: { subject: memberSub, email: "invited@corp.test" },
    });
    expect(invite.statusCode).toBe(201);
    const tempPw = invite.json().temporaryPassword as string;
    expect(tempPw).toBeTruthy();

    // The member can sign in with the temp password and is flagged to change it.
    const first = await login(memberSub, tempPw);
    expect(first.statusCode).toBe(200);
    const firstBody = first.json();
    expect(firstBody.identity.mustChangePassword).toBe(true);

    // Self-service change rotates the session and clears the flag.
    const change = await app.inject({
      method: "POST",
      url: "/v1/account/password",
      headers: { authorization: `Bearer ${firstBody.token}`, "x-org-id": orgId },
      payload: { currentPassword: tempPw, newPassword: "my-own-strong-password-9" },
    });
    expect(change.statusCode).toBe(200);
    expect(change.json().token).toBeTruthy();

    // New password works (flag cleared); the old temp password no longer does.
    const reLogin = await login(memberSub, "my-own-strong-password-9");
    expect(reLogin.statusCode).toBe(200);
    expect(reLogin.json().identity.mustChangePassword).toBe(false);
    expect((await login(memberSub, tempPw)).statusCode).toBe(401);
  });

  it("rejects a change with the wrong current password as 403 (not 401 — keeps the session)", async () => {
    const token = (await login(adminSub, ADMIN_PW)).json().token;
    const res = await app.inject({
      method: "POST",
      url: "/v1/account/password",
      headers: { authorization: `Bearer ${token}`, "x-org-id": orgId },
      payload: { currentPassword: "not-the-password", newPassword: "irrelevant-but-long-1" },
    });
    expect(res.statusCode).toBe(403);
  });
});
