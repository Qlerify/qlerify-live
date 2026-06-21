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

// Recursively collect every file matching a predicate under src/.
function filesMatching(dir: string, match: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesMatching(full, match));
    else if (match(entry.name)) out.push(full);
  }
  return out;
}

// Parse the (assertRole, emit-ref) pair for every command handler. Two handler
// styles coexist and both must conform to the model:
//
//  1. Legacy single-file: one `assertRole(role, "X")` and one
//     `emit({ ref: "#/domainEvents/Y" })` inside the same `export async function`
//     in a `commands.ts`.
//  2. Generated two-file seam (src/kernel/codegen): the role lives in the
//     deterministic `{cmd}.gen.ts` skeleton (assertRole) and the emit ref lives
//     in the AI/hand-authored `{cmd}.logic.ts` apply(). They are paired by the
//     shared filename stem. A `commands.ts` that is a pure re-export barrel
//     contributes nothing here — its handlers are counted via their .gen/.logic.
interface Handler {
  file: string;
  name: string;
  role: string;
  ref: string;
}

const EMIT_REF = /(?:ref|eventRef):\s*"(#\/domainEvents\/[A-Za-z0-9]+)"/;

function parseHandlers(): Handler[] {
  const handlers: Handler[] = [];

  // Style 1 — legacy single-file handlers.
  for (const file of filesMatching(srcDir, (n) => n === "commands.ts")) {
    const content = readFileSync(file, "utf-8");
    for (const chunk of content.split(/export async function /).slice(1)) {
      const role = chunk.match(/assertRole\(\s*role\s*,\s*"([^"]+)"/);
      const ref = chunk.match(/emit\(\{[\s\S]*?ref:\s*"(#\/domainEvents\/[A-Za-z0-9]+)"/);
      if (role && ref) {
        handlers.push({ file, name: chunk.slice(0, chunk.indexOf("(")).trim(), role: role[1]!, ref: ref[1]! });
      }
    }
  }

  // Style 2 — generated .gen.ts (role) paired with sibling .logic.ts (emit ref).
  for (const genFile of filesMatching(srcDir, (n) => n.endsWith(".gen.ts"))) {
    const gen = readFileSync(genFile, "utf-8");
    const role = gen.match(/assertRole\(\s*role\s*,\s*"([^"]+)"/);
    const name = gen.match(/export async function (\w+)/);
    const logic = readFileSync(genFile.replace(/\.gen\.ts$/, ".logic.ts"), "utf-8");
    const ref = logic.match(EMIT_REF);
    if (role && name && ref) {
      handlers.push({ file: genFile, name: name[1]!, role: role[1]!, ref: ref[1]! });
    }
  }

  return handlers;
}

const handlers = parseHandlers();

describe("ontology loads and is well-formed", () => {
  // Model-relative (no magic numbers): a swapped model with a different event /
  // BC / role count must still pass, so we assert internal consistency rather
  // than the specific Ericsson shape.
  it("events form an acyclic follows graph", () => {
    expect(ontology.events.length).toBeGreaterThan(0);
    expect(ontology.topologicalOrder()).toHaveLength(ontology.events.length);
  });

  it("linearOrder covers exactly the model's events, once each", () => {
    const lin = ontology.linearOrder();
    expect(lin).toHaveLength(ontology.events.length);
    expect([...lin].sort()).toEqual(ontology.events.map((e) => e.key).sort());
  });

  it("declares at least one bounded context and one role", () => {
    expect(ontology.boundedContexts.length).toBeGreaterThan(0);
    expect(ontology.roles.length).toBeGreaterThan(0);
  });

  it("every event's role is a declared model role", () => {
    for (const e of ontology.events) {
      expect(ontology.roles, `event ${e.key} role "${e.role}"`).toContain(e.role);
    }
  });
});

describe("command handlers conform to the model", () => {
  it("found a handler for parsing", () => {
    expect(handlers.length).toBeGreaterThan(0);
  });

  it("every handler's emit ref is a real model event", () => {
    for (const h of handlers) {
      expect(modelRefs, `${h.name} in ${h.file}`).toContain(h.ref);
    }
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
  it("covers exactly the model's events, in a linear order", () => {
    expect(EVENTS).toHaveLength(ontology.events.length);
    expect([...new Set(EVENTS.map((e) => e.ref))].sort()).toEqual([...modelRefs].sort());
    // EVENTS order must equal the ontology's linearOrder() (overlay + topo).
    expect(EVENTS.map((e) => e.ref)).toEqual(
      ontology.linearOrder().map((k) => ontology.requireEventByRef(k).ref),
    );
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
    },
  );
});
