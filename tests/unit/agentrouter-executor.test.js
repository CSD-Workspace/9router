import { describe, it, expect, vi } from "vitest";
import {
  AgentRouterExecutor,
  isAgentRouterRateLimitError,
  peekStreamForRateLimit,
} from "../../open-sse/executors/agentrouter.js";
import { getExecutor } from "../../open-sse/executors/index.js";

describe("AgentRouterExecutor (Model-Aware Routing & Request Handling)", () => {
  const executor = new AgentRouterExecutor();

  it("registers in executors index under agentrouter and ar", () => {
    expect(getExecutor("agentrouter")).toBeInstanceOf(AgentRouterExecutor);
    expect(getExecutor("ar")).toBeInstanceOf(AgentRouterExecutor);
  });

  it("routes Claude models to /v1/messages?beta=true", () => {
    const url = executor.buildUrl("claude-opus-4-6", true);
    expect(url).toBe("https://agentrouter.org/v1/messages?beta=true");

    const urlHaiku = executor.buildUrl("claude-haiku-4-5-20251001", true);
    expect(urlHaiku).toBe("https://agentrouter.org/v1/messages?beta=true");
  });

  it("routes OpenAI / DeepSeek / GLM models to /v1/chat/completions", () => {
    const urlDeepSeek = executor.buildUrl("deepseek-v3.2", true);
    expect(urlDeepSeek).toBe("https://agentrouter.org/v1/chat/completions");

    const urlGLM = executor.buildUrl("glm-5.1", true);
    expect(urlGLM).toBe("https://agentrouter.org/v1/chat/completions");

    const urlGPT = executor.buildUrl("gpt-4o", true);
    expect(urlGPT).toBe("https://agentrouter.org/v1/chat/completions");
  });

  it("routes Responses models (gpt-6.1-sol, gpt-5, codex) to /v1/responses", () => {
    const urlGPT6 = executor.buildUrl("gpt-6.1-sol", true);
    expect(urlGPT6).toBe("https://agentrouter.org/v1/responses");

    const urlGPT5 = executor.buildUrl("gpt-5.6-luna", true);
    expect(urlGPT5).toBe("https://agentrouter.org/v1/responses");

    const urlCodex = executor.buildUrl("gpt-5.3-codex", true);
    expect(urlCodex).toBe("https://agentrouter.org/v1/responses");
  });

  it("supports custom baseUrl overrides from connection credentials", () => {
    const customCreds = {
      apiKey: "sk-test",
      providerSpecificData: { baseUrl: "https://my-gateway.internal" },
    };
    const claudeUrl = executor.buildUrl("claude-opus-4-6", true, 0, customCreds);
    expect(claudeUrl).toBe("https://my-gateway.internal/v1/messages?beta=true");

    const openAiUrl = executor.buildUrl("deepseek-v3.2", true, 0, customCreds);
    expect(openAiUrl).toBe("https://my-gateway.internal/v1/chat/completions");
  });

  it("transforms GLM models thinking parameters to enabled", () => {
    const bodyAdaptive = {
      model: "glm-5.1",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "adaptive" },
    };
    const transformed = executor.transformRequest("glm-5.1", bodyAdaptive);
    expect(transformed.thinking.type).toBe("enabled");

    const bodyReasoning = {
      model: "glm-5.1",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "high",
    };
    const transformed2 = executor.transformRequest("glm-5.1", bodyReasoning);
    expect(transformed2.thinking.type).toBe("enabled");
  });

  it("normalizes tool calling schemas for upstream Rust serde compatibility", () => {
    const bodyWithTools = {
      messages: [{ role: "user", content: "read file" }],
      tools: [
        {
          name: "readFile",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
    };
    const transformed = executor.transformRequest("deepseek-v3.2", bodyWithTools);
    expect(transformed.tools[0].type).toBe("function");
    expect(transformed.tools[0].function.name).toBe("readFile");
  });

  it("strips store parameter on chat completions", () => {
    const body = {
      messages: [{ role: "user", content: "hi" }],
      store: false,
    };
    const transformed = executor.transformRequest("deepseek-v3.2", body);
    expect(transformed.store).toBeUndefined();
  });

  it("classifies error responses accurately", () => {
    // 400 content-blocked
    const errContentBlocked = executor.parseError(
      { status: 400 },
      JSON.stringify({ error: { code: "content-blocked", message: "content-blocked" } })
    );
    expect(errContentBlocked.code).toBe("content_blocked");
    expect(executor.shouldRetry(400, 0)).toBe(false);

    // 503 no available channel
    const errNoChannel = executor.parseError(
      { status: 503 },
      JSON.stringify({ error: { message: "no available channel for this model" } })
    );
    expect(errNoChannel.code).toBe("no_channel");

    // 402 quota exhausted
    const errQuota = executor.parseError({ status: 402 }, "quota exhausted");
    expect(errQuota.code).toBe("quota_exhausted");
    expect(executor.shouldRetry(402, 0)).toBe(false);

    // 403 WAF HTML challenge
    const errWaf = executor.parseError(
      { status: 403 },
      "<html><head><script src='https://alicdn.com/waf.js'></script></head><body>renderData</body></html>"
    );
    expect(errWaf.code).toBe("waf_challenge");
    expect(executor.shouldRetry(403, 0)).toBe(false);
  });

  describe("AgentRouter Overload Rate Limit Detection & 5s Retry", () => {
    it("identifies rate limit error strings correctly", () => {
      expect(
        isAgentRouterRateLimitError(
          "Your requests to gpt-5.6-sol for gpt-5.6-sol in eastus2 have exceeded token rate limit."
        )
      ).toBe(true);

      expect(isAgentRouterRateLimitError("Rate limit reached for requests per minute (RPM)")).toBe(true);
      expect(isAgentRouterRateLimitError("Server is temporarily overloaded, please retry")).toBe(true);
      expect(isAgentRouterRateLimitError({ message: "exceeded token rate limit" })).toBe(true);
      expect(isAgentRouterRateLimitError(null)).toBe(false);
      expect(isAgentRouterRateLimitError("")).toBe(false);
    });

    it("detects rate limit inside streaming response.failed event", async () => {
      const encoder = new TextEncoder();
      const sseText =
        'event: response.failed\n' +
        'data: {"type":"response.failed","response":{"error":{"message":"Your requests to gpt-5.6-sol for gpt-5.6-sol in eastus2 have exceeded token rate limit."}}}\n\n';

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(sseText));
          controller.close();
        },
      });

      const peeked = await peekStreamForRateLimit(stream);
      expect(peeked.isRateLimit).toBe(true);
      expect(peeked.errMsg).toContain("exceeded token rate limit");
    });

    it("does not falsely identify normal streaming text as rate limit", async () => {
      const encoder = new TextEncoder();
      const sseText =
        'event: response.output_text.delta\n' +
        'data: {"type":"response.output_text.delta","delta":"Hello, how can I help you today?"}\n\n';

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(sseText));
          controller.close();
        },
      });

      const peeked = await peekStreamForRateLimit(stream);
      expect(peeked.isRateLimit).toBe(false);
    });

    it("retries after rate limit and succeeds on second attempt without cancelling task", async () => {
      const encoder = new TextEncoder();
      let callCount = 0;

      // Fast retry delay for test
      const customExecutor = new AgentRouterExecutor("agentrouter", {
        rateLimitDelayMs: 15,
        maxRateLimitRetries: 3,
      });

      // Mock dispatch
      customExecutor.dispatch = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // Attempt 1: Rate limit error in stream
          const errorStream = new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"message":"Your requests to gpt-5.6-sol for gpt-5.6-sol in eastus2 have exceeded token rate limit."}}}\n\n'
                )
              );
              controller.close();
            },
          });
          return {
            response: new Response(errorStream, {
              status: 200,
              headers: { "Content-Type": "text/event-stream" },
            }),
            url: "https://agentrouter.org/v1/responses",
          };
        }

        // Attempt 2: Successful content
        const successStream = new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Here is the solution."}\n\n'
              )
            );
            controller.close();
          },
        });
        return {
          response: new Response(successStream, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
          url: "https://agentrouter.org/v1/responses",
        };
      });

      const log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
      const result = await customExecutor.execute({
        model: "gpt-5.6-sol",
        body: {},
        stream: true,
        credentials: { apiKey: "sk-test" },
        log,
      });

      expect(callCount).toBe(2);
      expect(result.response.status).toBe(200);

      // Verify that the returned response contains the successful content
      const reader = result.response.body.getReader();
      const decoder = new TextDecoder();
      let fullText = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fullText += decoder.decode(value, { stream: true });
      }
      expect(fullText).toContain("Here is the solution.");
      expect(log.warn).toHaveBeenCalledWith(
        "AGENTROUTER",
        expect.stringContaining("Rate limit detected")
      );
    });

    it("returns HTTP 429 when rate limit persists after max retries", async () => {
      const encoder = new TextEncoder();
      let callCount = 0;

      const customExecutor = new AgentRouterExecutor("agentrouter", {
        rateLimitDelayMs: 10,
        maxRateLimitRetries: 2,
      });

      customExecutor.dispatch = vi.fn().mockImplementation(async () => {
        callCount++;
        const errorStream = new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"message":"Your requests to gpt-5.6-sol for gpt-5.6-sol in eastus2 have exceeded token rate limit."}}}\n\n'
              )
            );
            controller.close();
          },
        });
        return {
          response: new Response(errorStream, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
          url: "https://agentrouter.org/v1/responses",
        };
      });

      const log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
      const result = await customExecutor.execute({
        model: "gpt-5.6-sol",
        body: {},
        stream: true,
        credentials: { apiKey: "sk-test" },
        log,
      });

      // Attempt 1 + 2 retries = 3 attempts total
      expect(callCount).toBe(3);
      expect(result.response.status).toBe(429);
      const json = await result.response.json();
      expect(json.error.message).toContain("exceeded token rate limit");
      expect(log.error).toHaveBeenCalledWith(
        "AGENTROUTER",
        expect.stringContaining("Rate limit persisted after 2 retries")
      );
    });
  });
});
