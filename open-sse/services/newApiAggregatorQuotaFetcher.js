/**
 * newApiAggregatorQuotaFetcher.js — Generalized New-API / One-API / Sub2API
 * Aggregator Balance Quota Fetcher
 *
 * Implements balance quota detection for AgentRouter and any custom
 * OpenAI/Anthropic-compatible node running on New-API / One-API / Sub2API gateways.
 *
 * Upstream New-API endpoint:
 *   GET {baseUrl}/api/user/self
 *     Authorization: Bearer {systemAccessToken}
 *     New-Api-User: {userId}
 *   -> { "data": { "quota": <int> } } (raw New-API credit units)
 *
 * Default quotaPerUnit: 500,000 units per $1.
 */

import { proxyAwareFetch } from "../utils/proxyFetch.js";

export const SELF_PATH = "/api/user/self";
export const DEFAULT_QUOTA_PER_UNIT = 500_000;
export const CACHE_TTL_MS = 60_000; // 60 seconds

const quotaCache = new Map();

// Periodic cache cleanup
const _cacheCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of quotaCache) {
    if (now - entry.fetchedAt > CACHE_TTL_MS * 5) {
      quotaCache.delete(key);
    }
  }
}, 5 * 60_000);

if (_cacheCleanup && typeof _cacheCleanup === "object" && "unref" in _cacheCleanup) {
  _cacheCleanup.unref?.();
}

function toRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function toNumber(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/**
 * Strip trailing `/v1` or `/v1/` from baseUrl so that node URLs like
 * `https://host/v1` hit `{host}/api/user/self` instead of `{host}/v1/api/user/self`.
 */
export function stripV1Suffix(baseUrl) {
  if (!baseUrl || typeof baseUrl !== "string") return "";
  return baseUrl.trim().replace(/\/v1\/?$/, "").replace(/\/+$/, "");
}

/**
 * Extract credentials and configuration from a connection object.
 */
export function extractCredentials(connection) {
  const provider = connection?.provider || "";
  const isAgentRouter = provider === "agentrouter" || provider === "ar";
  const psd = toRecord(connection?.providerSpecificData);

  const systemAccessToken =
    (typeof psd.consoleApiKey === "string" && psd.consoleApiKey.trim()) ||
    (isAgentRouter && typeof connection?.apiKey === "string" && connection.apiKey.trim() ? connection.apiKey.trim() : null) ||
    null;

  const userId =
    (typeof psd.newApiUserId === "string" && psd.newApiUserId.trim()) ||
    (typeof psd.userId === "string" && psd.userId.trim()) ||
    null;

  let rawBaseUrl =
    (typeof psd.baseUrl === "string" && psd.baseUrl.trim()) ||
    (typeof connection?.baseUrl === "string" && connection.baseUrl.trim()) ||
    (isAgentRouter ? "https://agentrouter.org" : null);

  const baseUrl = rawBaseUrl ? stripV1Suffix(rawBaseUrl) : null;

  const rawQuotaPerUnit = toNumber(psd.quotaPerUnit, 0);
  const quotaPerUnit = rawQuotaPerUnit > 0 ? rawQuotaPerUnit : DEFAULT_QUOTA_PER_UNIT;

  // Opt-in flag: AgentRouter is inherently New-API; other providers require flag or credentials
  const aggregatorFlag =
    psd.newApiAggregatorBalance === true ||
    isAgentRouter ||
    Boolean(systemAccessToken && userId && baseUrl);

  return { systemAccessToken, userId, baseUrl, quotaPerUnit, aggregatorFlag };
}

/**
 * Parse upstream response from New-API /api/user/self
 */
export function parseNewApiAggregatorQuotaResponse(data, quotaPerUnit = DEFAULT_QUOTA_PER_UNIT) {
  const obj = toRecord(data);
  const dataObj = toRecord(obj.data);

  const rawQuotaValue = "quota" in dataObj ? dataObj.quota : obj.quota;
  if (rawQuotaValue === undefined || rawQuotaValue === null) return null;

  const rawQuota = toNumber(rawQuotaValue, -1);
  if (rawQuota < 0) return null;

  const effectiveUnit = quotaPerUnit > 0 ? quotaPerUnit : DEFAULT_QUOTA_PER_UNIT;
  const dollarBalance = rawQuota / effectiveUnit;
  const limitReached = rawQuota <= 0;
  const percentUsed = limitReached ? 1 : 0;

  return {
    used: percentUsed * 100,
    total: 100,
    percentUsed,
    resetAt: null,
    rawQuota,
    dollarBalance,
    limitReached,
  };
}

/**
 * Fetch current quota with detailed error reporting.
 *
 * @param {string} connectionId - Connection ID (used as cache key)
 * @param {object} connection - Connection record with credentials & providerSpecificData
 * @param {object|null} [proxyOptions] - Optional proxy configuration
 * @returns {Promise<{quota: object|null, error: string|null}>}
 */
export async function fetchNewApiAggregatorQuotaDetailed(connectionId, connection, proxyOptions = null) {
  const cacheKey = String(connectionId || connection?.id || connection?.connectionId || "default");
  const cached = quotaCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { quota: cached.quota, error: null };
  }

  const { systemAccessToken, userId, baseUrl, quotaPerUnit, aggregatorFlag } =
    extractCredentials(connection);

  if (!aggregatorFlag) return { quota: null, error: "aggregator_not_enabled" };
  if (!systemAccessToken || !userId || !baseUrl) return { quota: null, error: "missing_credentials" };

  const url = `${baseUrl}${SELF_PATH}`;

  try {
    const fetchFn = (proxyOptions?.connectionProxyEnabled || proxyOptions?.proxyPoolId || proxyOptions?.vercelRelayUrl)
      ? (targetUrl, init) => proxyAwareFetch(targetUrl, init, proxyOptions)
      : (globalThis.fetch || proxyAwareFetch);

    const response = await fetchFn(
      url,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${systemAccessToken}`,
          "New-Api-User": String(userId),
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined,
      }
    );

    if (!response) return { quota: null, error: "no_response" };

    if (response.status === 401 || response.status === 403) {
      quotaCache.delete(cacheKey);
      return { quota: null, error: "unauthorized" };
    }

    if (!response.ok) {
      return { quota: null, error: `http_${response.status}` };
    }

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      if (text.includes("aliyun_waf") || text.includes("<!doctype") || text.includes("<html")) {
        return { quota: null, error: "waf_challenge" };
      }
      return { quota: null, error: "invalid_json" };
    }

    const quota = parseNewApiAggregatorQuotaResponse(data, quotaPerUnit);
    if (!quota) return { quota: null, error: "invalid_quota_format" };

    quotaCache.set(cacheKey, { quota, fetchedAt: Date.now() });
    return { quota, error: null };
  } catch (error) {
    return { quota: null, error: error.message || "network_error" };
  }
}

/**
 * Fetch current quota for a New-API / One-API / Sub2API connection.
 *
 * @param {string} connectionId - Connection ID (used as cache key)
 * @param {object} connection - Connection record with credentials & providerSpecificData
 * @param {object|null} [proxyOptions] - Optional proxy configuration
 * @returns {Promise<object|null>} Quota info or null
 */
export async function fetchNewApiAggregatorQuota(connectionId, connection, proxyOptions = null) {
  const result = await fetchNewApiAggregatorQuotaDetailed(connectionId, connection, proxyOptions);
  return result.quota;
}

/**
 * Invalidate cache for a specific connection.
 */
export function invalidateNewApiAggregatorQuotaCache(connectionId) {
  const cacheKey = String(connectionId || "");
  if (cacheKey) quotaCache.delete(cacheKey);
}

/**
 * Check if connection has opted in to New-API aggregator balance tracking.
 */
export function isNewApiAggregatorBalanceConnection(connection) {
  if (!connection || typeof connection !== "object") return false;
  const provider = connection.provider || "";
  if (provider === "agentrouter" || provider === "ar") return true;
  const psd = toRecord(connection.providerSpecificData);
  return (
    psd.newApiAggregatorBalance === true ||
    (Boolean(psd.consoleApiKey) && Boolean(psd.newApiUserId))
  );
}

/**
 * Standard usage shape for generic New-API aggregator nodes
 */
export async function getNewApiAggregatorUsage(connection, proxyOptions = null) {
  const connectionId = connection?.id || connection?.connectionId || "";
  const { quota, error } = await fetchNewApiAggregatorQuotaDetailed(connectionId, connection, proxyOptions);

  if (!quota) {
    let message = "New-API aggregator balance not available. Check Console API Key, User ID, and Base URL.";
    if (error === "waf_challenge") {
      message = "New-API balance blocked by upstream WAF / anti-bot challenge.";
    } else if (error === "unauthorized") {
      message = "New-API balance unauthorized (HTTP 401/403). Check Console API Key and User ID.";
    } else if (error === "missing_credentials") {
      message = "New-API aggregator balance not configured. Please enter Console API Key (System Access Token) and User ID.";
    } else if (error && error !== "aggregator_not_enabled") {
      message = `New-API balance error: ${error}`;
    }
    return { message };
  }

  const remainingUsd = Math.max(0, quota.dollarBalance);
  const remainingPercentage = quota.limitReached ? 0 : 100;

  const balance = {
    used: 0,
    total: remainingUsd,
    remaining: remainingUsd,
    remainingPercentage,
    resetAt: quota.resetAt ?? null,
    unlimited: false,
    currency: "USD",
    displayName: "Account Balance",
    isCreditBalance: true,
    neverExpires: true,
  };

  return {
    plan: "New-API Aggregator",
    quotas: { balance },
    remainingUsd,
    availableUsd: remainingUsd,
    balance: remainingUsd,
  };
}
