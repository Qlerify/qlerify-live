// Connector journal — per-connector chat history + a human-readable doc with
// timestamped update notes. Both are sidecar JSON files kept in a DEDICATED dir
// (`.qlerify/connector-journal/`), deliberately separate from `.qlerify/adapters`
// and `.qlerify/connectors` so they never get picked up by listSidecars() /
// listConnectorIds() (which scan those dirs for `*.json` / `*.mjs`).
//
// Keying: the connector id is `slug(`${boundedContext}-${target}`)`. The CHAT is
// keyed by that slug derived from the table the user is looking at, so a thread
// persists across reloads and exists even before the connector is created. The
// DOC is keyed by the connector's actual id (usually identical; only a custom
// connector id diverges, in which case the doc follows the connector).
//
// Storage is process-global like the rest of the connector subsystem (security
// deferred per the product direction) — see the connector-tenant-isolation gap.

import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { QLERIFY_DIR } from "../../ontology/model.js";

const JOURNAL_DIR = join(QLERIFY_DIR, "connector-journal");
const MAX_NOTES = 100; // keep the doc bounded; oldest notes roll off

export type ConnectorNoteKind =
  | "created" | "built" | "repaired" | "credentials" | "ingested" | "cleared" | "repointed" | "removed" | "note";

export interface ConnectorNote {
  at: string;              // ISO timestamp
  kind: ConnectorNoteKind;
  text: string;
}

export interface ConnectorDoc {
  id: string;
  summary?: string;        // one-line "what this connector does"
  notes: ConnectorNote[];  // newest last
  updatedAt: string;
}

export interface ConnectorChat {
  id: string;
  messages: unknown[];     // Anthropic.MessageParam[] — opaque to this module
  updatedAt: string;
}

/** The deterministic connector/chat id for a (system, target). Mirrors the slug
 * in orchestrate.ts / adapter-routes.ts so all three agree on the key. */
export function connectorChatId(boundedContext: string, target: string): string {
  return slug(`${boundedContext}-${target}`);
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "connector";
}

function ensureDir(): void { mkdirSync(JOURNAL_DIR, { recursive: true }); }
function chatPath(id: string): string { return join(JOURNAL_DIR, `${id}.chat.json`); }
function docPath(id: string): string { return join(JOURNAL_DIR, `${id}.doc.json`); }

function readJson<T>(p: string): T | null {
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")) as T; } catch { return null; }
}

// --- Chat history -----------------------------------------------------------

export function readChat(id: string): ConnectorChat | null {
  return readJson<ConnectorChat>(chatPath(id));
}

export function writeChat(id: string, messages: unknown[]): void {
  ensureDir();
  const chat: ConnectorChat = { id, messages: messages ?? [], updatedAt: new Date().toISOString() };
  writeFileSync(chatPath(id), JSON.stringify(chat, null, 2) + "\n");
}

export function deleteChat(id: string): void {
  const p = chatPath(id);
  if (existsSync(p)) rmSync(p);
}

// --- Doc + update notes -----------------------------------------------------

export function readDoc(id: string): ConnectorDoc | null {
  return readJson<ConnectorDoc>(docPath(id));
}

function writeDoc(doc: ConnectorDoc): void {
  ensureDir();
  writeFileSync(docPath(doc.id), JSON.stringify(doc, null, 2) + "\n");
}

/** Append a timestamped update note, creating the doc if needed. Returns the doc. */
export function appendNote(id: string, kind: ConnectorNoteKind, text: string): ConnectorDoc {
  const doc = readDoc(id) ?? { id, notes: [], updatedAt: "" };
  doc.notes.push({ at: new Date().toISOString(), kind, text });
  if (doc.notes.length > MAX_NOTES) doc.notes = doc.notes.slice(-MAX_NOTES);
  doc.updatedAt = new Date().toISOString();
  writeDoc(doc);
  return doc;
}

/** Set the one-line summary (what the connector does). No-op for empty input. */
export function setConnectorSummary(id: string, summary: string): void {
  const s = (summary ?? "").trim();
  if (!s) return;
  const doc = readDoc(id) ?? { id, notes: [], updatedAt: "" };
  doc.summary = s;
  doc.updatedAt = new Date().toISOString();
  writeDoc(doc);
}

export function deleteDoc(id: string): void {
  const p = docPath(id);
  if (existsSync(p)) rmSync(p);
}
