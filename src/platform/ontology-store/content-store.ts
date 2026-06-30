// Content-addressed blob store (CAS) — the "content" half of the split-store
// answer to "how do we store thousands of workflow.json at scale".
//
// Bodies (the ~100KB workflow.json / overlay.json) are immutable and keyed by
// the sha256 of their exact bytes, sharded two-deep to avoid million-file
// directories:  .qlerify/orgs/<organizationId>/blobs/<hh>/<hash>
//
// Properties this buys, that the loose-files embryo (.qlerify/history) lacks:
//   - dedup            — write-once-by-hash; the embryo stores byte-identical
//                        models many times over, this stores each once per org.
//   - integrity        — the hash IS the check; a corrupted blob fails to match.
//   - immutability     — a blob is never rewritten, so a content hash is a
//                        forever-stable cache key (parsed-ontology LRU upstream).
//
// Isolation decision (confirmed): the CAS is ORG-SCOPED, keyed by the immutable
// organization_id. There is deliberately NO cross-org dedup — cross-tenant
// content existence would be an information oracle that violates §7/§9. At scale
// this directory maps to object storage with prefix-per-org (§12). Filesystem is
// the increment-1 backend behind this interface; S3/GCS is a drop-in later.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { QLERIFY_DIR } from "../../ontology/model.js";
import { sha256 } from "../ids.js";

const ORGS_ROOT = join(QLERIFY_DIR, "orgs");

function blobPath(organizationId: string, hash: string): string {
  return join(ORGS_ROOT, organizationId, "blobs", hash.slice(0, 2), hash);
}

interface ContentStore {
  /** Store bytes write-once; returns their content hash (the blob key). */
  put(organizationId: string, bytes: string): string;
  /** Read a blob's bytes, or null if absent. */
  get(organizationId: string, hash: string): string | null;
  /** Does this org hold a blob with this hash? */
  has(organizationId: string, hash: string): boolean;
}

export const fsContentStore: ContentStore = {
  put(organizationId, bytes) {
    const hash = sha256(bytes);
    const path = blobPath(organizationId, hash);
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes); // write-once: identical bytes ⇒ identical path
    }
    return hash;
  },
  get(organizationId, hash) {
    const path = blobPath(organizationId, hash);
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  },
  has(organizationId, hash) {
    return existsSync(blobPath(organizationId, hash));
  },
};
