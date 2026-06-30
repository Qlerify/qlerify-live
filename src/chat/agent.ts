// Manual agentic loop. Used in preference to the SDK tool runner so we can:
//   - log every tool call to the server log for demo transparency
//   - cap iterations to avoid runaway loops
//   - enforce the write-tool confirmation invariant via the tool handlers

import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_BLOCKS } from "./system-prompt.js";
import { TOOLS, runTool } from "./tools.js";
import { getAnthropicClient } from "../llm/anthropic.js";
import { withActorKind } from "../platform/tenancy/actor.js";

const EFFORT = (process.env.CHAT_EFFORT ?? "medium") as "low" | "medium" | "high";
// Headroom for the connector build→test→repair→ingest loop (each is a tool turn).
const MAX_ITERATIONS = 14;

export interface ChatTurnResult {
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

export async function runAgentTurn(messages: Anthropic.MessageParam[]): Promise<ChatTurnResult> {
  const updated = [...messages];
  const toolCalls: ChatTurnResult["toolCalls"] = [];
  const usage = { cacheCreationInputTokens: 0, cacheReadInputTokens: 0, inputTokens: 0, outputTokens: 0, iterations: 0 };

  // Resolve once per turn — the org's own key (or the platform default) — and
  // reuse the same client + model across every iteration of the agentic loop.
  const { client, model } = await getAnthropicClient();

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    usage.iterations++;
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      thinking: { type: "adaptive" },
      output_config: { effort: EFFORT },
      system: SYSTEM_BLOCKS,
      tools: TOOLS,
      messages: updated,
    });

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
      // Every state change a chat tool makes is AI-originated: tag the EventLog
      // (autonomy mix) and any PDP audit (guardrail-block-rate) accordingly.
      const result = await withActorKind("ai", () => runTool(tu.name, tu.input));
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
