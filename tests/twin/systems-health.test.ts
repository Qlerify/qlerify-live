// The Systems health board core: given the wired adapters and per-table row
// counts, what connection status does each entity/value object get? Tests the
// PURE builder (buildSystemsHealth) against an inline two-BC model so it needs no
// DB / disk / tenant context — the same shape as derive.test.ts.

import { describe, it, expect } from "vitest";
import { loadOntologyFromStrings } from "../../src/ontology/model.js";
import { buildSystemsHealth, type AdapterRef } from "../../src/twin/systems-health.js";

// Sales owns Order (refs an Address value object) + Invoice; Billing owns Receipt.
const WORKFLOW = JSON.stringify({
  version: 1,
  boundedContext: "Sales",
  roles: ["Clerk"],
  domainEvents: {
    OrderPlaced: {
      event: "Order Placed",
      role: "Clerk",
      command: { $ref: "#/schemas/commands/PlaceOrder" },
      aggregateRoot: { $ref: "#/schemas/entities/Order" },
      acceptanceCriteria: ["Given a cart, When placed, Then an Order exists"],
    },
    InvoiceIssued: {
      event: "Invoice Issued",
      role: "Clerk",
      command: { $ref: "#/schemas/commands/IssueInvoice" },
      aggregateRoot: { $ref: "#/schemas/entities/Invoice" },
      acceptanceCriteria: ["Given an order, When invoiced, Then an Invoice exists"],
    },
  },
  schemas: {
    entities: {
      Order: {
        required: ["id"],
        fields: [
          { name: "id", dataType: "string" },
          { name: "shipTo", relatedEntity: { $ref: "#/schemas/valueObjects/Address" } },
        ],
      },
      Invoice: { required: ["id"], fields: [{ name: "id", dataType: "string" }] },
    },
    commands: {
      PlaceOrder: { required: ["id"], fields: [{ name: "id" }] },
      IssueInvoice: { required: ["id"], fields: [{ name: "id" }] },
    },
    valueObjects: {
      Address: { required: ["street"], fields: [{ name: "street", dataType: "string" }] },
    },
  },
  externalBoundedContexts: {
    Billing: {
      domainEvents: {
        ReceiptRecorded: {
          event: "Receipt Recorded",
          role: "Clerk",
          command: { $ref: "#/schemas/commands/RecordReceipt" },
          aggregateRoot: { $ref: "#/schemas/entities/Receipt" },
          acceptanceCriteria: ["Given a payment, When recorded, Then a Receipt exists"],
        },
      },
      schemas: {
        entities: { Receipt: { required: ["id"], fields: [{ name: "id", dataType: "string" }] } },
        commands: { RecordReceipt: { required: ["id"], fields: [{ name: "id" }] } },
      },
    },
  },
});

const ont = loadOntologyFromStrings(WORKFLOW, null);

const sys = (board: ReturnType<typeof buildSystemsHealth>, name: string) =>
  board.systems.find((s) => s.name === name)!;
const tbl = (section: ReturnType<typeof sys>, name: string) =>
  section.tables.find((t) => t.name === name)!;

describe("buildSystemsHealth — 4-state classification", () => {
  // Order: live adapter + rows → live. Address (VO): adapter, 0 rows → wired_empty.
  // Invoice: no adapter → no_adapter. Receipt: recorded adapter + rows → simulated.
  const adapters: AdapterRef[] = [
    { id: "sap-orders", boundedContext: "Sales", targetEntity: "Order", mode: "live" },
    { id: "addr-vo", boundedContext: "Sales", targetEntity: "Address", mode: "simulated" },
    { id: "billing-rec", boundedContext: "Billing", targetEntity: "Receipt", mode: "recorded" },
  ];
  const rowCounts = new Map<string, number>([["Order", 1200], ["Address", 0], ["Receipt", 340]]);
  const board = buildSystemsHealth(ont, adapters, rowCounts);

  it("classifies a live, wired-but-empty, no-adapter, and simulated table", () => {
    const order = tbl(sys(board, "Sales"), "Order");
    expect(order).toMatchObject({ status: "live", kind: "entity", rows: 1200, mode: "live", adapterId: "sap-orders", detail: "live · 1,200 rows" });

    const address = tbl(sys(board, "Sales"), "Address");
    expect(address).toMatchObject({ status: "wired_empty", kind: "valueObject", rows: 0, adapterId: "addr-vo", detail: "adapter set · no data" });

    const invoice = tbl(sys(board, "Sales"), "Invoice");
    expect(invoice).toMatchObject({ status: "no_adapter", kind: "entity", mode: null, adapterId: null, detail: "no adapter" });

    const receipt = tbl(sys(board, "Billing"), "Receipt");
    expect(receipt).toMatchObject({ status: "simulated", rows: 340, mode: "recorded", detail: "recorded · 340 rows" });
  });

  it("computes per-section connected/total and a global gaps count", () => {
    expect(sys(board, "Sales")).toMatchObject({ connected: 1, total: 3 }); // Order live; Invoice + Address are gaps
    expect(sys(board, "Billing")).toMatchObject({ connected: 1, total: 1 });
    expect(board.gaps).toBe(2); // Invoice (no adapter) + Address (wired, empty)
  });

  it("lists a value object only under the system whose entity references it", () => {
    expect(sys(board, "Sales").tables.some((t) => t.name === "Address")).toBe(true);
    expect(sys(board, "Billing").tables.some((t) => t.name === "Address")).toBe(false);
  });

  it("defaults an entity with no row count to 0 rows (wired_empty / no_adapter)", () => {
    const b = buildSystemsHealth(ont, [{ id: "x", boundedContext: "Sales", targetEntity: "Invoice", mode: "live" }], new Map());
    expect(tbl(sys(b, "Sales"), "Invoice").status).toBe("wired_empty");
    expect(tbl(sys(b, "Sales"), "Order").status).toBe("no_adapter");
  });
});

describe("buildSystemsHealth — multiple adapters on one table", () => {
  it("the highest mode wins the dot (live > recorded > simulated)", () => {
    const adapters: AdapterRef[] = [
      { id: "order-sim", boundedContext: "Sales", targetEntity: "Order", mode: "simulated" },
      { id: "order-live", boundedContext: "Sales", targetEntity: "Order", mode: "live" },
    ];
    const b = buildSystemsHealth(ont, adapters, new Map([["Order", 5]]));
    const order = tbl(sys(b, "Sales"), "Order");
    expect(order.status).toBe("live");
    expect(order.adapterId).toBe("order-live");
  });
});
