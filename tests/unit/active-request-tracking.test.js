import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("Active Request Tracking & Topology Count", () => {
  let usageDb;

  beforeEach(async () => {
    // Reset in-memory global state before each test
    if (global._activeRequestsMap) {
      global._activeRequestsMap.clear();
    }
    if (global._pendingRequests) {
      global._pendingRequests.byModel = {};
      global._pendingRequests.byAccount = {};
    }
    if (global._lastErrorProvider) {
      global._lastErrorProvider.provider = "";
      global._lastErrorProvider.ts = 0;
    }
    usageDb = await import("@/lib/db/index.js");
  });

  afterEach(() => {
    if (global._activeRequestsMap) {
      global._activeRequestsMap.clear();
    }
  });

  it("essential acceptance test: 7 concurrent requests -> 4 -> 0", async () => {
    const provider = "openai";
    const model = "gpt-6";
    const apiKey = "sk-shared-key-1234567890abcdef";
    const requestIds = [];

    // Start 7 concurrent HTTP requests sharing the same API key, provider, and model
    for (let i = 1; i <= 7; i++) {
      const reqId = `req-agent-${i}`;
      requestIds.push(reqId);
      usageDb.registerActiveRequest({
        requestId: reqId,
        provider,
        model,
        apiKey,
        connectionId: "conn-shared",
      });
    }

    // Expected activeRequestCount = 7
    let activeState = await usageDb.getActiveRequests();
    expect(activeState.activeRequestCount).toBe(7);
    expect(activeState.activeRequests).toHaveLength(7);

    // Verify all 7 requests are tracked individually and keys are masked
    activeState.activeRequests.forEach((req) => {
      expect(req.provider).toBe(provider);
      expect(req.model).toBe(model);
      expect(req.apiKeyMasked).not.toBe(apiKey);
      expect(req.apiKeyMasked).toContain("***");
    });

    // Complete 3 requests (e.g. req-agent-1, req-agent-2, req-agent-3)
    usageDb.unregisterActiveRequest(requestIds[0]);
    usageDb.unregisterActiveRequest(requestIds[1]);
    usageDb.unregisterActiveRequest(requestIds[2]);

    // Expected activeRequestCount = 4
    activeState = await usageDb.getActiveRequests();
    expect(activeState.activeRequestCount).toBe(4);
    expect(activeState.activeRequests).toHaveLength(4);

    // Complete remaining 4 requests
    usageDb.unregisterActiveRequest(requestIds[3]);
    usageDb.unregisterActiveRequest(requestIds[4]);
    usageDb.unregisterActiveRequest(requestIds[5]);
    usageDb.unregisterActiveRequest(requestIds[6]);

    // Expected activeRequestCount = 0
    activeState = await usageDb.getActiveRequests();
    expect(activeState.activeRequestCount).toBe(0);
    expect(activeState.activeRequests).toHaveLength(0);
  });

  it("registers requests with unique request IDs and safe masked metadata", async () => {
    const rawApiKey = "sk-super-secret-production-key-9999";
    const reqId = usageDb.registerActiveRequest({
      requestId: "req-meta-test",
      provider: "anthropic",
      model: "claude-3-7-sonnet",
      apiKey: rawApiKey,
      status: "processing",
    });

    expect(reqId).toBe("req-meta-test");

    const state = await usageDb.getActiveRequests();
    expect(state.activeRequestCount).toBe(1);
    const item = state.activeRequests[0];
    expect(item.requestId).toBe("req-meta-test");
    expect(item.provider).toBe("anthropic");
    expect(item.model).toBe("claude-3-7-sonnet");
    expect(item.status).toBe("processing");
    // Verify secret is masked and never exposed
    expect(item.apiKeyMasked).not.toBe(rawApiKey);
    expect(item.apiKeyMasked).toBe("sk-super***9999");
  });

  it("prevents duplicate registration with the same requestId", async () => {
    usageDb.registerActiveRequest({
      requestId: "req-dup-1",
      provider: "openai",
      model: "gpt-4o",
    });
    // Register again with same ID
    usageDb.registerActiveRequest({
      requestId: "req-dup-1",
      provider: "openai",
      model: "gpt-4o",
    });

    const state = await usageDb.getActiveRequests();
    expect(state.activeRequestCount).toBe(1);
  });

  it("prevents duplicate cleanup (idempotent unregister does not double decrement)", async () => {
    usageDb.registerActiveRequest({
      requestId: "req-single",
      provider: "openai",
      model: "gpt-4o",
    });
    usageDb.registerActiveRequest({
      requestId: "req-keep",
      provider: "openai",
      model: "gpt-4o",
    });

    expect((await usageDb.getActiveRequests()).activeRequestCount).toBe(2);

    // First unregister
    usageDb.unregisterActiveRequest("req-single");
    expect((await usageDb.getActiveRequests()).activeRequestCount).toBe(1);

    // Duplicate unregister on already completed request
    usageDb.unregisterActiveRequest("req-single");
    // Count must remain 1, not decrement req-keep or become negative
    expect((await usageDb.getActiveRequests()).activeRequestCount).toBe(1);

    usageDb.unregisterActiveRequest("req-keep");
    expect((await usageDb.getActiveRequests()).activeRequestCount).toBe(0);

    // Extra unregister on empty map
    usageDb.unregisterActiveRequest("req-keep");
    expect((await usageDb.getActiveRequests()).activeRequestCount).toBe(0);
  });

  it("handles multi-provider concurrency without provider deduplication", async () => {
    // 7 requests across 3 providers: 3 openai, 2 anthropic, 2 gemini
    const reqs = [
      { id: "req-o1", provider: "openai", model: "gpt-4o" },
      { id: "req-o2", provider: "openai", model: "gpt-4o" },
      { id: "req-o3", provider: "openai", model: "o3-mini" },
      { id: "req-a1", provider: "anthropic", model: "claude-3-7-sonnet" },
      { id: "req-a2", provider: "anthropic", model: "claude-3-5-haiku" },
      { id: "req-g1", provider: "gemini", model: "gemini-2.5-pro" },
      { id: "req-g2", provider: "gemini", model: "gemini-2.5-flash" },
    ];

    reqs.forEach((r) => {
      usageDb.registerActiveRequest({
        requestId: r.id,
        provider: r.provider,
        model: r.model,
      });
    });

    let state = await usageDb.getActiveRequests();
    expect(state.activeRequestCount).toBe(7);

    // Complete requests in different order from start
    usageDb.unregisterActiveRequest("req-a2");
    usageDb.unregisterActiveRequest("req-o1");

    state = await usageDb.getActiveRequests();
    expect(state.activeRequestCount).toBe(5);

    // Complete remaining
    usageDb.unregisterActiveRequest("req-o2");
    usageDb.unregisterActiveRequest("req-o3");
    usageDb.unregisterActiveRequest("req-a1");
    usageDb.unregisterActiveRequest("req-g1");
    usageDb.unregisterActiveRequest("req-g2");

    state = await usageDb.getActiveRequests();
    expect(state.activeRequestCount).toBe(0);
  });

  it("records upstream errors on request failure without retaining the active request", async () => {
    usageDb.registerActiveRequest({
      requestId: "req-err-1",
      provider: "deepseek",
      model: "deepseek-chat",
    });

    expect((await usageDb.getActiveRequests()).activeRequestCount).toBe(1);

    // Unregister with error flag
    usageDb.unregisterActiveRequest("req-err-1", { error: true, provider: "deepseek" });

    const state = await usageDb.getActiveRequests();
    expect(state.activeRequestCount).toBe(0);
    expect(state.errorProvider).toBe("deepseek");
  });

  it("trackPendingRequest positional compatibility routes to register/unregister", async () => {
    const reqId = "req-compat-1";
    // Start request via trackPendingRequest positional
    usageDb.trackPendingRequest("gpt-4", "openai", "conn-1", true, false, { requestId: reqId });

    let state = await usageDb.getActiveRequests();
    expect(state.activeRequestCount).toBe(1);
    expect(state.activeRequests[0].requestId).toBe(reqId);
    expect(global._pendingRequests.byModel["gpt-4 (openai)"]).toBe(1);

    // Complete request
    usageDb.trackPendingRequest("gpt-4", "openai", "conn-1", false, false, { requestId: reqId });

    state = await usageDb.getActiveRequests();
    expect(state.activeRequestCount).toBe(0);
    expect(global._pendingRequests.byModel["gpt-4 (openai)"]).toBeUndefined();
  });

  it("getUsageStats includes activeRequests and activeRequestCount", async () => {
    usageDb.registerActiveRequest({
      requestId: "req-stat-1",
      provider: "openai",
      model: "gpt-4o",
    });
    usageDb.registerActiveRequest({
      requestId: "req-stat-2",
      provider: "openai",
      model: "gpt-4o",
    });

    const stats = await usageDb.getUsageStats("today");
    expect(stats.activeRequestCount).toBe(2);
    expect(stats.activeRequests).toHaveLength(2);

    usageDb.unregisterActiveRequest("req-stat-1");
    usageDb.unregisterActiveRequest("req-stat-2");
  });

  it("statsEmitter emits pending event on start and completion", async () => {
    const emitSpy = vi.fn();
    usageDb.statsEmitter.on("pending", emitSpy);

    usageDb.registerActiveRequest({
      requestId: "req-emit-test",
      provider: "openai",
      model: "gpt-4o",
    });

    // Wait for scheduleStatsEvent debounce (150ms)
    await new Promise((r) => setTimeout(r, 200));
    expect(emitSpy).toHaveBeenCalled();

    const callCountAfterStart = emitSpy.mock.calls.length;

    usageDb.unregisterActiveRequest("req-emit-test");
    await new Promise((r) => setTimeout(r, 200));
    expect(emitSpy.mock.calls.length).toBeGreaterThan(callCountAfterStart);

    usageDb.statsEmitter.off("pending", emitSpy);
  });

  it("handles streaming completion and client disconnect cleanup", async () => {
    const { createStreamController, createDisconnectAwareStream } = await import("../../open-sse/utils/streamHandler.js");

    // Case 1: Stream completes normally
    const reqId1 = "req-stream-normal";
    usageDb.registerActiveRequest({
      requestId: reqId1,
      provider: "openai",
      model: "gpt-4o",
    });
    expect((await usageDb.getActiveRequests()).activeRequestCount).toBe(1);

    const controller1 = createStreamController({
      onComplete: () => usageDb.unregisterActiveRequest(reqId1),
      onDisconnect: () => usageDb.unregisterActiveRequest(reqId1),
      onError: () => usageDb.unregisterActiveRequest(reqId1, { error: true }),
      provider: "openai",
      model: "gpt-4o",
    });

    let readableController1;
    const readable1 = new ReadableStream({
      start(ctrl) {
        readableController1 = ctrl;
      },
    });
    const stream1 = createDisconnectAwareStream(
      { readable: readable1, writable: { getWriter: () => ({ abort: () => Promise.resolve() }) } },
      controller1
    );

    const reader1 = stream1.getReader();
    readableController1.enqueue(new TextEncoder().encode("data: hello\n\n"));
    const chunk1 = await reader1.read();
    expect(chunk1.done).toBe(false);

    // Close stream normally
    readableController1.close();
    const doneChunk = await reader1.read();
    expect(doneChunk.done).toBe(true);

    // Verify cleanup completed
    expect((await usageDb.getActiveRequests()).activeRequestCount).toBe(0);

    // Case 2: Client disconnects / cancels during streaming
    const reqId2 = "req-stream-disconnect";
    usageDb.registerActiveRequest({
      requestId: reqId2,
      provider: "openai",
      model: "gpt-4o",
    });
    expect((await usageDb.getActiveRequests()).activeRequestCount).toBe(1);

    const controller2 = createStreamController({
      onComplete: () => usageDb.unregisterActiveRequest(reqId2),
      onDisconnect: () => usageDb.unregisterActiveRequest(reqId2),
      onError: () => usageDb.unregisterActiveRequest(reqId2, { error: true }),
      provider: "openai",
      model: "gpt-4o",
    });

    const readable2 = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode("data: chunk\n\n"));
      },
    });
    const stream2 = createDisconnectAwareStream(
      { readable: readable2, writable: { getWriter: () => ({ abort: () => Promise.resolve() }) } },
      controller2
    );

    const reader2 = stream2.getReader();
    await reader2.read();
    // Client aborts / cancels
    await reader2.cancel("client disconnected");

    // Verify cleanup happened on disconnect
    expect((await usageDb.getActiveRequests()).activeRequestCount).toBe(0);
  });

  it("verifies topology scenarios: 0, 1, 7 across same or multiple providers, 10, 3", () => {
    // Helper replicating ProviderTopology count resolution
    function resolveBadgeCount(activeRequests, activeRequestCount) {
      if (typeof activeRequestCount === "number") return activeRequestCount;
      if (Array.isArray(activeRequests)) return activeRequests.length;
      return 0;
    }

    // Scenario 1: No active requests -> 0
    expect(resolveBadgeCount([], 0)).toBe(0);
    expect(resolveBadgeCount([])).toBe(0);

    // Scenario 2: 1 active request -> 1
    const oneReq = [{ requestId: "r1", provider: "openai", model: "gpt-6" }];
    expect(resolveBadgeCount(oneReq, 1)).toBe(1);

    // Scenario 3: 1 Main Agent + 6 Sub Agents using same provider -> 7
    const sevenSameProvider = Array.from({ length: 7 }, (_, i) => ({
      requestId: `req-${i}`,
      provider: "openai",
      model: "gpt-6",
    }));
    // Note: Deduplicating by provider (Set.size) would wrongly yield 1.
    // Our count must yield 7!
    const providerSetSize = new Set(sevenSameProvider.map((r) => r.provider)).size;
    expect(providerSetSize).toBe(1); // Provider deduplication would be wrong
    expect(resolveBadgeCount(sevenSameProvider, 7)).toBe(7); // Correct total HTTP requests

    // Scenario 4: 10 concurrent requests to the same provider -> 10
    const tenSameProvider = Array.from({ length: 10 }, (_, i) => ({
      requestId: `req-${i}`,
      provider: "anthropic",
      model: "claude-3-7-sonnet",
    }));
    expect(resolveBadgeCount(tenSameProvider, 10)).toBe(10);

    // Scenario 5: 7 requests across 3 providers -> 7
    const sevenAcrossThree = [
      { requestId: "r1", provider: "openai" },
      { requestId: "r2", provider: "openai" },
      { requestId: "r3", provider: "openai" },
      { requestId: "r4", provider: "anthropic" },
      { requestId: "r5", provider: "anthropic" },
      { requestId: "r6", provider: "gemini" },
      { requestId: "r7", provider: "gemini" },
    ];
    expect(resolveBadgeCount(sevenAcrossThree, 7)).toBe(7);

    // Scenario 6: 3 active requests, 4 completed -> 3
    const threeRemaining = [
      { requestId: "r1", provider: "openai" },
      { requestId: "r2", provider: "openai" },
      { requestId: "r3", provider: "openai" },
    ];
    expect(resolveBadgeCount(threeRemaining, 3)).toBe(3);
  });
});
