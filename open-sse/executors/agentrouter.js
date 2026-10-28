import { DefaultExecutor } from "./default.js";
import { getAgentRouterHeaders, normalizeProfile } from "../providers/agentrouterPolicy.js";
import { globalWafStore, isWafBlock } from "../providers/agentrouterWaf.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { openaiToOpenAIResponsesRequest } from "../translator/request/openai-responses.js";
import { openaiResponsesToOpenAIResponse } from "../translator/response/openai-responses.js";
import { initState } from "../translator/index.js";
import { parseSSELine, formatSSE } from "../utils/streamHelpers.js";
import { SSE_DONE } from "../utils/sseConstants.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

const DEFAULT_BASE_URL = "https://agentrouter.org/v1";

function cleanBaseUrl(url) {
  let base = (url || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  // Strip trailing endpoint if provided (e.g. /messages, /chat/completions, /responses, /models)
  base = base.replace(/\/+(messages(\?.*)?|chat\/completions|responses|models)$/i, "");
  if (!base.endsWith("/v1")) {
    // If base doesn't end with /v1, append it
    base = `${base}/v1`;
  }
  return base;
}

export class AgentRouterExecutor extends DefaultExecutor {
  constructor(provider = "agentrouter") {
    super(provider);
    this.provider = provider;
  }

  isClaudeModel(model) {
    if (!model || typeof model !== "string") return false;
    const clean = model.replace(/\([^()]+\)\s*$/, "").trim();
    const base = clean.includes("/") ? clean.split("/").pop() : clean;
    return /^claude-/i.test(base);
  }

  isResponsesModel(model) {
    if (!model || typeof model !== "string") return false;
    const clean = model.replace(/\([^()]+\)\s*$/, "").trim();
    const base = clean.includes("/") ? clean.split("/").pop() : clean;
    return /^(gpt-[56]|.*-codex|codex|grok-build|muse[-_]?spark)/i.test(base);
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    const rt = credentials?.runtimeTransport;
    if (rt?.baseUrl) {
      return rt.urlSuffix ? `${rt.baseUrl}${rt.urlSuffix}` : rt.baseUrl;
    }

    const rawBase = credentials?.providerSpecificData?.baseUrl || this.config.baseUrl || DEFAULT_BASE_URL;
    const base = cleanBaseUrl(rawBase);

    if (this.isClaudeModel(model)) {
      return `${base}/messages?beta=true`;
    }
    if (this.isResponsesModel(model)) {
      return `${base}/responses`;
    }
    return `${base}/chat/completions`;
  }

  buildHeaders(credentials, stream = true, url = "", model = "", transformedBody = null) {
    const isClaude = url.includes("/messages") || this.isClaudeModel(model);
    const configuredProfile = credentials?.providerSpecificData?.profile;

    return getAgentRouterHeaders({
      profile: configuredProfile,
      model,
      isClaudeEndpoint: isClaude,
      stream,
      apiKey: credentials?.apiKey || credentials?.accessToken || "",
      customHeaders: this.config.headers,
      body: transformedBody,
    });
  }

  transformRequest(model, body, stream, credentials) {
    if (!body || typeof body !== "object") return body;
    const transformed = { ...body };

    // GLM models thinking mapping: AgentRouter GLM upstream expects thinking.type = "enabled"
    if (/^glm-/i.test(model)) {
      if (transformed.thinking?.type === "adaptive" || transformed.reasoning_effort) {
        transformed.thinking = { type: "enabled" };
      }
    }

    // AgentRouter upstream uses Rust serde for tool calls, requiring type: "function"
    if (Array.isArray(transformed.tools)) {
      transformed.tools = transformed.tools
        .map((tool) => {
          if (!tool || typeof tool !== "object") return null;
          const fn = tool.function || tool;
          const name = tool.name || fn.name;
          if (!name) return null;
          return {
            type: "function",
            function: {
              name,
              description: fn.description || "",
              parameters: fn.parameters || { type: "object", properties: {} },
            },
          };
        })
        .filter(Boolean);
    }

    // Strip store property for OpenAI chat completions
    if ("store" in transformed) {
      delete transformed.store;
    }

    return transformed;
  }

  parseError(response, bodyText) {
    const text = String(bodyText || "");

    // 400 content-blocked (AgentRouter WAF keyword filter)
    if (response.status === 400 && text.includes("content-blocked")) {
      return {
        status: 400,
        code: "content_blocked",
        message: "Prompt blocked by AgentRouter keyword content filter. Please avoid placeholder phrases or test tokens.",
      };
    }

    // 503 no available channel / 402 quota exhausted
    if (
      response.status === 503 &&
      (text.includes("no available channel") || text.includes("无可用渠道"))
    ) {
      return {
        status: 503,
        code: "no_channel",
        message: "AgentRouter has no available channel for this model/key. Triggering fallback.",
      };
    }

    if (response.status === 402) {
      return {
        status: 402,
        code: "quota_exhausted",
        message: "AgentRouter account balance exhausted.",
      };
    }

    // WAF HTML challenge page
    if (
      (response.status === 403 || response.status === 405) &&
      (text.includes("alicdn") || text.includes("block_message") || text.includes("waf.js"))
    ) {
      return {
        status: 403,
        code: "waf_challenge",
        message: "AgentRouter upstream WAF challenge encountered.",
      };
    }

    return super.parseError(response, bodyText);
  }

  shouldRetry(status, urlIndex) {
    // Never retry auth errors, quota exhaustion, content filter rejections, or no-channel errors
    if (
      status === 400 ||
      status === 401 ||
      status === 403 ||
      status === 402
    ) {
      return false;
    }

    return super.shouldRetry(status, urlIndex);
  }

  async execute(params) {
    const rawBase = params.credentials?.providerSpecificData?.baseUrl || this.config.baseUrl || DEFAULT_BASE_URL;

    // Warmup WAF session cookies if store is empty
    if (!globalWafStore.get()) {
      await globalWafStore.warmup(rawBase);
    }

    let result = await super.execute(params);

    if (result?.response) {
      // In-flight capture of rotated Set-Cookie from response
      globalWafStore.capture(result.response);

      // Check for WAF 403/405 challenge block page
      if (result.response.status === 403 || result.response.status === 405) {
        try {
          const cloned = result.response.clone();
          const text = await cloned.text();
          if (isWafBlock(result.response.status, text)) {
            params.log?.debug?.("WAF", "Encountered WAF challenge page. Warming up cookies and retrying once...");
            const warmed = await globalWafStore.warmup(rawBase);
            if (warmed) {
              result = await super.execute(params);
              if (result?.response) {
                globalWafStore.capture(result.response);
              }
            }
          }
        } catch {
          // Ignore clone/text inspection errors and proceed
        }
      }

      // Check for 400 Responses API escalation
      if (result.response.status === 400) {
        try {
          const cloned = result.response.clone();
          const text = await cloned.text();
          if (
            text.includes("请改用 /v1/responses") ||
            text.includes("please use /v1/responses") ||
            text.includes("responses instead") ||
            text.includes("not support /v1/chat/completions")
          ) {
            params.log?.warn?.("AGENTROUTER", `Model ${params.model} requires /v1/responses. Escalating to Responses API...`);
            return await this.executeWithResponsesEndpoint(params);
          }
        } catch {
          // Ignore clone/text inspection errors and proceed
        }
      }
    }

    return result;
  }

  async executeWithResponsesEndpoint({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const rawBase = credentials?.providerSpecificData?.baseUrl || this.config.baseUrl || DEFAULT_BASE_URL;
    const base = cleanBaseUrl(rawBase);
    const url = `${base}/responses`;
    const transformedBody = openaiToOpenAIResponsesRequest(model, body, stream, credentials);
    const headers = this.buildHeaders(credentials, stream, url, model, transformedBody);

    log?.debug?.("AGENTROUTER", `Sending escalated request to ${url}`);

    const response = await proxyAwareFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(transformedBody),
      signal,
    }, proxyOptions);

    if (response) {
      globalWafStore.capture(response);
    }

    return {
      response,
      url,
      headers,
      transformedBody,
      responseFormat: "openai-responses",
    };
  }
}

export default AgentRouterExecutor;
