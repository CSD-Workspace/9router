/**
 * usage/agentrouter.js — AgentRouter (New-API) balance quota handler
 *
 * Connects AgentRouter to New-API balance detection (/api/user/self),
 * converting raw New-API credit units into dollar balance.
 */

import { fetchNewApiAggregatorQuotaDetailed } from "../newApiAggregatorQuotaFetcher.js";

/**
 * Fetch and shape AgentRouter usage/balance for dashboard Provider Limits.
 *
 * @param {object} connection - Provider connection object
 * @param {object|null} [proxyOptions] - Optional connection proxy config
 * @returns {Promise<object>} Usage data structure
 */
export async function getAgentrouterUsage(connection, proxyOptions = null) {
  const connectionId = connection?.id || connection?.connectionId || "";
  const { quota, error } = await fetchNewApiAggregatorQuotaDetailed(
    connectionId,
    connection,
    proxyOptions,
  );

  if (!quota) {
    let message = "AgentRouter balance not available. Add the Console API Key + User ID to the connection to view usage.";
    if (error === "waf_challenge") {
      message = "AgentRouter balance cannot be checked directly: agentrouter.org/api/user/self is protected by Aliyun WAF anti-bot challenge. Assign an active proxy pool to this connection to bypass the block.";
    } else if (error === "unauthorized") {
      message = "AgentRouter balance unauthorized (HTTP 401/403). Check Console API Key (System Access Token) and New-API User ID.";
    } else if (error === "missing_credentials") {
      message = "AgentRouter balance not available. Add the Console API Key + User ID to the connection to view usage.";
    } else if (error && error !== "aggregator_not_enabled") {
      message = `AgentRouter balance error: ${error}`;
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
    displayName: "Wallet Balance",
    isCreditBalance: true,
    neverExpires: true,
  };

  return {
    plan: "AgentRouter",
    quotas: { balance },
    remainingUsd,
    availableUsd: remainingUsd,
    balance: remainingUsd,
  };
}
