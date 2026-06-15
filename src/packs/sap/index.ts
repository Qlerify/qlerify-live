// First real pack (Part 2.2) — the increment that forces src/packs/ into being.
// It starts as a SIMULATED adapter so it runs with zero credentials and lands
// believable PurchaseOrder rows in the ingestion store immediately. The wizard
// (2.3) climbs the mode ladder; the real SAP OData connector body + the alias
// fieldMap (SAP "Supplier" → model "supplierId", "PurchasingDocument" → "id",
// "NetPriceAmount" → "price", …) are authored at the recorded/live rung (2.4),
// and applyFieldMap normalizes on pull — alias-first, no model mutation.

import { createSimulatedAdapter } from "../adapters/simulated.js";
import type { Pack } from "../types.js";

export const pack: Pack = {
  name: "SAP",
  adapters: [
    createSimulatedAdapter({
      id: "sap-purchase-order",
      boundedContext: "SAP",
      targetEntity: "PurchaseOrder",
      seed: 42,
    }),
  ],
};
