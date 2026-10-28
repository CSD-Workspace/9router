export default {
  id: "agentrouter",
  alias: "ar",
  aliases: ["agent-router"],
  uiAlias: "ar",
  display: {
    name: "AgentRouter",
    icon: "router",
    color: "#6366F1",
    textIcon: "AR",
    website: "https://agentrouter.org",
    notice: {
      signupUrl: "https://agentrouter.org",
      apiKeyUrl: "https://agentrouter.org",
    },
  },
  category: "freeTier",
  authType: "apikey",
  authModes: ["apikey"],
  hasFree: true,
  passthroughModels: true,
  modelsFetcher: { url: "https://agentrouter.org/v1/models", type: "openai" },
  transports: [
    {
      format: "claude",
      baseUrl: "https://agentrouter.org/v1/messages",
      urlSuffix: "?beta=true",
      auth: {
        combined: true,
        header: "x-api-key",
        scheme: "raw",
        anthropicVersion: true,
      },
    },
    {
      format: "openai",
      baseUrl: "https://agentrouter.org/v1/chat/completions",
      auth: {
        combined: true,
        header: "Authorization",
        scheme: "bearer",
      },
    },
    {
      format: "openai-responses",
      baseUrl: "https://agentrouter.org/v1/responses",
      auth: {
        combined: true,
        header: "Authorization",
        scheme: "bearer",
      },
    },
  ],
  transport: {
    baseUrl: "https://agentrouter.org/v1/messages",
    validateUrl: "https://agentrouter.org/v1/messages",
    format: "claude",
    headers: {
      "User-Agent": "claude-cli/2.1.280 (external, sdk-cli)",
      "Anthropic-Dangerous-Direct-Browser-Access": "true",
      "X-App": "cli",
    },
    auth: {
      combined: true,
      header: "x-api-key",
      scheme: "raw",
      anthropicVersion: true,
    },
    stallTimeoutMs: 30000,
  },
  models: [
    { id: "gpt-5.6-sol", name: "GPT 5.6 Sol (AgentRouter)", supportedFormats: ["openai-responses"], targetFormat: "openai-responses", contextLength: 200000 },
    { id: "gpt-6-astra", name: "GPT 6 Astra (AgentRouter)", supportedFormats: ["openai-responses"], targetFormat: "openai-responses", contextLength: 200000 },
    { id: "gpt-6.1-sol", name: "GPT 6.1 Sol (AgentRouter)", supportedFormats: ["openai-responses"], targetFormat: "openai-responses", contextLength: 200000 },
  ],
  thinkingConfig: {
    options: ["auto", "on", "off"],
    defaultMode: "auto",
    defaultBudgetTokens: 10000,
  },
};
