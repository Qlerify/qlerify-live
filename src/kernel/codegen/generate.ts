// The deterministic generator. For a bounded context it (re)emits each command's
// .gen.ts skeleton, the aggregate's commands.ts barrel, and the side-effect
// registry, then records per-command codegen state in .qlerify/codegen.commands.json.
//
// Idempotent: a re-run with an unchanged model writes nothing and leaves the
// manifest byte-identical (generatedAt is preserved when hashes + content are
// unchanged). The .logic.ts files are NEVER overwritten here — they are the
// preserved AI/hand-authored region; regenerate them explicitly via ai.ts.
//
// CLI:  tsx src/kernel/codegen/generate.ts [BoundedContext]   (default SAP)

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { QLERIFY_DIR } from "../../ontology/model.js";
import { descriptorsForBoundedContext, sha256 } from "./introspect.js";
import { genContent, barrelContent, registryContent } from "./emit.js";
import { buildLogicPrompt } from "./ai.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..", ".."); // src/kernel/codegen -> repo root
const MANIFEST = join(QLERIFY_DIR, "codegen.commands.json");
const MODEL = process.env.CHAT_MODEL ?? "claude-sonnet-4-6";

function writeIfChanged(absPath: string, content: string): "written" | "unchanged" {
  if (existsSync(absPath) && readFileSync(absPath, "utf-8") === content) return "unchanged";
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, content);
  return "written";
}

interface Manifest {
  generator: string;
  boundedContexts: string[];
  commands: Record<string, any>;
}

export interface GenerateResult {
  written: string[];
  unchanged: string[];
  warnings: string[];
}

export function generateBoundedContext(bc: string): GenerateResult {
  const ds = descriptorsForBoundedContext(bc);
  if (ds.length === 0) throw new Error(`no commands found for bounded context "${bc}"`);

  const prev: Manifest = existsSync(MANIFEST)
    ? JSON.parse(readFileSync(MANIFEST, "utf-8"))
    : { generator: "src/kernel/codegen", boundedContexts: [], commands: {} };

  const written: string[] = [];
  const unchanged: string[] = [];
  const warnings: string[] = [];
  const commands: Record<string, any> = { ...prev.commands };

  const track = (path: string, status: "written" | "unchanged") =>
    (status === "written" ? written : unchanged).push(path);

  for (const d of ds) {
    const genRel = `${d.dir}/${d.kebab}.gen.ts`;
    const genStatus = writeIfChanged(join(ROOT, genRel), genContent(d));
    track(genRel, genStatus);

    const logicRel = `${d.dir}/${d.kebab}.logic.ts`;
    if (!existsSync(join(ROOT, logicRel))) {
      warnings.push(`missing logic file ${logicRel} — author apply()/detect()/DESCRIBE (codegen ai or by hand)`);
    }

    const prevRec = prev.commands?.[d.commandName];
    const stable = !!prevRec && prevRec.gwtHash === d.gwtHash && prevRec.schemaHash === d.schemaHash && genStatus === "unchanged";
    commands[d.commandName] = {
      boundedContext: d.boundedContext,
      handlerName: d.handlerName,
      route: `/commands/${d.bcDir}/${d.kebab}`,
      eventRef: d.eventRef,
      role: d.role,
      files: { gen: genRel, logic: logicRel },
      gwtHash: d.gwtHash,
      schemaHash: d.schemaHash,
      aiModel: prevRec?.aiModel ?? MODEL,
      aiPromptHash: sha256(buildLogicPrompt(d)),
      logicAuthor: prevRec?.logicAuthor ?? "hand",
      generatedAt: stable ? prevRec.generatedAt : new Date().toISOString(),
    };
  }

  const barrelRel = `${ds[0].dir}/commands.ts`;
  track(barrelRel, writeIfChanged(join(ROOT, barrelRel), barrelContent(ds, ds[0].aggregate, bc)));

  const registryRel = `src/commands/registry.generated.ts`;
  track(registryRel, writeIfChanged(join(ROOT, registryRel), registryContent(ds)));

  const nextManifest: Manifest = {
    generator: "src/kernel/codegen",
    boundedContexts: [...new Set([...(prev.boundedContexts ?? []), bc])].sort(),
    commands,
  };
  track(".qlerify/codegen.commands.json", writeIfChanged(MANIFEST, JSON.stringify(nextManifest, null, 2) + "\n"));

  return { written, unchanged, warnings };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const bc = process.argv[2] ?? "SAP";
  const r = generateBoundedContext(bc);
  for (const w of r.warnings) console.warn(`⚠️  ${w}`);
  console.log(`codegen ${bc}: ${r.written.length} written, ${r.unchanged.length} unchanged`);
  for (const p of r.written) console.log(`  + ${p}`);
  for (const p of r.unchanged) console.log(`  = ${p}`);
}
