import { randomUUID } from "node:crypto";

export function newId(prefix?: string): string {
  const u = randomUUID();
  return prefix ? `${prefix}-${u.slice(0, 8)}` : u;
}
