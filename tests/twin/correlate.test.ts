// Model-driven case correlation: when a workflow moves from one aggregate into
// another, the second aggregate's events must stay attached to the SAME case as
// the first. Tests the PURE core (decideCaseId + foreignKeyFields) against an
// inline two-aggregate model, so it needs no DB / disk / tenant context.
//
// Model: Account (the root) walks AccountRegistered; the workflow then moves into
// Order (OrderPlaced → OrderShipped). Order carries `accountId` — a foreign key
// back to the Account — which is how a derived Order event finds its case.

import { describe, it, expect } from "vitest";
import { loadOntologyFromStrings } from "../../src/ontology/model.js";
import { decideCaseId, fkTargetEntity, foreignKeyFields } from "../../src/twin/correlate.js";

const WORKFLOW = JSON.stringify({
  version: 1,
  boundedContext: "Sales",
  roles: ["Customer", "Clerk"],
  domainEvents: {
    AccountRegistered: {
      event: "Account Registered",
      role: "Customer",
      command: { $ref: "#/schemas/commands/RegisterAccount" },
      aggregateRoot: { $ref: "#/schemas/entities/Account" },
    },
    OrderPlaced: {
      event: "Order Placed",
      role: "Customer",
      follows: [{ $ref: "#/domainEvents/AccountRegistered" }],
      command: { $ref: "#/schemas/commands/PlaceOrder" },
      aggregateRoot: { $ref: "#/schemas/entities/Order" },
    },
    OrderShipped: {
      event: "Order Shipped",
      role: "Clerk",
      follows: [{ $ref: "#/domainEvents/OrderPlaced" }],
      command: { $ref: "#/schemas/commands/ShipOrder" },
      aggregateRoot: { $ref: "#/schemas/entities/Order" },
    },
  },
  schemas: {
    entities: {
      Account: {
        required: ["id", "email"],
        fields: [
          { name: "id", dataType: "string" },
          { name: "email", dataType: "string" },
        ],
      },
      Order: {
        required: ["id", "accountId"],
        fields: [
          { name: "id", dataType: "string" },
          { name: "accountId", dataType: "string" }, // FK back to Account (the case spine)
          { name: "status", dataType: "string", exampleData: ["PLACED", "SHIPPED"] },
        ],
      },
    },
    commands: {
      RegisterAccount: { required: ["email"], fields: [{ name: "email" }] },
      PlaceOrder: { required: ["accountId"], fields: [{ name: "accountId" }] },
      ShipOrder: { required: ["id"], fields: [{ name: "id" }] },
    },
  },
});

const ont = loadOntologyFromStrings(WORKFLOW, null);

// A resolver standing in for the EventLog lookup: instance-id → caseId.
const resolver = (known: Record<string, string>) => (id: string) => known[id] ?? null;

describe("case correlation — the FK linking heuristic", () => {
  it("recognises Account as the case root (the first aggregate)", () => {
    expect(ont.rootAggregate).toBe("Account");
  });

  it("reads accountId on Order as a foreign key to Account", () => {
    const fks = foreignKeyFields("Order", ont);
    expect(fks).toEqual([{ name: "accountId", target: "Account" }]);
    // The root aggregate has no outgoing FK.
    expect(foreignKeyFields("Account", ont)).toEqual([]);
  });

  it("scopes the root aggregate to its own id (a case starts here)", () => {
    const c = decideCaseId(ont, "Account", "acc-1", { email: "a@x.com" }, resolver({}));
    expect(c).toBe("acc-1");
  });

  it("links an Order back to its Account's case via accountId — the chain holds", () => {
    // The Account's create already recorded case "acc-1" for instance "acc-1".
    const caseOf = resolver({ "acc-1": "acc-1" });
    const c = decideCaseId(ont, "Order", "ord-9", { accountId: "acc-1", status: "PLACED" }, caseOf);
    expect(c).toBe("acc-1"); // NOT "ord-9" — that was the bug
  });

  it("keeps a later Order event in the case its create already joined", () => {
    // ord-9's OrderPlaced already correlated to acc-1; OrderShipped carries no FK
    // of its own but the self-lookup keeps it attached.
    const caseOf = resolver({ "acc-1": "acc-1", "ord-9": "acc-1" });
    const c = decideCaseId(ont, "Order", "ord-9", { id: "ord-9", status: "SHIPPED" }, caseOf);
    expect(c).toBe("acc-1");
  });

  it("starts a fresh case when the FK references nothing known yet", () => {
    // No Account in the log → the Order anchors its own (degenerate) case.
    const c = decideCaseId(ont, "Order", "ord-9", { accountId: "acc-unknown" }, resolver({}));
    expect(c).toBe("ord-9");
  });

  it("honours an explicit caseId in the payload over any inference", () => {
    const c = decideCaseId(ont, "Order", "ord-9", { caseId: "case-forced", accountId: "acc-1" }, resolver({ "acc-1": "acc-1" }));
    expect(c).toBe("case-forced");
  });
});

