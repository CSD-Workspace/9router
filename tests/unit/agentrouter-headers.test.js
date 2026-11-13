import { describe, it, expect } from "vitest";
import {
  normalizeProfile,
  isValidProfile,
  getGenericHeadersForProfile,
  getAnthropicHeadersForProfile,
  filterHopByHopHeaders,
  getAgentRouterHeaders,
  SUPPORTED_PROFILES,
} from "../../open-sse/providers/agentrouterPolicy.js";

describe("AgentRouter Policy & Header Spoofing", () => {
  it("normalizes known profiles and aliases", () => {
    expect(normalizeProfile("opencode")).toBe("opencode");
    expect(normalizeProfile("claude")).toBe("claude-code");
    expect(normalizeProfile("qwen-code")).toBe("qwen");
    expect(normalizeProfile("roocode")).toBe("roo");
    expect(normalizeProfile("roo-code")).toBe("roo");
    expect(normalizeProfile("kilocode")).toBe("kilo");
    expect(normalizeProfile("kilo-code")).toBe("kilo");
    expect(normalizeProfile("factory")).toBe("droid");
    expect(normalizeProfile("factory-droid")).toBe("droid");
    expect(normalizeProfile("github-copilot")).toBe("copilot");
    expect(normalizeProfile("none")).toBe("generic");
    expect(normalizeProfile("")).toBe("opencode");
    expect(normalizeProfile(null)).toBe("opencode");
  });

  it("validates all 16 supported profiles", () => {
    expect(SUPPORTED_PROFILES).toHaveLength(16);
    for (const p of SUPPORTED_PROFILES) {
      expect(isValidProfile(p)).toBe(true);
    }
    expect(isValidProfile("unknown-fake-profile")).toBe(false);
  });

  it("generates correct generic headers for various CLI profiles", () => {
    const opencode = getGenericHeadersForProfile("opencode");
    expect(opencode["User-Agent"]).toContain("opencode/1.18.25");

    const codex = getGenericHeadersForProfile("codex");
    expect(codex["User-Agent"]).toContain("codex-cli");
    expect(codex["X-App"]).toBe("codex");

    const cursor = getGenericHeadersForProfile("cursor");
    expect(cursor["User-Agent"]).toContain("Cursor");
    expect(cursor["X-App"]).toBe("cursor");

    const roo = getGenericHeadersForProfile("roo");
    expect(roo["User-Agent"]).toContain("Roo-Code");
    expect(roo["X-App"]).toBe("roo-code");

    const cline = getGenericHeadersForProfile("cline");
    expect(cline["User-Agent"]).toContain("Cline");
    expect(cline["X-App"]).toBe("cline");

    const cc = getGenericHeadersForProfile("claude-code");
    expect(cc["User-Agent"]).toContain("claude-cli");
    expect(cc["X-Stainless-Runtime"]).toBe("node");
    expect(cc["X-Stainless-Package-Version"]).toBe("0.80.0");
  });

  it("generates correct Anthropic headers with beta flags", () => {
    const anthropicCC = getAnthropicHeadersForProfile("claude-code", "claude-opus-4-6");
    expect(anthropicCC["Anthropic-Version"]).toBe("2023-06-01");
    expect(anthropicCC["Anthropic-Dangerous-Direct-Browser-Access"]).toBe("true");
    expect(anthropicCC["Anthropic-Beta"]).toContain("claude-code-20250219");
    expect(anthropicCC["Anthropic-Beta"]).toContain("interleaved-thinking-2025-05-14");

    const anthropicOC = getAnthropicHeadersForProfile("opencode");
    expect(anthropicOC["Anthropic-Version"]).toBe("2023-06-01");
    expect(anthropicOC["Anthropic-Beta"]).toContain("interleaved-thinking-2025-05-14");
    expect(anthropicOC["User-Agent"]).toContain("opencode");
  });

  it("filters hop-by-hop headers", () => {
    const raw = {
      "Content-Type": "application/json",
      "Connection": "keep-alive",
      "Keep-Alive": "timeout=5",
      "Transfer-Encoding": "chunked",
      "Upgrade": "websocket",
      "X-App": "cli",
    };
    const filtered = filterHopByHopHeaders(raw);
    expect(filtered["Content-Type"]).toBe("application/json");
    expect(filtered["X-App"]).toBe("cli");
    expect(filtered["Connection"]).toBeUndefined();
    expect(filtered["Keep-Alive"]).toBeUndefined();
    expect(filtered["Transfer-Encoding"]).toBeUndefined();
    expect(filtered["Upgrade"]).toBeUndefined();
  });

  it("builds complete headers based on endpoint and model", () => {
    // Claude endpoint
    const claudeHeaders = getAgentRouterHeaders({
      profile: "claude-code",
      model: "claude-opus-4-6",
      isClaudeEndpoint: true,
      apiKey: "sk-test-key-123",
      stream: true,
    });
    expect(claudeHeaders["x-api-key"]).toBe("sk-test-key-123");
    expect(claudeHeaders["Anthropic-Version"]).toBe("2023-06-01");
    expect(claudeHeaders["Accept"]).toBe("text/event-stream");
    expect(claudeHeaders["User-Agent"]).toContain("claude-cli");
    expect(claudeHeaders["Authorization"]).toBeUndefined();

    // OpenAI endpoint
    const openAIHeaders = getAgentRouterHeaders({
      profile: "opencode",
      model: "deepseek-v3.2",
      isClaudeEndpoint: false,
      apiKey: "sk-test-key-456",
      stream: false,
    });
    expect(openAIHeaders["Authorization"]).toBe("Bearer sk-test-key-456");
    expect(openAIHeaders["User-Agent"]).toContain("opencode");
    expect(openAIHeaders["x-api-key"]).toBeUndefined();
    expect(openAIHeaders["Anthropic-Version"]).toBeUndefined();
    expect(openAIHeaders["Accept"]).toBeUndefined();
  });
});
