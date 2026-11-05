import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchNewApiAggregatorQuota,
  invalidateNewApiAggregatorQuotaCache,
  isNewApiAggregatorBalanceConnection,
  stripV1Suffix,
  extractCredentials,
  parseNewApiAggregatorQuotaResponse,
  getNewApiAggregatorUsage,
  DEFAULT_QUOTA_PER_UNIT,
} from "../../open-sse/services/newApiAggregatorQuotaFetcher.js";
import { getAgentrouterUsage } from "../../open-sse/services/usage/agentrouter.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import { parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

describe("New-API Aggregator Quota Fetcher & AgentRouter Balance", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("stripV1Suffix", () => {
    it("strips trailing /v1 and /v1/ from baseUrl", () => {
      expect(stripV1Suffix("https://agentrouter.org/v1")).toBe("https://agentrouter.org");
      expect(stripV1Suffix("https://agentrouter.org/v1/")).toBe("https://agentrouter.org");
      expect(stripV1Suffix("https://my-gateway.com/api/v1")).toBe("https://my-gateway.com/api");
      expect(stripV1Suffix("https://my-gateway.com/")).toBe("https://my-gateway.com");
      expect(stripV1Suffix("https://my-gateway.com")).toBe("https://my-gateway.com");
      expect(stripV1Suffix("")).toBe("");
      expect(stripV1Suffix(null)).toBe("");
    });
  });

  describe("extractCredentials", () => {
    it("extracts AgentRouter defaults when baseUrl is omitted", () => {
      const creds = extractCredentials({
        provider: "agentrouter",
        providerSpecificData: {
          consoleApiKey: "console-token-123",
          newApiUserId: "42",
        },
      });
      expect(creds.systemAccessToken).toBe("console-token-123");
      expect(creds.userId).toBe("42");
      expect(creds.baseUrl).toBe("https://agentrouter.org");
      expect(creds.quotaPerUnit).toBe(DEFAULT_QUOTA_PER_UNIT);
      expect(creds.aggregatorFlag).toBe(true);
    });

    it("falls back to apiKey for agentrouter when consoleApiKey is not set", () => {
      const creds = extractCredentials({
        provider: "agentrouter",
        apiKey: "sk-router-token",
        providerSpecificData: {
          newApiUserId: "100",
        },
      });
      expect(creds.systemAccessToken).toBe("sk-router-token");
      expect(creds.userId).toBe("100");
    });

    it("honors custom quotaPerUnit and baseUrl for custom aggregator nodes", () => {
      const creds = extractCredentials({
        provider: "openai-compatible-node",
        providerSpecificData: {
          consoleApiKey: "sat",
          newApiUserId: "5",
          baseUrl: "https://my-newapi.io/v1",
          quotaPerUnit: 250000,
          newApiAggregatorBalance: true,
        },
      });
      expect(creds.baseUrl).toBe("https://my-newapi.io");
      expect(creds.quotaPerUnit).toBe(250000);
      expect(creds.aggregatorFlag).toBe(true);
    });
  });

  describe("parseNewApiAggregatorQuotaResponse", () => {
    it("correctly calculates dollar balance and exhaustion state from nested data.quota", () => {
      const res = parseNewApiAggregatorQuotaResponse({
        data: { quota: 500000 },
      });
      expect(res).toBeDefined();
      expect(res.rawQuota).toBe(500000);
      expect(res.dollarBalance).toBe(1.0);
      expect(res.limitReached).toBe(false);
      expect(res.percentUsed).toBe(0);
    });

    it("parses flat quota field and marks zero balance as limitReached", () => {
      const res = parseNewApiAggregatorQuotaResponse({ quota: 0 });
      expect(res).toBeDefined();
      expect(res.rawQuota).toBe(0);
      expect(res.dollarBalance).toBe(0);
      expect(res.limitReached).toBe(true);
      expect(res.percentUsed).toBe(1);
    });

    it("honors custom quotaPerUnit rate", () => {
      const res = parseNewApiAggregatorQuotaResponse(
        { data: { quota: 1000000 } },
        250000
      );
      expect(res.dollarBalance).toBe(4.0);
    });

    it("returns null for invalid or missing quota payloads", () => {
      expect(parseNewApiAggregatorQuotaResponse(null)).toBeNull();
      expect(parseNewApiAggregatorQuotaResponse({})).toBeNull();
      expect(parseNewApiAggregatorQuotaResponse({ data: {} })).toBeNull();
      expect(parseNewApiAggregatorQuotaResponse({ data: { quota: -5 } })).toBeNull();
    });
  });

  describe("fetchNewApiAggregatorQuota", () => {
    it("returns null when required credentials or userId are missing", async () => {
      const quota = await fetchNewApiAggregatorQuota("test-conn-1", {
        provider: "agentrouter",
        providerSpecificData: { consoleApiKey: "only-key" }, // missing newApiUserId
      });
      expect(quota).toBeNull();
    });

    it("fetches balance from {baseUrl}/api/user/self with correct headers", async () => {
      const connectionId = `conn-${Date.now()}`;
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: { quota: 1250000 } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
      globalThis.fetch = mockFetch;

      const quota = await fetchNewApiAggregatorQuota(connectionId, {
        provider: "agentrouter",
        providerSpecificData: {
          consoleApiKey: "my-console-token",
          newApiUserId: "42",
        },
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("https://agentrouter.org/api/user/self");
      expect(init.headers["Authorization"]).toBe("Bearer my-console-token");
      expect(init.headers["New-Api-User"]).toBe("42");

      expect(quota).toBeDefined();
      expect(quota.rawQuota).toBe(1250000);
      expect(quota.dollarBalance).toBe(2.5);
      expect(quota.limitReached).toBe(false);

      // Verify caching: second call within TTL does not trigger network fetch
      const cachedQuota = await fetchNewApiAggregatorQuota(connectionId, {
        provider: "agentrouter",
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(cachedQuota).toEqual(quota);

      invalidateNewApiAggregatorQuotaCache(connectionId);
    });

    it("evicts cache and returns null on 401/403 unauthorized responses", async () => {
      const connectionId = `unauth-${Date.now()}`;
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: "unauthorized" }), {
          status: 401,
        })
      );
      globalThis.fetch = mockFetch;

      const quota = await fetchNewApiAggregatorQuota(connectionId, {
        provider: "agentrouter",
        providerSpecificData: {
          consoleApiKey: "bad-token",
          newApiUserId: "99",
        },
      });

      expect(quota).toBeNull();
      invalidateNewApiAggregatorQuotaCache(connectionId);
    });
  });

  describe("isNewApiAggregatorBalanceConnection", () => {
    it("recognizes agentrouter and ar providers", () => {
      expect(isNewApiAggregatorBalanceConnection({ provider: "agentrouter" })).toBe(true);
      expect(isNewApiAggregatorBalanceConnection({ provider: "ar" })).toBe(true);
    });

    it("recognizes newApiAggregatorBalance boolean flag or complete credentials", () => {
      expect(
        isNewApiAggregatorBalanceConnection({
          providerSpecificData: { newApiAggregatorBalance: true },
        })
      ).toBe(true);

      expect(
        isNewApiAggregatorBalanceConnection({
          providerSpecificData: { consoleApiKey: "key", newApiUserId: "1" },
        })
      ).toBe(true);

      expect(
        isNewApiAggregatorBalanceConnection({
          provider: "openai",
          providerSpecificData: {},
        })
      ).toBe(false);

      expect(isNewApiAggregatorBalanceConnection(null)).toBe(false);
    });
  });

  describe("getAgentrouterUsage & getNewApiAggregatorUsage", () => {
    it("shapes AgentRouter balance into provider usage response with USD balance", async () => {
      const connectionId = `usage-conn-${Date.now()}`;
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: { quota: 3500000 } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

      const usage = await getAgentrouterUsage({
        id: connectionId,
        provider: "agentrouter",
        providerSpecificData: {
          consoleApiKey: "token-abc",
          newApiUserId: "12",
        },
      });

      expect(usage).toBeDefined();
      expect(usage.plan).toBe("AgentRouter");
      expect(usage.remainingUsd).toBe(7.0);
      expect(usage.quotas.balance.remaining).toBe(7.0);
      expect(usage.quotas.balance.total).toBe(7.0);
      expect(usage.quotas.balance.currency).toBe("USD");
      expect(usage.quotas.balance.remainingPercentage).toBe(100);

      // Verify dashboard parseQuotaData correctly formats it
      const parsedRows = parseQuotaData("agentrouter", usage);
      expect(parsedRows).toHaveLength(1);
      expect(parsedRows[0].remaining).toBe(7.0);
      expect(parsedRows[0].total).toBe(7.0);
      expect(parsedRows[0].currency).toBe("USD");
      expect(parsedRows[0].isCreditBalance).toBe(true);
      expect(parsedRows[0].neverExpires).toBe(true);

      invalidateNewApiAggregatorQuotaCache(connectionId);
    });

    it("returns helpful instructions when credentials are missing", async () => {
      const usage = await getAgentrouterUsage({
        id: "no-creds",
        provider: "agentrouter",
      });
      expect(usage.message).toContain("AgentRouter balance not available");
    });

    it("integrates with getUsageForProvider for both agentrouter and generic compatible nodes", async () => {
      const connId = `dyn-${Date.now()}`;
      globalThis.fetch = vi.fn().mockImplementation(
        async () =>
          new Response(JSON.stringify({ data: { quota: 500000 } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
      );

      // Test agentrouter provider
      const arUsage = await getUsageForProvider({
        id: connId,
        provider: "agentrouter",
        providerSpecificData: {
          consoleApiKey: "token",
          newApiUserId: "1",
        },
      });
      expect(arUsage.plan).toBe("AgentRouter");
      expect(arUsage.remainingUsd).toBe(1.0);

      invalidateNewApiAggregatorQuotaCache(connId);

      // Test custom compatible node opted into newApiAggregatorBalance
      const customUsage = await getUsageForProvider({
        id: connId,
        provider: "my-custom-node",
        providerSpecificData: {
          newApiAggregatorBalance: true,
          baseUrl: "https://custom-gateway.xyz",
          consoleApiKey: "token",
          newApiUserId: "2",
        },
      });
      expect(customUsage.plan).toBe("New-API Aggregator");
      expect(customUsage.remainingUsd).toBe(1.0);

      invalidateNewApiAggregatorQuotaCache(connId);

      // Test WAF challenge detection
      globalThis.fetch = vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response("<!doctype html><meta name=\"aliyun_waf_aa\" content=\"123\"><script></script>", {
            status: 200,
            headers: { "Content-Type": "text/html" },
          })
        )
      );

      const wafUsage = await getUsageForProvider({
        id: "waf-conn",
        provider: "agentrouter",
        providerSpecificData: {
          consoleApiKey: "token",
          newApiUserId: "1",
        },
      });
      expect(wafUsage.message).toContain("Aliyun WAF");

      invalidateNewApiAggregatorQuotaCache("waf-conn");
    });

    it("formats custom compatible node credit balance without zeroing total", () => {
      const parsedRows = parseQuotaData("openai-compatible-chat-custom-123", {
        plan: "New-API Aggregator",
        quotas: {
          balance: {
            used: 0,
            total: 238.25,
            remaining: 238.25,
            currency: "USD",
            displayName: "Account Balance",
            isCreditBalance: true,
          },
        },
      });

      expect(parsedRows).toHaveLength(1);
      expect(parsedRows[0].total).toBe(238.25);
      expect(parsedRows[0].remaining).toBe(238.25);
      expect(parsedRows[0].isCreditBalance).toBe(true);
      expect(parsedRows[0].neverExpires).toBe(true);
    });
  });
});
