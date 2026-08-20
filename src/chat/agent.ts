// Manual agentic loop. Used in preference to the SDK tool runner so we can:
//   - log every tool call to the server log for demo transparency
//   - cap iterations to avoid runaway loops
//   - enforce the write-tool confirmation invariant via the tool handlers

import Anthropic from "@anthropic-ai/sdk";
import { systemBlocks } from "./system-prompt.js";
import { TOOLS, runTool } from "./tools.js";
import { getAnthropicClient } from "../llm/anthropic.js";
import { withActorKind } from "../platform/tenancy/actor.js";

const EFFORT = (process.env.CHAT_EFFORT ?? "medium") as "low" | "medium" | "high";
// Headroom for the connector build→test→repair→ingest loop (each is a tool turn).
const MAX_ITERATIONS = 14;
// Cap on a single tool call. A wedged tool (slow source API, stuck driver) must
// not hold the whole turn: past the cap the MODEL gets a timeout error result it
// can react to, keeping the conversation alive. The underlying promise cannot be
// cancelled — its eventual result is discarded.
const TOOL_TIMEOUT_MS = Number(process.env.CHAT_TOOL_TIMEOUT_MS ?? 300_000);

interface ChatTurnResult {
  messages: Anthropic.MessageParam[];
  toolCalls: Array<{ name: string; input: unknown; isError: boolean; preview: string }>;
  /** One-click replies the assistant proposed for its closing question (the
   * `[suggest: …]` marker, stripped from the message text). Rides on the RESULT
   * only — never on a message object, because the stateless client round-trips
   * the full message array back to the API and persists it verbatim. */
  suggestedReplies?: string[];
  usage: {
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    inputTokens: number;
    outputTokens: number;
    iterations: number;
  };
}

// The assistant ends a question-turn with a final `[suggest: a | b | c]` line
// (see system-prompt "Suggested replies"). It is a UI hint, not content: strip
// it from the message text and lift the replies onto the turn result.
const SUGGEST_RE = /\n?\s*\[suggest:\s*([^\]]+)\]\s*$/i;

/** Strip an end-anchored marker off ONE message's final text block. Returns the
 * same message reference when there is nothing to strip — including when
 * stripping would leave the message with no non-empty visible content: an empty
 * text block is API-invalid on the round-trip (the stateless client resends and
 * persists messages verbatim), so a marker-only message keeps its raw marker —
 * cosmetic beats a wedged thread. */
function stripSuggestMarker(msg: Anthropic.MessageParam): { message: Anthropic.MessageParam; replies?: string[] } {
  if (msg.role !== "assistant" || !Array.isArray(msg.content)) return { message: msg };
  const blocks = msg.content;
  const lastText = [...blocks].reverse().find((b) => b.type === "text");
  if (!lastText || typeof (lastText as Anthropic.TextBlock).text !== "string") return { message: msg };
  const m = (lastText as Anthropic.TextBlock).text.match(SUGGEST_RE);
  if (!m) return { message: msg };
  const stripped = (lastText as Anthropic.TextBlock).text.replace(SUGGEST_RE, "").trimEnd();
  const others = blocks.filter((b) => b !== lastText && b.type !== "thinking" && b.type !== "redacted_thinking");
  if (stripped === "" && others.length === 0) return { message: msg };
  const replies = m[1]!
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 4)
    .map((s) => (s.length > 80 ? s.slice(0, 80) : s));
  const content = blocks
    .map((b) => (b === lastText ? { ...b, text: stripped } : b))
    .filter((b) => !(b.type === "text" && (b as Anthropic.TextBlock).text === ""));
  return { message: { ...msg, content }, replies: replies.length ? replies : undefined };
}

/** Pure (exported for tests): sweep the marker off EVERY assistant message —
 * a marker can land mid-turn when the model emits it alongside tool_use blocks,
 * and an unswept one renders raw in the transcript — but lift replies only from
 * the turn's LAST message. Mutates nothing; returns the same array when nothing
 * changed. */
export function extractSuggestedReplies(messages: Anthropic.MessageParam[]): {
  messages: Anthropic.MessageParam[];
  suggestedReplies?: string[];
} {
  let suggestedReplies: string[] | undefined;
  let changed = false;
  const out = messages.map((msg, i) => {
    const { message, replies } = stripSuggestMarker(msg);
    if (message !== msg) changed = true;
    if (i === messages.length - 1) suggestedReplies = replies;
    return message;
  });
  return { messages: changed ? out : messages, ...(suggestedReplies ? { suggestedReplies } : {}) };
}

