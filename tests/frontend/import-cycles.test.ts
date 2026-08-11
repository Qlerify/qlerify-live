import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";

const SRC = resolve(process.cwd(), "frontend/src");

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(p) ? [p] : [];
  });

// `import type` / `export type` are erased by verbatimModuleSyntax — not runtime edges.
const runtimeSpecifiers = (text: string): string[] => {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!/^\s*(?:import|export)\b/.test(line) || /^\s*(?:import|export)\s+type\b/.test(line)) {
      continue;
    }
    const here = line.match(/from\s+"([^"]+)"/) ?? line.match(/^\s*import\s+"([^"]+)"/);
    if (here) {
      out.push(here[1]!);
      continue;
    }
    if (!/^\s*(?:import|export)\s*\{[^}]*$/.test(line)) {
      continue;
    }
    for (let j = i + 1; j < lines.length; j++) {
      const closing = lines[j]!.match(/^\s*}\s*from\s+"([^"]+)"/);
      if (closing) {
        out.push(closing[1]!);
        i = j;
        break;
      }
      if (/^\s*(?:import|export)\b/.test(lines[j]!)) {
        break;
      }
    }
  }
  return out;
};

const resolveSpec = (fromFile: string, spec: string): string | null => {
  let target: string | null = null;
  if (spec.startsWith("@/")) {
    target = join(SRC, spec.slice(2));
  } else if (spec.startsWith("./") || spec.startsWith("../")) {
    target = resolve(dirname(fromFile), spec);
  }
  return target && existsSync(target) ? target : null;
};

const findCycles = (): string[][] => {
  const files = walk(SRC);
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const deps = runtimeSpecifiers(readFileSync(file, "utf8"))
      .map((s) => resolveSpec(file, s))
      .filter((p): p is string => Boolean(p));
    graph.set(file, deps);
  }

  const state = new Map<string, number>();
  const stack: string[] = [];
  const cycles: string[][] = [];

  const visit = (node: string) => {
    state.set(node, 1);
    stack.push(node);
    for (const dep of graph.get(node) ?? []) {
      if (state.get(dep) === 1) {
        cycles.push([...stack.slice(stack.indexOf(dep)), dep].map((p) => relative(SRC, p)));
      } else if (!state.has(dep)) {
        visit(dep);
      }
    }
    stack.pop();
    state.set(node, 2);
  };

  for (const f of files) {
    if (!state.has(f)) {
      visit(f);
    }
  }
  return cycles;
};

describe("frontend module graph", () => {
  it("has no circular runtime imports", () => {
    const cycles = findCycles();
    expect(cycles.map((c) => c.join(" -> "))).toEqual([]);
  });

  it("keeps the store independent of the query engine", () => {
    const store = readFileSync(join(SRC, "lib/store.ts"), "utf8");
    expect(runtimeSpecifiers(store).some((s) => s.endsWith("ovquery.ts"))).toBe(false);
  });
});
