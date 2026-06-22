// Ontology metadata + version timeline — the "governance" half of the split
// store. This GENERALIZES the single-tenant .qlerify/history embryo:
//
//   manifest.current      →  PlatOntology.currentVersionId  (+ main branch head)
//   manifest.versions[]   →  PlatOntologyVersion rows  (per (org, ontology))
//   <id>.json snapshot    →  a CONTENT-ADDRESSED blob pair in the CAS
//   sha256(pretty json)   →  manifestHash = sha256(canonical(manifest))
//
// A VERSION is the (workflow.json + overlay.json) PAIR, captured via a small
// per-version manifest blob { workflowHash, overlayHash, summary }. The embryo
// silently dropped overlay.json on roll/restore (it materialized only
// workflow.json); pairing them fixes that — title/rootAggregate/order survive.
//
// All functions take an explicit organizationId. Route handlers MUST pass it
// from the resolved context (scoped-store.orgId(), which throws without a
// context), so a client can never choose the org. Internal provisioning passes
// the org it is operating on directly.

import { prisma } from "../../db.js";
import { setProjectModel } from "../../ontology/model.js";
import { newId } from "../ids.js";
import { canonicalize } from "./canonical.js";
import { fsContentStore as cas } from "./content-store.js";

export interface VersionSummary {
  events: number;
  roles: number;
  boundedContexts: number;
}

/** Count events across the primary + every external bounded context, matching
 * what the loaded ontology actually exposes (mirrors sync.ts summarize). */
function summarize(workflowJson: string): VersionSummary {
  let spec: any;
  try {
    spec = JSON.parse(workflowJson);
  } catch {
    return { events: 0, roles: 0, boundedContexts: 0 };
  }
  const countEvents = (de: unknown) => (de && typeof de === "object" ? Object.keys(de as object).length : 0);
  const external = spec?.externalBoundedContexts ?? {};
  let events = countEvents(spec?.domainEvents);
  for (const bc of Object.values(external)) events += countEvents((bc as any)?.domainEvents);
  return {
    events,
    roles: Array.isArray(spec?.roles) ? spec.roles.length : 0,
    boundedContexts: 1 + Object.keys(external).length,
  };
}

/** env/ws/proj scope collapsed to a single comparable key (§8.2 uniqueness). */
function scopeKeyOf(environmentId?: string | null, workspaceId?: string | null, projectId?: string | null): string {
  return [environmentId ?? "-", workspaceId ?? "-", projectId ?? "-"].join("/");
}

export interface EnsureOntologyParams {
  organizationId: string;
  /** Fixed ids for the seeded system org; omit to mint fresh ones. */
  resourceId?: string;
  ontologyId?: string;
  environmentId?: string | null;
  workspaceId?: string | null;
  /** The project this model belongs to (null = org-level/legacy). */
  projectId?: string | null;
  name: string;
  ownerId: string;
}

/** Idempotently ensure the PlatResource(type=Ontology) + PlatOntology rows for a
 * model exist. Dedup is keyed on (org, project, name) — keying on (org, name)
 * alone would alias every project's model to the first project's, since they all
 * use name "workflow". Returns the resolved ids. Safe to call repeatedly. */
export async function ensureOntologyResource(p: EnsureOntologyParams): Promise<{ resourceId: string; ontologyId: string }> {
  const projectId = p.projectId ?? null;
  const existing = await prisma.platOntology.findFirst({
    where: { organizationId: p.organizationId, projectId, name: p.name },
    select: { id: true, resourceId: true },
  });
  if (existing) return { resourceId: existing.resourceId, ontologyId: existing.id };

  const resourceId = p.resourceId ?? newId();
  const ontologyId = p.ontologyId ?? newId();
  await prisma.platResource.create({
    data: {
      id: resourceId,
      organizationId: p.organizationId,
      environmentId: p.environmentId ?? null,
      workspaceId: p.workspaceId ?? null,
      projectId,
      resourceType: "Ontology",
      name: p.name,
      ownerId: p.ownerId,
      scopeKey: scopeKeyOf(p.environmentId, p.workspaceId, projectId),
    },
  });
  await prisma.platOntology.create({
    data: {
      id: ontologyId,
      organizationId: p.organizationId,
      resourceId,
      environmentId: p.environmentId ?? null,
      workspaceId: p.workspaceId ?? null,
      projectId,
      name: p.name,
    },
  });
  return { resourceId, ontologyId };
}

export interface CreateVersionResult {
  versionId: string;
  seq: number;
  manifestHash: string;
  changed: boolean;
}

/** Capture a new (workflow + overlay) version. A no-op (returns the current
 * version, changed=false) when the pair is byte-identical to the current one. */