// Acronym-named entities: "gprId" naively capitalizes to "Gpr", which is NOT the
// entity's name ("GPR") — the FK-by-name match must be case-insensitive or the
// downstream aggregate fragments into its own case (the real-world break: SoA
// rows carrying gprId derived into cases disconnected from their GPR's flow).
const ACRONYM_WORKFLOW = JSON.stringify({
  version: 1,
  boundedContext: "Compliance",
  roles: ["Analyst"],
  domainEvents: {
    GPRCreated: {
      event: "GPR Created",
      role: "Analyst",
      command: { $ref: "#/schemas/commands/CreateGPR" },
      aggregateRoot: { $ref: "#/schemas/entities/GPR" },
    },
    SoAIdentified: {
      event: "GPR Applicability Identified (SoA)",
      role: "Analyst",
      follows: [{ $ref: "#/domainEvents/GPRCreated" }],
      command: { $ref: "#/schemas/commands/IdentifySoA" },
      aggregateRoot: { $ref: "#/schemas/entities/SoA" },
    },
  },
  schemas: {
    entities: {
      GPR: {
        required: ["id"],
        fields: [
          { name: "id", dataType: "string" },
          { name: "title", dataType: "string" },
        ],
      },
      SoA: {
        required: ["id", "gprId"],
        fields: [
          { name: "id", dataType: "string" },
          { name: "gprId", dataType: "string" }, // FK back to GPR — only findable case-insensitively
        ],
      },
    },
    commands: {
      CreateGPR: { required: ["title"], fields: [{ name: "title" }] },
      IdentifySoA: { required: ["gprId"], fields: [{ name: "gprId" }] },
    },
  },
});

const acronymOnt = loadOntologyFromStrings(ACRONYM_WORKFLOW, null);

describe("case correlation — acronym entity names (GPR, SoA)", () => {
  it("resolves *Id fields to acronym entities case-insensitively, returning the real name", () => {
    expect(fkTargetEntity("gprId", acronymOnt)).toBe("GPR");
    expect(fkTargetEntity("soaId", acronymOnt)).toBe("SoA"); // mixed-case acronym ("Soa" ≠ "SoA" naively)
    expect(fkTargetEntity("title", acronymOnt)).toBeUndefined(); // not *Id-shaped
    expect(fkTargetEntity("orderId", acronymOnt)).toBeUndefined(); // no such entity here
  });

  it("reads gprId on SoA as a foreign key to GPR", () => {
    expect(foreignKeyFields("SoA", acronymOnt)).toEqual([{ name: "gprId", target: "GPR" }]);
  });

  it("links a SoA back to its GPR's case via gprId", () => {
    // GPR-013 already correlated into case MCR-013 (its own upstream spine).
    const caseOf = resolver({ "GPR-013": "MCR-013" });
    const c = decideCaseId(acronymOnt, "SoA", "SOA-013", { gprId: "GPR-013", id: "SOA-013" }, caseOf);
    expect(c).toBe("MCR-013"); // NOT "SOA-013" — that was the bug
  });
});
