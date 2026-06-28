// The model-driven event-derivation core: given ingested rows, which domain
// events does the evidence imply? Tests the PURE planner (planDerivation) against
// an inline Onboarding model so it needs no DB / disk / tenant context.

import { describe, it, expect } from "vitest";
import { loadOntologyFromStrings } from "../../src/ontology/model.js";
import { planDerivation } from "../../src/twin/derive.js";

// A minimal Onboarding model in Qlerify's native export shape: Account walks
// AccountRegistered → AccountConfirmed → AccountLoggedIn. status ladder is
// UNCONFIRMED → CONFIRMED. LogIn's fields all come from register, so it has no
// distinguishing row-state evidence.
const WORKFLOW = JSON.stringify({
  version: 1,
  boundedContext: "Identity & Access",
  roles: ["User"],
  domainEvents: {
    AccountRegistered: {
      event: "Account Registered",
      role: "User",
      command: { $ref: "#/schemas/commands/RegisterAccount" },
      aggregateRoot: { $ref: "#/schemas/entities/Account" },
      acceptanceCriteria: ["Given a valid email, When the visitor submits, Then an UNCONFIRMED account is created"],
    },
    AccountConfirmed: {
      event: "Account Confirmed",
      role: "User",
      follows: [{ $ref: "#/domainEvents/AccountRegistered" }],
      command: { $ref: "#/schemas/commands/ConfirmAccount" },
      aggregateRoot: { $ref: "#/schemas/entities/Account" },
      acceptanceCriteria: ["Given an unconfirmed account and a valid code, When submitted, Then the account becomes CONFIRMED"],
    },
    AccountLoggedIn: {
      event: "Account Logged In",
      role: "User",
      follows: [{ $ref: "#/domainEvents/AccountConfirmed" }],
      command: { $ref: "#/schemas/commands/LogIn" },
      aggregateRoot: { $ref: "#/schemas/entities/Account" },
      acceptanceCriteria: ["Given a confirmed account with correct credentials, When the user logs in, Then a session is issued"],
    },
  },
  schemas: {
    entities: {
      Account: {
        required: ["id", "email", "status", "firstname", "lastname"],
        fields: [
          { name: "id", dataType: "string" },
          { name: "email", dataType: "string" },
          { name: "status", dataType: "string", exampleData: ["UNCONFIRMED", "CONFIRMED", "CONFIRMED"] },
          { name: "firstname", dataType: "string" },
          { name: "lastname", dataType: "string" },
        ],
      },
    },
    commands: {
      RegisterAccount: {
        required: ["email", "firstname", "lastname"],
        fields: [{ name: "email" }, { name: "firstname" }, { name: "lastname" }],
      },
      ConfirmAccount: { required: ["id"], fields: [{ name: "id" }, { name: "confirmationCode" }] },
      // LogIn carries only fields already introduced by register → no evidence.
      LogIn: { required: ["email"], fields: [{ name: "id" }, { name: "email" }] },
    },
  },
});

const ont = loadOntologyFromStrings(WORKFLOW, null);

function plan(rows: Array<Record<string, unknown>>) {
  const map = new Map<string, Array<Record<string, unknown>>>([["Account", rows]]);
  const byKey = Object.fromEntries(planDerivation(ont, map).map((p) => [p.key, p]));
  return byKey;
}

