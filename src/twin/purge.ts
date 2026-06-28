// Wipe one entity's ingested data: its gen_ projection rows AND the simulated
// events derived from them. Shared by "Delete all rows" (bc-routes), "Reset
// connector" (bc-routes + connector-routes), so all three agree on what "purge a
// table's data" means: rows go, and the events rooted at that aggregate go with
// them (the event store is a best-effort simulation OF the rows — see twin/derive).
// Both deletes are scoped to the active workflow/org. A value object is no
// aggregate's root, so its event count is always 0.

import { prisma } from "../db.js";
import { eventLogOrgWhere } from "../platform/tenancy/event-scope.js";
import * as store from "./projection-store.js";

export async function purgeEntityData(entity: string): Promise<{ rows: number; events: number; tableExisted: boolean }> {
  const tableExisted = await store.tableExists(entity);
  const rows = tableExisted ? await store.clearTable(entity) : 0;
  const { count: events } = await prisma.eventLog.deleteMany({
    where: { aggregateRoot: entity, ...eventLogOrgWhere() },
  });
  return { rows, events, tableExisted };
}
