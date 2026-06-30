// Vitest global setup: apply the additive schema upgrades once before the suite,
// so tests that emit events (new EventLog actor columns) or record audit rows
// pass regardless of which test runs first and without requiring a `prisma db
// push` (which would drop the gen_ projection tables). Idempotent.

import { ensureSchemaUpgrades } from "../../src/platform/db/schema-upgrade.js";

export default async function setup() {
  await ensureSchemaUpgrades();
}