// Streamed to the client as SSE "progress" events — one per model call and per
// tool call — so the UI can show live activity instead of an opaque spinner.
export type ChatProgress =
  | { kind: "model_call"; iteration: number; maxIterations: number }
  | { kind: "tool_start"; name: string; iteration: number }
  | { kind: "tool_end"; name: string; isError: boolean; iteration: number };

export interface RunAgentTurnOpts {
  onProgress?: (p: ChatProgress) => void;
  // Aborts the in-flight provider request and stops the loop between tool calls.
  // Wired to the HTTP request's close event, so a Stop button (or dead
  // connection) halts server-side work instead of letting the turn run on.
  signal?: AbortSignal;
}

async function runToolCapped(
  name: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<{ content: string; isError: boolean }> {
  let timer: NodeJS.Timeout | undefined;
  // The capped tool is NOT cancelled — it may still complete (and commit writes)
  // after the race is decided. The timeout result therefore must steer the model
  // to verify state before any retry: an eager retry racing the orphan is how
  // you get a double ingest or a stale build clobbering a corrected one.
  const timeout = new Promise<{ content: string; isError: boolean }>((resolve) => {
    timer = setTimeout(() => resolve({
      content: `ERROR: tool "${name}" did not finish within ${Math.round(TOOL_TIMEOUT_MS / 1000)}s and its result was discarded — but the operation MAY STILL COMPLETE in the background. Do NOT retry it yet: first verify current state (e.g. get_connector_history, list_table_rows) to avoid duplicating a write, then tell the user what happened and ask how to proceed.`,
      isError: true,
    }), TOOL_TIMEOUT_MS);
  });
  // A Stop must unblock the loop NOW, not after the tool (or its cap) resolves;
  // the tool itself still runs to completion orphaned — nothing reads its result.
  let onAbort: (() => void) | undefined;
  const aborted = signal
    ? new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason ?? new Error("aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
      })
    : null;
  try {
    // Every state change a chat tool makes is AI-originated: tag the EventLog
    // (autonomy mix) and any PDP audit (guardrail-block-rate) accordingly.
    const race = [withActorKind("ai", () => runTool(name, input)), timeout];
    if (aborted) race.push(aborted as never);
    return await Promise.race(race);
  } finally {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export async function runAgentTurn(
  messages: Anthropic.MessageParam[],
  opts: RunAgentTurnOpts = {},
): Promise<ChatTurnResult> {
  const updated = [...messages];
  const toolCalls: ChatTurnResult["toolCalls"] = [];
  const usage = { cacheCreationInputTokens: 0, cacheReadInputTokens: 0, inputTokens: 0, outputTokens: 0, iterations: 0 };

  // Resolve once per turn — the org's own key (or the platform default) — and
  // reuse the same client + model across every iteration of the agentic loop.
  const { client, model } = await getAnthropicClient();
  // The ACTIVE workflow's model, resolved inside this request's tenant context —
  // the module-load-time blocks would be the empty system model for everyone.
  const system = systemBlocks();

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    opts.signal?.throwIfAborted();
    usage.iterations++;
    opts.onProgress?.({ kind: "model_call", iteration: iter + 1, maxIterations: MAX_ITERATIONS });
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      thinking: { type: "adaptive" },
      output_config: { effort: EFFORT },
      system,
      tools: TOOLS,
      messages: updated,
    }, { signal: opts.signal });

    usage.cacheCreationInputTokens += response.usage.cache_creation_input_tokens ?? 0;
    usage.cacheReadInputTokens += response.usage.cache_read_input_tokens ?? 0;
    usage.inputTokens += response.usage.input_tokens ?? 0;
    usage.outputTokens += response.usage.output_tokens ?? 0;

    updated.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") break;
    if (response.stop_reason !== "tool_use") break;

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    if (toolUseBlocks.length === 0) break;

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUseBlocks) {
      opts.signal?.throwIfAborted();
      opts.onProgress?.({ kind: "tool_start", name: tu.name, iteration: iter + 1 });
      const result = await runToolCapped(tu.name, tu.input, opts.signal);
      opts.onProgress?.({ kind: "tool_end", name: tu.name, isError: result.isError, iteration: iter + 1 });
      const preview = result.content.length > 200 ? result.content.slice(0, 200) + "…" : result.content;
      toolCalls.push({ name: tu.name, input: tu.input, isError: result.isError, preview });
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: result.content,
        is_error: result.isError,
      });
    }
    updated.push({ role: "user", content: toolResults });
  }

  const { messages: finalMessages, suggestedReplies } = extractSuggestedReplies(updated);
  return { messages: finalMessages, toolCalls, ...(suggestedReplies ? { suggestedReplies } : {}), usage };
}
