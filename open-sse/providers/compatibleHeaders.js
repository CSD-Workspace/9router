import { PROVIDERS } from "../config/providers.js";

export const ANTHROPIC_COMPATIBLE_PREFIX = "anthropic-compatible-";
export const OPENAI_COMPATIBLE_PREFIX = "openai-compatible-";

export function isAnthropicCompatibleProvider(providerId) {
  return typeof providerId === "string" && providerId.startsWith(ANTHROPIC_COMPATIBLE_PREFIX);
}

export function isOpenAICompatibleProvider(providerId) {
  return typeof providerId === "string" && providerId.startsWith(OPENAI_COMPATIBLE_PREFIX);
}

export function isCompatibleProvider(providerId) {
  return isAnthropicCompatibleProvider(providerId) || isOpenAICompatibleProvider(providerId);
}

export function getAgentRouterHeaders() {
  return (
    PROVIDERS.agentrouter?.headers || {
      "User-Agent": "claude-cli/2.1.280 (external, sdk-cli)",
      "Anthropic-Dangerous-Direct-Browser-Access": "true",
      "X-App": "cli",
    }
  );
}

export const ANTHROPIC_COMPATIBLE_DEFAULT_HEADERS = {
  "User-Agent": "claude-cli/2.1.280 (external, sdk-cli)",
  "Anthropic-Dangerous-Direct-Browser-Access": "true",
  "X-App": "cli",
};

export const OPENAI_COMPATIBLE_DEFAULT_HEADERS = {
  "User-Agent": "opencode/1.18.25",
};

export function getCompatibleDefaultHeaders(providerId) {
  if (isAnthropicCompatibleProvider(providerId)) {
    return { ...(PROVIDERS.agentrouter?.headers || ANTHROPIC_COMPATIBLE_DEFAULT_HEADERS) };
  }
  if (isOpenAICompatibleProvider(providerId)) {
    return { ...OPENAI_COMPATIBLE_DEFAULT_HEADERS };
  }
  return {};
}

/**
 * Case-insensitively apply custom headers onto target headers object.
 * Replaces any existing header matching key case-insensitively.
 */
export function applyCaseInsensitiveHeaders(target, customHeaders) {
  if (!customHeaders || typeof customHeaders !== "object") return target;
  for (const [key, value] of Object.entries(customHeaders)) {
    if (value === undefined || value === null) continue;
    const lower = key.toLowerCase();
    for (const existing of Object.keys(target)) {
      if (existing.toLowerCase() === lower) {
        delete target[existing];
      }
    }
    target[key] = value;
  }
  return target;
}

