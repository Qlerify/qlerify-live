// AI recommendations over the deterministic frontier. Strict two-layer split:
// planNextActions produces the CANDIDATE SET (deterministic eligibility from
// the model); the LLM only ranks and phrases within it. Every AI item is
// validated against the closed set — an AI-suggested action that isn't a
// candidate is dropped, never surfaced (the classifyDateRolesAI pattern).
//
// Lazy recompute: the stored blob carries (model content hash, event-log
// watermark). A model swap mints a new ontologyCacheKey and a data change
// moves the watermark, so freshness is a pure comparison — no apply hook, and
// the GET path NEVER calls the LLM (it rides the 5s poll). Generation happens
// only on the explicit refresh POST.

import type Anthropic from "@anthropic-ai/sdk";
import { LlmError } from "../errors.js";
import { friendlyLlmError, getAnthropicClient } from "../llm/anthropic.js";
import { getOntology, ontologyCacheKey, type Ontology } from "../ontology/model.js";
import { currentWorkflowId } from "../platform/tenancy/context.js";
import { computeNextActions, type NextAction, type NextActionsResult } from "./next-actions.js";
import { getMeta, setMeta } from "./projection-store.js";

/** Minimal logger surface (Fastify's req.log fits) so the ORIGINAL provider
 * error can be recorded server-side before friendlyLlmError strips it. */
export interface RefreshLogger {
  error(obj: unknown, msg?: string): void;
}

export interface RecommendationItem {
  caseId: string;
  eventRef: string;
  role: string;
  /** 1 = do first; dense ranks after validation. */
  priority: number;
  /** One-sentence AI rationale, ≤240 chars. */
  why: string;
}

export interface StoredRecommendations {
  version: 1;
  /** ontologyCacheKey() at generation — a model swap changes it. */
  modelKey: string;
  /** eventLogWatermark() at generation — any emit/wipe moves it. */
  watermark: string;
  generatedAt: string;
  llmModel: string;
  /** One-paragraph "state of the workflow" from the ranking pass. */
  summary: string;
  items: RecommendationItem[];
}

export interface RecommendationsView {
  /** none = never generated; fresh = matches current model+data; stale = kept
   * but the model or data changed since — regenerate via the refresh POST. */
  status: "none" | "fresh" | "stale";
  recs: StoredRecommendations | null;
  /** Stored items whose (case, step) is no longer in the candidate set. */
  dropped: number;
}

const metaKey = () => `recs:${currentWorkflowId()}`;
/** The `recs:` prefix, exported so deleteWorkflow can clean a workflow's blob. */
export const RECS_META_PREFIX = "recs:";

// The prompt caps how much case state the LLM sees; everything is still
// validated against the FULL candidate set, so a beyond-cap action can never
// be hallucinated in — it just goes unranked (deterministic order fills in).
const MAX_PROMPT_CASES = 100;
const MAX_PROMPT_ACTIONS = 200;
const MAX_WHY_CHARS = 240;
// The OUTPUT is capped harder than the input: ~90 output tokens per ranked
// item means a full 200-item ranking could never fit any sane max_tokens —
// the reply would truncate mid-JSON and parse to nothing. Top-N ranked (the
// rest stays in deterministic order) keeps the reply well inside the budget.
const MAX_RANKED_ITEMS = 40;
const GENERATE_MAX_TOKENS = 8192;

const itemKey = (caseId: string, eventRef: string) => `${caseId}|${eventRef}`;

/** Load + re-validate the stored blob against the CURRENT candidate set.
 * Never calls the LLM. */
export async function getRecommendations(): Promise<RecommendationsView> {
  const raw = await getMeta(metaKey());
  if (!raw) return { status: "none", recs: null, dropped: 0 };
  let stored: StoredRecommendations;
  try {
    stored = JSON.parse(raw) as StoredRecommendations;
  } catch {
    return { status: "none", recs: null, dropped: 0 };
  }
  const current = await computeNextActions({ limit: null });
  const valid = new Set(current.actions.map((a) => itemKey(a.caseId, a.eventRef)));
  const items = stored.items.filter((i) => valid.has(itemKey(i.caseId, i.eventRef)));
  const fresh = stored.modelKey === ontologyCacheKey() && stored.watermark === current.watermark;
  return {
    status: fresh ? "fresh" : "stale",
    recs: { ...stored, items },
    dropped: stored.items.length - items.length,
  };
}