describe("planDerivation — Onboarding evidence rules", () => {
  it("classifies the three events by the model alone", () => {
    const p = plan([]);
    // empty rows → no plans emitted at all (nothing to evaluate)
    expect(Object.keys(p)).toHaveLength(0);
  });

  it("fires Account Registered for a confirmed account (create: row + required fields)", () => {
    const p = plan([
      { id: "a1", email: "staffanpalopaa@gmail.com", status: "CONFIRMED", firstname: "Staffan", lastname: "Palopää", createdAt: "2026-06-01T00:00:00.000Z" },
    ]);
    expect(p.AccountRegistered.kind).toBe("create");
    expect(p.AccountRegistered.fired.map((f) => f.aggregateId)).toEqual(["a1"]);
    expect(p.AccountRegistered.fired[0].evidence).toMatch(/required present/);
  });

  it("fires Account Confirmed ONLY for status==CONFIRMED rows (status ladder)", () => {
    const p = plan([
      { id: "a1", email: "a@x.com", status: "CONFIRMED", firstname: "A", lastname: "A" },
      { id: "a2", email: "b@x.com", status: "UNCONFIRMED", firstname: "B", lastname: "B" },
    ]);
    expect(p.AccountConfirmed.kind).toBe("status");
    expect(p.AccountConfirmed.fired.map((f) => f.aggregateId)).toEqual(["a1"]);
    expect(p.AccountConfirmed.noEvidence).toBe(1); // a2 is still UNCONFIRMED

    // Both rows DO get Registered (the create evidence holds for either status).
    expect(p.AccountRegistered.fired.map((f) => f.aggregateId).sort()).toEqual(["a1", "a2"]);
  });

  it("does NOT fire Account Logged In — a login leaves no row-state evidence", () => {
    const p = plan([{ id: "a1", email: "a@x.com", status: "CONFIRMED", firstname: "A", lastname: "A" }]);
    expect(p.AccountLoggedIn.kind).toBe("none");
    expect(p.AccountLoggedIn.fired).toHaveLength(0);
  });

  it("withholds Account Registered when a required field is missing", () => {
    const p = plan([{ id: "a3", email: "c@x.com", status: "CONFIRMED", firstname: "", lastname: "C" }]);
    expect(p.AccountRegistered.fired).toHaveLength(0);
    expect(p.AccountRegistered.noEvidence).toBe(1);
  });

  it("orders an instance's events monotonically (Registered before Confirmed)", () => {
    const p = plan([{ id: "a1", email: "a@x.com", status: "CONFIRMED", firstname: "A", lastname: "A", createdAt: "2026-06-01T00:00:00.000Z" }]);
    const reg = p.AccountRegistered.fired[0].businessAt.getTime();
    const conf = p.AccountConfirmed.fired[0].businessAt.getTime();
    expect(conf).toBeGreaterThan(reg);
  });

  it("carries the row's provenance onto the derived event", () => {
    const p = plan([{ id: "a1", email: "a@x.com", status: "CONFIRMED", firstname: "A", lastname: "A", _provenance: "recorded" }]);
    expect(p.AccountRegistered.fired[0].provenance).toBe("recorded");
  });
});

describe("planDerivation — connector date roles", () => {
  const roles = new Map([["Account", { created: "created_at", updated: "updated_at" }]]);
  const planWithRoles = (rows: Array<Record<string, unknown>>) =>
    Object.fromEntries(planDerivation(ont, new Map([["Account", rows]]), roles).map((p) => [p.key, p]));

  const row = {
    id: "a1", email: "a@x.com", status: "CONFIRMED", firstname: "A", lastname: "A",
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-03-01T00:00:00.000Z",
  };

  it("stamps the create event with the source's creation date", () => {
    const reg = planWithRoles([row]).AccountRegistered.fired[0].businessAt as Date;
    expect(reg.toISOString().startsWith("2026-01-01")).toBe(true);
  });

  it("stamps the update (status) event with the source's last-modified date", () => {
    const conf = planWithRoles([row]).AccountConfirmed.fired[0].businessAt as Date;
    expect(conf.toISOString().startsWith("2026-03-01")).toBe(true);
  });

  it("falls back to the creation date for an update when last-modified is absent", () => {
    const noUpdated = { ...row, updated_at: "" };
    const conf = planWithRoles([noUpdated]).AccountConfirmed.fired[0].businessAt as Date;
    expect(conf.toISOString().startsWith("2026-01-01")).toBe(true);
  });

  it("ignores roles whose column is unparseable, falling back to the row heuristic", () => {
    const bad = new Map([["Account", { created: "created_at" }]]);
    const garbage = { id: "a1", email: "a@x.com", status: "CONFIRMED", firstname: "A", lastname: "A", created_at: "not-a-date", createdAt: "2025-09-09T00:00:00.000Z" };
    const p = Object.fromEntries(planDerivation(ont, new Map([["Account", [garbage]]]), bad).map((x) => [x.key, x]));
    const reg = p.AccountRegistered.fired[0].businessAt as Date;
    expect(reg.toISOString().startsWith("2025-09-09")).toBe(true); // rowBaseDate → row.createdAt
  });
});
