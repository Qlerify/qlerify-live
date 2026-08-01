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
  usage: {
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    inputTokens: number;
    outputTokens: number;
    iterations: number;
  };
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

  return { messages: updated, toolCalls, usage };
}
