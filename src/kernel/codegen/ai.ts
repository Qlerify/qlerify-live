// The AI region author. Regenerates a single {command}.logic.ts from the natural-
// language Given/When/Then acceptance criteria + the aggregate's field schema —
// the "regenerate AI only" operation. Reuses the Anthropic client pattern from
// src/chat/agent.ts. buildLogicPrompt() is also imported by generate.ts purely to
// hash the prompt (aiPromptHash) for provenance; constructing the prompt has no
// side effects and needs no API key.
//
// CLI:  tsx src/kernel/codegen/ai.ts <CommandName> [BoundedContext]

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { descriptorsForBoundedContext, type CommandDescriptor } from "./introspect.js";
import { getOntology } from "../../ontology/model.js";
import { getAnthropicClient } from "../../llm/anthropic.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..", "..");

export function buildLogicPrompt(d: CommandDescriptor): string {
  const entity = getOntology().entity(d.aggregate);
  const fieldList = (entity?.fields ?? [])
    .map((f) => `  ${f.name}: ${f.dataType ?? "unknown"}${f.description ? " — " + f.description : ""}`)
    .join("\n");
  return [
    `Generate the business-logic region (.logic.ts) for command "${d.commandName}" in bounded context ${d.boundedContext}.`,
    `It emits domain event "${d.eventName}" (ref ${d.eventRef}), role "${d.role}", aggregate ${d.aggregate}.`,
    ``,
    `Given/When/Then acceptance criteria (the source of truth for the logic):`,
    ...d.acceptanceCriteria.map((g) => `- ${g}`),
    ``,
    `Aggregate ${d.aggregate} fields:`,
    fieldList,
    ``,
    `Export exactly three members:`,
    `1. async function apply(ctx: CommandContext<${d.commandName}Args>) — load the aggregate, enforce the Given/When preconditions (throw DomainError on violation, NotFoundError if absent), perform the Then transition with optimistic lock 'version: { increment: 1 }', emit({ ref: "${d.eventRef}", aggregateId, role, payload }), and return the updated aggregate.`,
    `2. async function detect(input: DetectInput): Promise<DetectResult> — given current twin state for an aggregate id, decide whether this event has already happened; return { happened, evidence }.`,
    `3. const DESCRIBE: string — a human-readable explanation of what the command does and how detection works.`,
    `Import the args type: import type { ${d.commandName}Args } from "./${d.kebab}.gen.js";`,
    `Import from ../../db.js (prisma), ../../events/bus.js (emit), ../../errors.js (DomainError, NotFoundError), ../../commands/runtime.js (CommandContext, DetectInput, DetectResult).`,
    `Output only the TypeScript file contents, no markdown fences.`,
  ].join("\n");
}

async function regenerateLogic(commandName: string, bc: string): Promise<string> {
  const d = descriptorsForBoundedContext(bc).find((x) => x.commandName === commandName);
  if (!d) throw new Error(`command ${commandName} not found in bounded context ${bc}`);

  // CLI-invoked (no request/org context) → the resolver falls back to the
  // platform ANTHROPIC_API_KEY; it throws a clear error if that is unset too.
  const { client, model } = await getAnthropicClient();
  const res = await client.messages.create({
    model,
    max_tokens: 2048,
    system: "You write a single TypeScript module. Output only code, no markdown fences, no prose.",
    messages: [{ role: "user", content: buildLogicPrompt(d) }],
  });
  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const code = text.replace(/^```[a-z]*\n?/i, "").replace(/```\s*$/m, "").trim() + "\n";
  const path = join(ROOT, d.dir, `${d.kebab}.logic.ts`);
  writeFileSync(path, code);
  return path;
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const [commandName, bc = "SAP"] = process.argv.slice(2);
  if (!commandName) {
    console.error("usage: tsx src/kernel/codegen/ai.ts <CommandName> [BoundedContext]");
    process.exit(1);
  }
  regenerateLogic(commandName, bc)
    .then((p) => console.log(`regenerated ${p}`))
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