export async function createVersion(
  organizationId: string,
  ontologyId: string,
  workflowBytes: string,
  overlayBytes: string | null,
  opts: { source?: string; createdBy?: string | null } = {},
): Promise<CreateVersionResult> {
  // Store the bodies (exact bytes) and build the per-version manifest.
  const workflowHash = cas.put(organizationId, workflowBytes);
  const overlayHash = overlayBytes != null ? cas.put(organizationId, overlayBytes) : null;
  const summary = summarize(workflowBytes);
  const manifestBytes = canonicalize({ workflowHash, overlayHash, summary });
  const manifestHash = cas.put(organizationId, manifestBytes); // = sha256(canonical manifest)

  const ont = await prisma.platOntology.findFirst({
    where: { id: ontologyId, organizationId },
    select: { id: true, currentVersionId: true },
  });
  if (!ont) throw new Error(`ontology ${ontologyId} not found in org ${organizationId}`);

  // Dedup against the current version (the never-stale cache + write-once CAS
  // make this cheap and exact).
  if (ont.currentVersionId) {
    const cur = await prisma.platOntologyVersion.findUnique({
      where: { id: ont.currentVersionId },
      select: { id: true, seq: true, manifestHash: true },
    });
    if (cur && cur.manifestHash === manifestHash) {
      return { versionId: cur.id, seq: cur.seq, manifestHash, changed: false };
    }
  }

  const last = await prisma.platOntologyVersion.findFirst({
    where: { organizationId, ontologyId },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  const seq = (last?.seq ?? -1) + 1;
  const versionId = newId();
  await prisma.platOntologyVersion.create({
    data: {
      id: versionId,
      organizationId,
      ontologyId,
      seq,
      manifestHash,
      contentSize: Buffer.byteLength(workflowBytes),
      source: opts.source ?? "edit",
      summaryJson: JSON.stringify(summary),
      createdBy: opts.createdBy ?? null,
    },
  });
  await prisma.platOntology.update({ where: { id: ontologyId }, data: { currentVersionId: versionId } });

  // Keep a "main" branch ref tracking head (Git-like; manifest.current analogue).
  const main = await prisma.platOntologyBranch.findFirst({ where: { organizationId, ontologyId, name: "main" } });
  if (main) await prisma.platOntologyBranch.update({ where: { id: main.id }, data: { headVersionId: versionId } });
  else await prisma.platOntologyBranch.create({ data: { id: newId(), organizationId, ontologyId, name: "main", headVersionId: versionId } });

  return { versionId, seq, manifestHash, changed: true };
}

export interface VersionContent {
  workflow: string;
  overlay: string | null;
  manifestHash: string;
}

/** Read back a version's (workflow + overlay) bodies from the CAS. */
export async function getVersionContent(organizationId: string, versionId: string): Promise<VersionContent | null> {
  const v = await prisma.platOntologyVersion.findFirst({
    where: { id: versionId, organizationId },
    select: { manifestHash: true },
  });
  if (!v) return null;
  const manifestBytes = cas.get(organizationId, v.manifestHash);
  if (!manifestBytes) return null;
  const manifest = JSON.parse(manifestBytes) as { workflowHash: string; overlayHash: string | null };
  const workflow = cas.get(organizationId, manifest.workflowHash);
  if (workflow == null) return null;
  const overlay = manifest.overlayHash ? cas.get(organizationId, manifest.overlayHash) : null;
  return { workflow, overlay, manifestHash: v.manifestHash };
}

/** The current version's content for an ontology (org-scoped). */
export async function currentContent(organizationId: string, ontologyId: string): Promise<VersionContent | null> {
  const ont = await prisma.platOntology.findFirst({
    where: { id: ontologyId, organizationId },
    select: { currentVersionId: true },
  });
  if (!ont?.currentVersionId) return null;
  return getVersionContent(organizationId, ont.currentVersionId);
}

// --- Scoped queries (org passed by the route from the resolved context) -------

export async function listOntologies(organizationId: string) {
  return prisma.platOntology.findMany({
    where: { organizationId },
    select: { id: true, name: true, resourceId: true, environmentId: true, workspaceId: true, currentVersionId: true, createdAt: true, updatedAt: true },
    orderBy: { createdAt: "asc" },
  });
}

/** A single ontology, scoped to the org — returns null for another org's id
 * (deny-by-default: a cross-org read yields nothing, never another tenant's data). */
export async function getOntologyById(organizationId: string, id: string) {
  return prisma.platOntology.findFirst({ where: { id, organizationId } });
}

/** Bind a project's current model content into the live loader cache, so a
 * subsequent getOntology() (sync, in the handler) returns THIS project's model.
 * Called by the onRequest hook before the handler runs. Returns false when the
 * project has no model yet — getOntology() then throws ModelNotLoadedError and
 * the UI shows the "set this project's model" prompt. There is NO on-disk
 * self-heal anymore: a model arrives only via PUT /v1/project/model. */
export async function ensureProjectModelLoaded(organizationId: string, projectId: string): Promise<boolean> {
  const ont = await prisma.platOntology.findFirst({
    where: { organizationId, projectId, name: "workflow" },
    select: { id: true, currentVersionId: true },
  });
  if (!ont?.currentVersionId) return false;
  const content = await getVersionContent(organizationId, ont.currentVersionId);
  if (!content) return false;
  setProjectModel(projectId, content.workflow, content.overlay, content.manifestHash);
  return true;
}

export async function listVersions(organizationId: string, ontologyId: string) {
  return prisma.platOntologyVersion.findMany({
    where: { organizationId, ontologyId },
    orderBy: { seq: "asc" },
    select: { id: true, seq: true, manifestHash: true, contentSize: true, source: true, summaryJson: true, createdBy: true, createdAt: true },
  });
}
