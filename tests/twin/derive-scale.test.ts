// The batched derivation path at scale: deriveFromData() must cover EVERY
// ingested row (the old default windowed an arbitrary 1000 per entity — rows
// beyond it silently produced no events), correlate each child aggregate into
// its parent's case across the whole set, and stay idempotent. Uses more rows
// than the old window precisely to pin the regression.

import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "../../src/db.js";
import { getOntology } from "../../src/ontology/model.js";
import { deriveFromData } from "../../src/twin/derive.js";
import * as store from "../../src/twin/projection-store.js";
import { modelHarness } from "../helpers/po-model.js";

// Account (root) → Order (child carrying an accountId FK): the two-aggregate
// shape whose case correlation fragments if any window drops a parent row.
const SHOP_MODEL = JSON.stringify({
  version: 1,
  boundedContext: "Shop",
  roles: ["User"],
  domainEvents: {
    AccountRegistered: {
      event: "Account Registered",
      role: "User",
      command: { $ref: "#/schemas/commands/RegisterAccount" },
      aggregateRoot: { $ref: "#/schemas/entities/Account" },
    },
    OrderPlaced: {
      event: "Order Placed",
      role: "User",
      follows: [{ $ref: "#/domainEvents/AccountRegistered" }],
      command: { $ref: "#/schemas/commands/PlaceOrder" },
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
          { name: "accountId", dataType: "string" },
        ],
      },
    },
    commands: {
      RegisterAccount: { required: ["email"], fields: [{ name: "email" }] },
      PlaceOrder: { required: ["accountId"], fields: [{ name: "accountId" }] },
    },
  },
});

// Above the old per-entity window of 1000, so a regression to any fixed cap
// fails the totals below.
const N = 1200;

const model = modelHarness(SHOP_MODEL);

afterAll(async () => {
  await prisma.eventLog.deleteMany({ where: { workflowId: model.workflowId } });
  await store.dropProjectionTablesForWorkflow(model.workflowId);
});

describe("deriveFromData at scale (batched, uncapped)", () => {
  it("derives events for every row, correlates children into their parents' cases, and stays idempotent", () =>
    model.run(async () => {
      const ont = getOntology();
      await store.ensureTable(ont.entity("Account")!);
      await store.ensureTable(ont.entity("Order")!);
      for (let i = 0; i < N; i++) await store.insert("Account", { id: `acc-${i}`, email: `u${i}@example.test` });
      for (let i = 0; i < N; i++) await store.insert("Order", { id: `ord-${i}`, accountId: `acc-${i}` });

      // Preview reports the full plan without writing.
      const dry = await deriveFromData({ preview: true });
      expect(dry.totalEmitted).toBe(2 * N);
      expect(await prisma.eventLog.count({ where: { workflowId: model.workflowId } })).toBe(0);

      const r = await deriveFromData();
      expect(r.totalEmitted).toBe(2 * N);
      expect(r.instances).toBe(2 * N);

      // Every account starts its own case; every order inherited its account's.
      const events = await prisma.eventLog.findMany({
        where: { workflowId: model.workflowId },
        select: { aggregateRoot: true, aggregateId: true, caseId: true },
      });
      expect(events).toHaveLength(2 * N);
      for (const e of events) {
        if (e.aggregateRoot === "Account") expect(e.caseId).toBe(e.aggregateId);
        else expect(e.caseId).toBe(e.aggregateId.replace("ord-", "acc-"));
      }

      // Idempotent: a second pass emits nothing and reports everything present.
      const again = await deriveFromData();
      expect(again.totalEmitted).toBe(0);
      expect(again.events.reduce((n, s) => n + s.alreadyPresent, 0)).toBe(2 * N);
    }));
});
