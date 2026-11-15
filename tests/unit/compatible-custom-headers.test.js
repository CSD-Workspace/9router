import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getCompatibleDefaultHeaders,
  isAnthropicCompatibleProvider,
  isOpenAICompatibleProvider,
  isCompatibleProvider,
} from "../../open-sse/providers/compatibleHeaders.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { GET, PUT } from "../../src/app/api/providers/[id]/overrides/route.js";
import { getSettings, updateSettings } from "../../src/lib/localDb";

describe("Compatible Providers Custom Headers (parity with AgentRouter)", () => {
  describe("getCompatibleDefaultHeaders helper", () => {
    it("identifies compatible providers correctly", () => {
      expect(isAnthropicCompatibleProvider("anthropic-compatible-node-1")).toBe(true);
      expect(isAnthropicCompatibleProvider("openai-compatible-chat-1")).toBe(false);
      expect(isAnthropicCompatibleProvider("agentrouter")).toBe(false);

      expect(isOpenAICompatibleProvider("openai-compatible-chat-1")).toBe(true);
      expect(isOpenAICompatibleProvider("openai-compatible-responses-1")).toBe(true);
      expect(isOpenAICompatibleProvider("anthropic-compatible-node-1")).toBe(false);

      expect(isCompatibleProvider("anthropic-compatible-node-1")).toBe(true);
      expect(isCompatibleProvider("openai-compatible-chat-1")).toBe(true);
      expect(isCompatibleProvider("claude")).toBe(false);
    });

    it("returns AgentRouter default headers for anthropic-compatible providers", () => {
      const headers = getCompatibleDefaultHeaders("anthropic-compatible-test-id");
      expect(headers["User-Agent"]).toContain("claude-cli");
      expect(headers["Anthropic-Dangerous-Direct-Browser-Access"]).toBe("true");
      expect(headers["X-App"]).toBe("cli");
    });

    it("returns AgentRouter opencode generic headers for openai-compatible providers", () => {
      const headers = getCompatibleDefaultHeaders("openai-compatible-chat-test-id");
      expect(headers["User-Agent"]).toBe("opencode/1.18.25");
      expect(headers["Anthropic-Dangerous-Direct-Browser-Access"]).toBeUndefined();
    });

    it("returns empty object for non-compatible providers", () => {
      expect(getCompatibleDefaultHeaders("openai")).toEqual({});
      expect(getCompatibleDefaultHeaders("gemini-cli")).toEqual({});
    });
  });

  describe("GET and PUT /api/providers/[id]/overrides", () => {
    const testAnthropicId = "anthropic-compatible-test-overrides";
    const testOpenAIId = "openai-compatible-test-overrides";

    afterEach(async () => {
      const settings = await getSettings();
      const overrides = { ...(settings.providerOverrides || {}) };
      delete overrides[testAnthropicId];
      delete overrides[testOpenAIId];
      await updateSettings({ providerOverrides: overrides });
    });

    it("returns AgentRouter builtinHeaders for anthropic-compatible provider", async () => {
      const res = await GET(new Request("http://localhost"), { params: Promise.resolve({ id: testAnthropicId }) });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.builtinHeaders["User-Agent"]).toContain("claude-cli");
      expect(data.builtinHeaders["Anthropic-Dangerous-Direct-Browser-Access"]).toBe("true");
      expect(data.builtinHeaders["X-App"]).toBe("cli");
      expect(data.headers).toEqual({});
    });

    it("returns opencode builtinHeaders for openai-compatible provider", async () => {
      const res = await GET(new Request("http://localhost"), { params: Promise.resolve({ id: testOpenAIId }) });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.builtinHeaders["User-Agent"]).toBe("opencode/1.18.25");
      expect(data.headers).toEqual({});
    });

    it("persists custom header overrides for compatible provider", async () => {
      const putRes = await PUT(
        new Request("http://localhost", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            headers: {
              "X-Custom-Token": "secret-123",
              "User-Agent": "custom-claude/3.0",
            },
          }),
        }),
        { params: Promise.resolve({ id: testAnthropicId }) }
      );
      expect(putRes.status).toBe(200);

      const getRes = await GET(new Request("http://localhost"), { params: Promise.resolve({ id: testAnthropicId }) });
      const data = await getRes.json();
      expect(data.headers["X-Custom-Token"]).toBe("secret-123");
      expect(data.headers["User-Agent"]).toBe("custom-claude/3.0");
      expect(data.builtinHeaders["Anthropic-Dangerous-Direct-Browser-Access"]).toBe("true");
    });
  });

  describe("BaseExecutor.execute header application on compatible providers", () => {
    it("applies AgentRouter default headers during execution of anthropic-compatible provider", async () => {
      let capturedHeaders = null;
      const directFetch = vi.fn(async (url, init) => {
        capturedHeaders = init.headers;
        return new Response(JSON.stringify({ id: "msg_123", content: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const executor = new DefaultExecutor("anthropic-compatible-node-run");
      await executor.execute({
        model: "claude-3-opus",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: false,
        credentials: {
          apiKey: "sk-ant-test",
          providerSpecificData: { baseUrl: "https://my-gateway.com/v1" },
        },
        directFetch,
      });

      expect(capturedHeaders["User-Agent"]).toContain("claude-cli");
      expect(capturedHeaders["Anthropic-Dangerous-Direct-Browser-Access"]).toBe("true");
      expect(capturedHeaders["X-App"]).toBe("cli");
      expect(capturedHeaders["x-api-key"]).toBe("sk-ant-test");
    });

    it("applies AgentRouter opencode headers during execution of openai-compatible provider", async () => {
      let capturedHeaders = null;
      const directFetch = vi.fn(async (url, init) => {
        capturedHeaders = init.headers;
        return new Response(JSON.stringify({ id: "chatcmpl_123", choices: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const executor = new DefaultExecutor("openai-compatible-chat-node-run");
      await executor.execute({
        model: "gpt-4o",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: false,
        credentials: {
          apiKey: "sk-openai-test",
          providerSpecificData: { baseUrl: "https://my-openai-gateway.com/v1" },
        },
        directFetch,
      });

      expect(capturedHeaders["User-Agent"]).toBe("opencode/1.18.25");
      expect(capturedHeaders["Authorization"]).toBe("Bearer sk-openai-test");
    });

    it("allows user overrides to layer on top of default AgentRouter headers", async () => {
      let capturedHeaders = null;
      const directFetch = vi.fn(async (url, init) => {
        capturedHeaders = init.headers;
        return new Response(JSON.stringify({ id: "msg_123", content: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const executor = new DefaultExecutor("anthropic-compatible-node-run");
      await executor.execute({
        model: "claude-3-opus",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: false,
        credentials: {
          apiKey: "sk-ant-test",
          providerSpecificData: { baseUrl: "https://my-gateway.com/v1" },
        },
        providerOverrides: {
          headers: {
            "User-Agent": "my-custom-cli/1.0",
            "X-Gateway-Route": "vip-tier",
          },
        },
        directFetch,
      });

      // Overridden User-Agent
      expect(capturedHeaders["User-Agent"]).toBe("my-custom-cli/1.0");
      // Newly added custom header
      expect(capturedHeaders["X-Gateway-Route"]).toBe("vip-tier");
      // Default headers preserved unless overridden
      expect(capturedHeaders["Anthropic-Dangerous-Direct-Browser-Access"]).toBe("true");
      expect(capturedHeaders["X-App"]).toBe("cli");
    });
  });
});