/** Compact model+state serializer for the ranking prompt. Deliberately NOT the
 * chat systemBlocks (chat-flavored, cached per chat model, huge). */
export function buildRecommendationPrompt(ont: Ontology, result: NextActionsResult): string {
  const steps = ont
    .linearOrder()
    .map((k, i) => {
      const e = ont.eventByKey(k)!;
      const follows = e.predecessors.length ? ` — follows: ${e.predecessors.join(", ")}` : " — entry step";
      return `${i + 1}. [${e.key}] "${e.name}" (${e.role} · ${e.boundedContext})${follows}`;
    })
    .join("\n");

  const byCase = new Map<string, NextAction[]>();
  for (const a of result.actions) {
    const arr = byCase.get(a.caseId);
    if (arr) arr.push(a);
    else byCase.set(a.caseId, [a]);
  }
  // Most attention-needing cases first (actions are already sorted worst-first).
  let actionCount = 0;
  const caseBlocks: string[] = [];
  for (const [caseId, actions] of byCase) {
    if (caseBlocks.length >= MAX_PROMPT_CASES || actionCount >= MAX_PROMPT_ACTIONS) break;
    const head = actions[0]!;
    const age = head.dwellDays != null ? `${head.dwellDays} day(s) since last activity${head.stale ? " — STALE" : ""}` : "no timestamps";
    const lines = actions.slice(0, MAX_PROMPT_ACTIONS - actionCount).map(
      (a) => `  - eventRef ${a.eventRef} — "${a.eventName}" (${a.role}): ${a.why}`,
    );
    actionCount += lines.length;
    caseBlocks.push(`Case ${caseId} (${age}):\n${lines.join("\n")}`);
  }

  return [
    `Workflow: "${ont.title}" (root aggregate: ${ont.rootAggregate}). Steps in model order:`,
    steps,
    ``,
    `Open next actions per case — each line is one CANDIDATE (an unblocked step). This list is the complete universe: rank ONLY these; never invent a step or a case.`,
    ``,
    caseBlocks.join("\n\n"),
    ``,
    `Rank the candidates by what the team should do first, considering staleness (old cases decay), flow position (a case one step from done is cheap to finish), and role batching (one role clearing several cases in a row is efficient). Give each ranked item a one-sentence business "why" (max 200 characters, plain language, no markdown).`,
    `Return AT MOST the top ${MAX_RANKED_ITEMS} items in "items" — the most urgent first; unranked candidates simply keep their default order, and the summary can speak to the rest.`,
    `Respond with ONLY a JSON object, no prose:`,
    `{"summary": "<one-paragraph state of the workflow>", "items": [{"caseId": "<exact case id>", "eventRef": "<exact eventRef>", "priority": 1, "why": "<one sentence>"}]}`,
  ].join("\n");
}

/** Parse + validate the LLM text against the closed candidate set. Invalid
 * items are silently dropped; null = the response is unusable as a whole. */
export function validateRecommendationText(
  text: string,
  candidates: NextAction[],
): { summary: string; items: RecommendationItem[] } | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let parsed: { summary?: unknown; items?: unknown };
  try {
    parsed = JSON.parse(m[0]) as { summary?: unknown; items?: unknown };
  } catch {
    return null;
  }
  if (!Array.isArray(parsed.items)) return null;
  const byKey = new Map(candidates.map((a) => [itemKey(a.caseId, a.eventRef), a]));
  const seen = new Set<string>();
  const items: RecommendationItem[] = [];
  for (const rawItem of parsed.items) {
    const it = rawItem as { caseId?: unknown; eventRef?: unknown; priority?: unknown; why?: unknown };
    if (typeof it.caseId !== "string" || typeof it.eventRef !== "string") continue;
    const key = itemKey(it.caseId, it.eventRef);
    const cand = byKey.get(key);
    // The closed-set gate: a hallucinated case or step never survives.
    if (!cand || seen.has(key)) continue;
    const why = typeof it.why === "string" ? it.why.trim().slice(0, MAX_WHY_CHARS) : "";
    if (!why) continue;
    seen.add(key);
    items.push({
      caseId: it.caseId,
      eventRef: it.eventRef,
      role: cand.role, // from the candidate, never from the LLM
      priority: typeof it.priority === "number" && Number.isFinite(it.priority) ? it.priority : items.length + 1,
      why,
    });
  }
  if (items.length === 0) return null;
  items.sort((a, b) => a.priority - b.priority);
  items.forEach((it, i) => (it.priority = i + 1)); // dense ranks
  return { summary: typeof parsed.summary === "string" ? parsed.summary.trim() : "", items };
}

