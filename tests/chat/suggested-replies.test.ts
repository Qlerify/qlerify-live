// The assistant ends a question-turn with a `[suggest: a | b | c]` marker line.
// It is a UI hint, not content: extractSuggestedReplies must strip it from the
// message text (the client round-trips and PERSISTS messages verbatim, so the
// marker must never survive there) and lift the replies onto the turn result.

import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { extractSuggestedReplies } from "../../src/chat/agent.js";

const assistant = (...texts: string[]): Anthropic.MessageParam => ({
  role: "assistant",
  content: texts.map((text) => ({ type: "text" as const, text })),
});

const textOf = (m: Anthropic.MessageParam, i = 0) => (m.content as Anthropic.TextBlockParam[])[i]!.text;

describe("extractSuggestedReplies", () => {
  it("pops the marker off the final text block and returns the replies in order", () => {
    const msgs = [assistant("Shall I build the DynamoDB connector?\n[suggest: Yes, proceed | No, hold on | Change the source]")];
    const r = extractSuggestedReplies(msgs);
    expect(r.suggestedReplies).toEqual(["Yes, proceed", "No, hold on", "Change the source"]);
    expect(textOf(r.messages[r.messages.length - 1]!)).toBe("Shall I build the DynamoDB connector?");
  });

  it("no marker → the same array back, no replies", () => {
    const msgs = [assistant("Done — 20 rows ingested.")];
    const r = extractSuggestedReplies(msgs);
    expect(r.suggestedReplies).toBeUndefined();
    expect(r.messages).toBe(msgs);
  });

  it("a marker NOT at the end of the text is content, not a hint — left untouched", () => {
    const msgs = [assistant("The syntax is [suggest: a | b] followed by more prose.")];
    const r = extractSuggestedReplies(msgs);
    expect(r.suggestedReplies).toBeUndefined();
    expect(r.messages).toBe(msgs);
  });

  it("ignores a turn that did not end on an assistant message", () => {
    const msgs: Anthropic.MessageParam[] = [{ role: "user", content: "hello [suggest: a | b]" }];
    const r = extractSuggestedReplies(msgs);
    expect(r.suggestedReplies).toBeUndefined();
    expect(r.messages).toBe(msgs);
  });

  it("caps at 4 replies and drops empty entries", () => {
    const msgs = [assistant("Which cadence?\n[suggest: Hourly | | Nightly | Weekly | Monthly | Manual only]")];
    const r = extractSuggestedReplies(msgs);
    expect(r.suggestedReplies).toEqual(["Hourly", "Nightly", "Weekly", "Monthly"]);
  });

  it("a marker-only text block is dropped when other blocks remain", () => {
    const msgs = [assistant("Which source system is it?", "[suggest: DynamoDB | Postgres]")];
    const r = extractSuggestedReplies(msgs);
    expect(r.suggestedReplies).toEqual(["DynamoDB", "Postgres"]);
    const last = r.messages[r.messages.length - 1]!;
    expect((last.content as unknown[]).length).toBe(1);
    expect(textOf(last)).toBe("Which source system is it?");
  });

  it("does not mutate the input messages", () => {
    const msgs = [assistant("Proceed?\n[suggest: Yes | No]")];
    const before = textOf(msgs[0]!);
    extractSuggestedReplies(msgs);
    expect(textOf(msgs[0]!)).toBe(before);
  });

  // Stripping must never leave an empty text block: the stateless client
  // round-trips and persists messages verbatim, and the Messages API rejects
  // empty text blocks — one marker-only reply would wedge the thread forever.
  it("a marker-only sole text block is left untouched (raw marker beats a bricked thread)", () => {
    const msgs = [assistant("[suggest: Yes, proceed | No]")];
    const r = extractSuggestedReplies(msgs);
    expect(r.suggestedReplies).toBeUndefined();
    expect(r.messages).toBe(msgs);
    expect(textOf(msgs[0]!)).toBe("[suggest: Yes, proceed | No]");
  });

  it("a marker-only text block after only thinking blocks is also left untouched", () => {
    const msgs: Anthropic.MessageParam[] = [{
      role: "assistant",
      content: [
        { type: "thinking", thinking: "…", signature: "s" } as never,
        { type: "text", text: "[suggest: Yes | No]" },
      ],
    }];
    const r = extractSuggestedReplies(msgs);
    expect(r.suggestedReplies).toBeUndefined();
    expect(r.messages).toBe(msgs);
  });

  // A marker can land mid-turn (the model emits it alongside tool_use blocks and
  // the loop continues) — it must still be swept out of the transcript, but
  // replies are lifted only from the turn's LAST message.
  it("sweeps a marker off a mid-turn assistant message without lifting its replies", () => {
    const msgs: Anthropic.MessageParam[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Which cadence?\n[suggest: Hourly | Nightly]" },
          { type: "tool_use", id: "t1", name: "list_adapters", input: {} },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "[]" }] },
      assistant("Done — no connector exists yet."),
    ];
    const r = extractSuggestedReplies(msgs);
    expect(r.suggestedReplies).toBeUndefined();
    expect(textOf(r.messages[0]!)).toBe("Which cadence?");
    expect(textOf(r.messages[2]!)).toBe("Done — no connector exists yet.");
  });
});
