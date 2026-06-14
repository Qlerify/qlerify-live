// Conformance: the code must agree with the Qlerify ontology.
//
// These tests are the guardrail that lets the model be the source of truth.
// They fail loudly the moment a command handler emits an event the model
// doesn't define, enforces a role the model doesn't assign, or the simulator
// registry drifts from the model's event set. Keep them green and the model
// and code cannot silently diverge.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadOntology } from "../../src/ontology/model.js";
import { EVENTS } from "../../src/events/registry.js";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "..", "src");

const ontology = loadOntology();
const modelRefs = new Set(ontology.events.map((e) => e.ref));
const VALID_BCS = new Set(ontology.boundedContexts);

// Recursively collect every `*/commands.ts` file under src/.
function commandFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...commandFiles(full));
    else if (entry.name === "commands.ts") out.push(full);
  }
  return out;
}

// Parse the (assertRole, emit-ref) pair out of every exported handler. The
// codegen style is regular: one `assertRole(role, "X")` and one
// `emit({ ref: "#/domainEvents/Y" })` per `export async function`.
interface Handler {
  file: string;
  name: string;
  role: string;
  ref: string;
}

function parseHandlers(): Handler[] {
  const handlers: Handler[] = [];
  for (const file of commandFiles(srcDir)) {
    const content = readFileSync(file, "utf-8");
    for (const chunk of content.split(/export async function /).slice(1)) {
      const role = chunk.match(/assertRole\(\s*role\s*,\s*"([^"]+)"/);
      const ref = chunk.match(/ref:\s*"(#\/domainEvents\/[A-Za-z0-9]+)"/);
      if (role && ref) {
        handlers.push({
          file,
          name: chunk.slice(0, chunk.indexOf("(")).trim(),
          role: role[1]!,
          ref: ref[1]!,
        });
      }
    }
  }
  return handlers;
}

const handlers = parseHandlers();

describe("ontology loads and is well-formed", () => {
  it("has 28 events forming an acyclic follows graph", () => {
    expect(ontology.events).toHaveLength(28);
    expect(ontology.topologicalOrder()).toHaveLength(28);
  });

  it("exposes the expected 7 bounded contexts and 16 roles", () => {
    expect(ontology.boundedContexts).toHaveLength(7);
    expect(ontology.roles).toHaveLength(16);
  });
});

describe("command handlers conform to the model", () => {
  it("found a handler for parsing", () => {
    expect(handlers.length).toBeGreaterThan(0);
  });

  it("emit refs cover exactly the model's events — no orphans, no gaps", () => {
    const emitted = new Set(handlers.map((h) => h.ref));
    expect([...emitted].sort()).toEqual([...modelRefs].sort());
  });

  it.each(handlers.map((h) => [h.name, h] as const))(
    "%s enforces the model's role for the event it emits",
    (_name, h) => {
      const event = ontology.requireEventByRef(h.ref);
      expect(h.role, `${h.name} in ${h.file}`).toBe(event.role);
    },
  );

  it("every enforced role is a valid model role", () => {
    for (const h of handlers) {
      expect(ontology.roles, `${h.name} enforces unknown role "${h.role}"`).toContain(h.role);
    }
  });
});

describe("simulator registry conforms to the model", () => {
  it("covers exactly the model's 28 events", () => {
    expect(EVENTS).toHaveLength(28);
    expect([...new Set(EVENTS.map((e) => e.ref))].sort()).toEqual([...modelRefs].sort());
  });

  it.each(EVENTS.map((e) => [e.name, e] as const))(
    "%s carries model-sourced facts and a valid bounded context/phase",
    (_name, e) => {
      const event = ontology.requireEventByRef(e.ref);
      expect(e.name).toBe(event.name);
      expect(e.role).toBe(event.role);
      expect(e.aggregateRoot).toBe(event.aggregateRoot);
      expect(e.boundedContext).toBe(event.boundedContext);
      expect(VALID_BCS).toContain(e.boundedContext);
      expect(e.phase).toBeGreaterThanOrEqual(1);
      expect(e.phase).toBeLessThanOrEqual(5);
    },
  );
});
