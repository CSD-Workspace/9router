// Regression: a combo aborted on the first request-scoped 4xx.
//
// checkFallbackError answers "should this failure cool the ACCOUNT down?" and says
// no for a 4xx, so one bad body never locks a healthy credential. The combo loop
// reused that same predicate to answer a different question — "would another model
// help?" — and returned the first member's 4xx straight to the client. Combo members
// are usually different providers, so a 400 from one (e.g. a relay answering "we got
// a bad response from the source") says nothing about the next.
import { describe, expect, it, vi } from "vitest";
import { handleComboChat } from "../../open-sse/services/combo.js";

const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function badRequestResponse(message) {
  return jsonResponse(400, {
    error: {
      message,
      type: "invalid_request_error",
      code: "bad_request",
    },
  });
}

describe("handleComboChat — request-scoped 4xx handling", () => {
  it("tries the next model when a member answers 4xx", async () => {
    const handleSingleModel = vi.fn(async (body, modelStr) => {
      if (modelStr === "deepseek-v4-flash") {
        return badRequestResponse(
          'We got a bad response from the source. Error message: {"error":{"message":"Please check your request parameters"}}'
        );
      }
      return jsonResponse(200, {
        choices: [{ message: { role: "assistant", content: "second model answered" } }],
      });
    });

    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "Hello" }] },
      models: ["deepseek-v4-flash", "openai/gpt-4o-mini"],
      handleSingleModel,
      log,
      comboName: "test-4xx",
      comboStrategy: "fallback",
    });

    expect(response.ok).toBe(true);
    expect(response.status).toBe(200);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    const data = await response.json();
    expect(data.choices[0].message.content).toBe("second model answered");
  });

  it("returns the first 4xx, not a synthesized 503, when every model fails", async () => {
    const first = "we got a bad response from the source";
    const handleSingleModel = vi.fn(async (body, modelStr) =>
      modelStr === "deepseek-v4-flash" ? badRequestResponse(first) : jsonResponse(500, { error: { message: "boom" } })
    );

    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "Hello" }] },
      models: ["deepseek-v4-flash", "openai/gpt-4o-mini"],
      handleSingleModel,
      log,
      comboName: "test-4xx-all-fail",
      comboStrategy: "fallback",
    });

    // The upstream's own 400 + message survives instead of being replaced by
    // "All combo models unavailable" with a 503.
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(JSON.stringify(data)).toContain(first);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
  });

  it("always retries the next model on 4xx — the old opt-out is ignored", async () => {
    const handleSingleModel = vi.fn(async (body, modelStr) =>
      modelStr === "deepseek-v4-flash"
        ? badRequestResponse("first model, bad request")
        : jsonResponse(200, { choices: [{ message: { role: "assistant", content: "second model answered" } }] })
    );

    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "Hello" }] },
      models: ["deepseek-v4-flash", "openai/gpt-4o-mini"],
      handleSingleModel,
      log,
      comboName: "test-4xx-always",
      comboStrategy: "fallback",
      // Legacy flag: no longer read. 4xx retry is unconditional.
      retryOnClientError: false,
    });

    expect(response.ok).toBe(true);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
  });

  it("does not consume a retry slot for a 4xx on the last model", async () => {
    const handleSingleModel = vi.fn(async () => badRequestResponse("last model, bad request"));

    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "Hello" }] },
      models: ["deepseek-v4-flash"],
      handleSingleModel,
      log,
      comboName: "test-4xx-single",
      comboStrategy: "fallback",
    });

    expect(response.status).toBe(400);
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
  });

  it("still falls through on text-matched 4xx such as rate limit wording", async () => {
    const handleSingleModel = vi.fn(async (body, modelStr) => {
      if (modelStr === "deepseek-v4-flash") {
        return jsonResponse(400, { error: { message: "rate limit reached for this key" } });
      }
      return jsonResponse(200, { choices: [{ message: { role: "assistant", content: "ok" } }] });
    });

    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "Hello" }] },
      models: ["deepseek-v4-flash", "openai/gpt-4o-mini"],
      handleSingleModel,
      log,
      comboName: "test-4xx-ratelimit",
      comboStrategy: "fallback",
    });

    expect(response.ok).toBe(true);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
  });
});
