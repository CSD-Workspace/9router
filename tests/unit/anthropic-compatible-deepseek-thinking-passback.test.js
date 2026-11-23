/**
 * DeepSeek thinking-mode models served behind Claude-transport providers
 * (official `deepseek`, opencode-go, and `anthropic-compatible-*` nodes)
 * reject any turn where `thinking` is enabled but the assistant history
 * carries no `content[].thinking` block:
 *   400 "The `content[].thinking` in the thinking mode must be passed back to the API."
 *
 * This pins the two gateway paths that keep that block present:
 *  1. OpenAI client history: assistant `reasoning_content` must be mapped to
 *     an unsigned Claude `thinking` block (openai→claude).
 *  2. Claude client history: an existing `thinking` block is preserved
 *     verbatim even when the turn has no `tool_use` (claude→claude, via
 *     prepareClaudeRequest's deepSeekServed keep-always branch).
 *
 * Related: opencode-go-deepseek-thinking-injection.test.js (placeholder
 * injection when a block is missing entirely).
 */
import { describe, it, expect } from "vitest";
import { translateRequest } from "../../open-sse/translator/index.js";
import { prepareClaudeRequest } from "../../open-sse/translator/formats/claude.js";

const DEEPSEEK_NODE = "anthropic-compatible-10a8072f-45f1-447f-afea-99542b7f3cc7";

function assistantThinkingBlocks(out) {
  const msg = out.messages.find((m) => m.role === "assistant");
  return (msg.content || []).filter((b) => b.type === "thinking");
}

describe("DeepSeek thinking pass-back on Claude-transport providers", () => {
  it("maps OpenAI reasoning_content to an unsigned thinking block", () => {
    const body = {
      model: "deepseek-ai/DeepSeek-V4-Flash-0731",
      max_tokens: 8192,
      tools: [
        { type: "function", function: { name: "Read", description: "Read a file", parameters: { type: "object", properties: {} } } },
      ],
      messages: [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: null,
          reasoning_content: "let me look",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "Read", arguments: '{"path":"/tmp/x"}' } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "file body" },
        { role: "user", content: "summarize" },
      ],
    };

    const out = translateRequest(
      "openai", "claude", "deepseek-ai/DeepSeek-V4-Flash-0731",
      body, true, { apiKey: "k" }, DEEPSEEK_NODE,
    );

    const assistant = out.messages.find((m) => m.role === "assistant");
    const blocks = assistantThinkingBlocks(out);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].thinking).toBe("let me look");
    expect(blocks[0].signature).toBeUndefined();
    // thinking must lead the assistant's content
    expect(assistant.content[0].type).toBe("thinking");
  });

  it("drops an empty reasoning_content instead of a fake block", () => {
    const body = {
      model: "deepseek-ai/DeepSeek-V4-Flash-0731",
      max_tokens: 2048,
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there", reasoning_content: "   " },
        { role: "user", content: "more?" },
      ],
    };

    const out = translateRequest(
      "openai", "claude", "deepseek-ai/DeepSeek-V4-Flash-0731",
      body, false, { apiKey: "k" }, DEEPSEEK_NODE,
    );

    expect(assistantThinkingBlocks(out)).toHaveLength(0);
  });

  it("keeps an existing Claude thinking block verbatim without tool_use", () => {
    const body = {
      model: "deepseek-v4-flash",
      max_tokens: 8192,
      thinking: { type: "enabled", budget_tokens: 10000 },
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "let me look", signature: "abc123" },
            { type: "text", text: "here is my answer" },
          ],
        },
        { role: "user", content: [{ type: "text", text: "and more?" }] },
      ],
    };

    const out = prepareClaudeRequest(body, DEEPSEEK_NODE);
    const blocks = assistantThinkingBlocks(out);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ type: "thinking", thinking: "let me look", signature: "abc123" });
  });

  it("keeps even a malformed signature verbatim on DeepSeek (no validation)", () => {
    const body = {
      model: "deepseek-v4-flash",
      max_tokens: 8192,
      thinking: { type: "enabled", budget_tokens: 10000 },
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "x", signature: "garbage-not-a-signature" },
            { type: "text", text: "answer" },
          ],
        },
        { role: "user", content: [{ type: "text", text: "more?" }] },
      ],
    };

    const out = prepareClaudeRequest(body, DEEPSEEK_NODE);
    const blocks = assistantThinkingBlocks(out);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].signature).toBe("garbage-not-a-signature");
  });
});