// One in-flight generation per workflow: a double-clicked Refresh (or two
// members racing) shares the same LLM call instead of paying twice.
const inFlight = new Map<string, Promise<RecommendationsView>>();

/** Generate, validate, store, return. The ONLY code path that calls the LLM.
 * Provider failures surface as LlmError (the user pressed a button and
 * deserves feedback — never a raw provider response); pass a logger so the
 * original error stays in the server logs. */
export async function refreshRecommendations(log?: RefreshLogger): Promise<RecommendationsView> {
  const wf = currentWorkflowId();
  const pending = inFlight.get(wf);
  if (pending) return pending;
  const p = generate(log).finally(() => inFlight.delete(wf));
  inFlight.set(wf, p);
  return p;
}

// Known bounded race: a workflow deleted while the (seconds-long) LLM call is
// in flight re-creates its recs:<id> key after deleteWorkflow's cleanup —
// one orphaned few-KB _app_meta row. Accepted: an existence re-check here
// would wrongly reject the system workflow and any context without a
// PlatWorkflow row, which is worse than the leak.
async function generate(log?: RefreshLogger): Promise<RecommendationsView> {
  const ont = getOntology();
  // Freshness stamps are captured BEFORE the slow work (the model key here,
  // the watermark inside computeNextActions): any concurrent model swap or
  // emit then reads as stale, never as wrongly fresh.
  const modelKey = ontologyCacheKey();
  const result = await computeNextActions({ limit: null });

  // Nothing open → nothing to rank; store an empty fresh blob with no LLM cost.
  if (result.actions.length === 0) {
    const blob: StoredRecommendations = {
      version: 1,
      modelKey,
      watermark: result.watermark,
      generatedAt: new Date().toISOString(),
      llmModel: "",
      summary: "All caught up — no open next steps in any case.",
      items: [],
    };
    await setMeta(metaKey(), JSON.stringify(blob));
    return { status: "fresh", recs: blob, dropped: 0 };
  }

  const prompt = buildRecommendationPrompt(ont, result);
  let text: string;
  let llmModel: string;
  let provider: string | undefined;
  try {
    const resolved = await getAnthropicClient();
    const { client, model } = resolved;
    provider = resolved.provider;
    llmModel = model;
    const res = await client.messages.create({
      model,
      max_tokens: GENERATE_MAX_TOKENS,
      system:
        "You prioritize a team's open workflow steps. You rank ONLY the candidates listed in the message — never invent a step, case, or role. Output only a single JSON object.",
      messages: [{ role: "user", content: prompt }],
    });
    text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  } catch (err) {
    // Full provider detail (incl. request_id) stays server-side only.
    log?.error({ err }, "recommendations refresh failed");
    throw friendlyLlmError(err, provider) ?? err;
  }

  const validated = validateRecommendationText(text, result.actions);
  if (!validated) {
    // The provider answered but not with a usable ranking — the deterministic
    // list still stands in the UI; tell the user this pass didn't take.
    log?.error({ reply: text.slice(0, 2000) }, "recommendations reply failed validation");
    throw new LlmError("The assistant's ranking could not be parsed — try again.");
  }

  const blob: StoredRecommendations = {
    version: 1,
    modelKey,
    watermark: result.watermark,
    generatedAt: new Date().toISOString(),
    llmModel,
    summary: validated.summary,
    items: validated.items,
  };
  await setMeta(metaKey(), JSON.stringify(blob));
  return { status: "fresh", recs: blob, dropped: 0 };
}
