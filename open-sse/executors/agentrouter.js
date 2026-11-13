import { DefaultExecutor } from "./default.js";
import {
  getAgentRouterHeaders,
  normalizeProfile,
} from "../providers/agentrouterPolicy.js";
import { globalWafStore, isWafBlock } from "../providers/agentrouterWaf.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { openaiToOpenAIResponsesRequest } from "../translator/request/openai-responses.js";
import { normalizeResponsesTools } from "../translator/formats/responsesApi.js";
import { openaiResponsesToOpenAIResponse } from "../translator/response/openai-responses.js";
import { initState } from "../translator/index.js";
import { parseSSELine, formatSSE } from "../utils/streamHelpers.js";
import { SSE_DONE } from "../utils/sseConstants.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { reconstructStream } from "../services/emptyFailover.js";

const DEFAULT_BASE_URL = "https://agentrouter.org/v1";
const DEFAULT_RATE_LIMIT_DELAY_MS = 500;
const DEFAULT_MAX_RATE_LIMIT_RETRIES = 5;

export function isAgentRouterRateLimitError(msg) {
  if (!msg) return false;
  const str = typeof msg === "string" ? msg : JSON.stringify(msg);
  const lower = str.toLowerCase();
  return (
    lower.includes("exceeded token rate limit") ||
    lower.includes("exceeded call rate limit") ||
    lower.includes("rate limit") ||
    lower.includes("rate_limit") ||
    lower.includes("too many requests") ||
    lower.includes("too_many_requests") ||
    lower.includes("overloaded") ||
    lower.includes("capacity") ||
    lower.includes("resource has been exhausted") ||
    lower.includes("requests per minute") ||
    lower.includes("tokens per minute") ||
    lower.includes("tpm") ||
    lower.includes("rpm")
  );
}

function extractErrorFromParsedSSE(parsed, rawLine) {
  if (!parsed && !rawLine) return null;
  if (parsed) {
    const errObj = parsed.error || parsed.response?.error;
    if (errObj) {
      return typeof errObj === "string"
        ? errObj
        : errObj.message || JSON.stringify(errObj);
    }
    if (parsed.type === "response.failed" || parsed.type === "error") {
      const msg =
        parsed.response?.error?.message ||
        parsed.error?.message ||
        parsed.message;
      if (msg) return String(msg);
    }
    const content =
      parsed.choices?.[0]?.delta?.content ||
      parsed.choices?.[0]?.message?.content;
    if (typeof content === "string" && content.startsWith("[Error] ")) {
      return content.slice(8).trim();
    }
  }
  if (rawLine) {
    if (rawLine.startsWith("data: [Error] ")) {
      return rawLine.slice(14).trim();
    }
    if (
      (rawLine.includes("response.failed") || rawLine.includes('"error"')) &&
      isAgentRouterRateLimitError(rawLine)
    ) {
      return rawLine;
    }
  }
  return null;
}

function lineCarriesValidContent(parsed) {
  if (!parsed || typeof parsed !== "object") return false;
  // Responses API events carrying usable content or tool calls
  if (
    parsed.type === "response.output_text.delta" ||
    parsed.type === "response.output_text.done" ||
    parsed.type === "response.reasoning_text.delta" ||
    parsed.type === "response.reasoning_summary_text.delta" ||
    parsed.type === "response.function_call_arguments.delta" ||
    parsed.type === "response.output_item.added"
  ) {
    return true;
  }
  // Claude events
  if (
    parsed.type === "content_block_delta" ||
    parsed.type === "content_block_start"
  ) {
    const text = parsed.delta?.text || parsed.content_block?.text;
    if (typeof text === "string" && text.startsWith("[Error] ")) return false;
    return true;
  }
  // Chat completions (OpenAI)
  const delta = parsed.choices?.[0]?.delta || parsed.choices?.[0]?.message;
  if (delta) {
    if (
      typeof delta.content === "string" &&
      delta.content.length > 0 &&
      !delta.content.startsWith("[Error] ")
    ) {
      return true;
    }
    if (delta.reasoning_content || delta.reasoning) return true;
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0)
      return true;
  }
  // Gemini
  if (parsed.candidates?.[0]?.content?.parts?.length > 0) {
    return true;
  }
  return false;
}

export async function peekStreamForRateLimit(body, { timeoutMs = 8000 } = {}) {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  const headChunks = [];
  let textBuf = "";

  let timer = null;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve("__deadline__"), timeoutMs);
  });
  const settle = (ret) => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    return ret;
  };

  let pendingRead = null;
  while (true) {
    if (!pendingRead) pendingRead = reader.read();
    let res;
    try {
      res = await Promise.race([pendingRead, deadline]);
    } catch (err) {
      pendingRead = null;
      return settle({
        isRateLimit: false,
        error: err,
        head: headChunks,
        reader,
        pendingRead: null,
      });
    }

    if (res === "__deadline__") {
      // Deadline elapsed without error: fail open, treat as valid content
      return settle({
        isRateLimit: false,
        timedOut: true,
        head: headChunks,
        reader,
        pendingRead,
      });
    }

    const { done, value } = res;
    pendingRead = null;
    if (done) {
      // Stream ended
      if (textBuf) {
        const line = textBuf.trim();
        if (line) {
          const parsed = parseSSELine(line);
          const errText = extractErrorFromParsedSSE(parsed, line);
          if (errText && isAgentRouterRateLimitError(errText)) {
            return settle({
              isRateLimit: true,
              errMsg: errText,
              head: headChunks,
              reader,
              pendingRead: null,
            });
          }
        }
      }
      return settle({
        isRateLimit: false,
        head: headChunks,
        reader,
        pendingRead: null,
      });
    }

    headChunks.push(value);
    textBuf += decoder.decode(value, { stream: true });

    // Inspect complete SSE lines
    const lines = textBuf.split("\n");
    textBuf = lines.pop() || ""; // keep incomplete trailing fragment

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line === "data: [DONE]") continue;

      const parsed = parseSSELine(line);
      const errText = extractErrorFromParsedSSE(parsed, line);
      if (errText && isAgentRouterRateLimitError(errText)) {
        return settle({
          isRateLimit: true,
          errMsg: errText,
          head: headChunks,
          reader,
          pendingRead: null,
        });
      }

      // Check if line carries usable content or thinking or tool calls
      if (lineCarriesValidContent(parsed)) {
        // Legitimate model response started! Not rate limited.
        return settle({
          isRateLimit: false,
          head: headChunks,
          reader,
          pendingRead: null,
        });
      }
    }
  }
}

function cleanBaseUrl(url) {
  let base = (url || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  // Strip trailing endpoint if provided (e.g. /messages, /chat/completions, /responses, /models)
  base = base.replace(
    /\/+(messages(\?.*)?|chat\/completions|responses|models)$/i,
    "",
  );
  if (!base.endsWith("/v1")) {
    // If base doesn't end with /v1, append it
    base = `${base}/v1`;
  }
  return base;
}

export class AgentRouterExecutor extends DefaultExecutor {
  constructor(
    provider = "agentrouter",
    {
      rateLimitDelayMs = DEFAULT_RATE_LIMIT_DELAY_MS,
      maxRateLimitRetries = DEFAULT_MAX_RATE_LIMIT_RETRIES,
    } = {},
  ) {
    super(provider);
    this.provider = provider;
    this.rateLimitDelayMs = rateLimitDelayMs;
    this.maxRateLimitRetries = maxRateLimitRetries;
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

    const rawBase =
      credentials?.providerSpecificData?.baseUrl ||
      this.config.baseUrl ||
      DEFAULT_BASE_URL;
    const base = cleanBaseUrl(rawBase);

    if (this.isClaudeModel(model)) {
      return `${base}/messages?beta=true`;
    }
    if (this.isResponsesModel(model)) {
      return `${base}/responses`;
    }
    return `${base}/chat/completions`;
  }

  buildHeaders(
    credentials,
    stream = true,
    url = "",
    model = "",
    transformedBody = null,
  ) {
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
      if (
        transformed.thinking?.type === "adaptive" ||
        transformed.reasoning_effort
      ) {
        transformed.thinking = { type: "enabled" };
      }
    }

    // Handle tool normalization based on endpoint / model family
    if (Array.isArray(transformed.tools)) {
      if (this.isResponsesModel(model) || transformed.input) {
        // Responses API endpoint (/v1/responses) requires flat tool schema: { type: "function", name, parameters }
        transformed.tools = normalizeResponsesTools(transformed.tools);
      } else if (!this.isClaudeModel(model)) {
        // Chat Completions format: AgentRouter upstream uses Rust serde for tool calls, requiring type: "function"
        transformed.tools = transformed.tools
          .map((tool) => {
            if (!tool || typeof tool !== "object" || Array.isArray(tool))
              return null;
            const fn =
              tool.function &&
              typeof tool.function === "object" &&
              !Array.isArray(tool.function)
                ? tool.function
                : tool;
            const rawName = tool.name || fn.name;
            const name = typeof rawName === "string" ? rawName.trim() : "";
            if (!name) return null;
            return {
              type: "function",
              function: {
                name: name.slice(0, 128),
                description: fn.description || tool.description || "",
                parameters: fn.parameters ||
                  tool.parameters || { type: "object", properties: {} },
              },
            };
          })
          .filter(Boolean);
      }
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
        message:
          "Prompt blocked by AgentRouter keyword content filter. Please avoid placeholder phrases or test tokens.",
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
        message:
          "AgentRouter has no available channel for this model/key. Triggering fallback.",
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
      (text.includes("alicdn") ||
        text.includes("block_message") ||
        text.includes("waf.js"))
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
    if (status === 400 || status === 401 || status === 403 || status === 402) {
      return false;
    }

    return super.shouldRetry(status, urlIndex);
  }

  async dispatch(params) {
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
            params.log?.debug?.(
              "WAF",
              "Encountered WAF challenge page. Warming up cookies and retrying once...",
            );
            const rawBase =
              params.credentials?.providerSpecificData?.baseUrl ||
              this.config.baseUrl ||
              DEFAULT_BASE_URL;
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
            params.log?.warn?.(
              "AGENTROUTER",
              `Model ${params.model} requires /v1/responses. Escalating to Responses API...`,
            );
            return await this.executeWithResponsesEndpoint(params);
          }
        } catch {
          // Ignore clone/text inspection errors and proceed
        }
      }
    }

    return result;
  }

  async execute(params) {
    const rawBase =
      params.credentials?.providerSpecificData?.baseUrl ||
      this.config.baseUrl ||
      DEFAULT_BASE_URL;

    // Warmup WAF session cookies if store is empty
    if (!globalWafStore.get()) {
      await globalWafStore.warmup(rawBase);
    }

    const maxRetries = this.maxRateLimitRetries;
    const retryDelayMs = this.rateLimitDelayMs;
    let lastRateLimitMsg = null;
    let lastResult = null;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      if (params.signal?.aborted) {
        const abortErr = new Error("Request aborted by client");
        abortErr.name = "AbortError";
        throw abortErr;
      }

      let result = await this.dispatch(params);
      lastResult = result;

      if (result?.response) {
        let isRateLimit = false;
        let rateLimitMsg = "";

        if (result.response.status === 429) {
          isRateLimit = true;
          try {
            const cloned = result.response.clone();
            rateLimitMsg = await cloned.text();
          } catch {
            rateLimitMsg = "HTTP 429 Rate Limit";
          }
        } else if (result.response.ok) {
          const ct = (
            result.response.headers.get("content-type") || ""
          ).toLowerCase();
          if (ct.includes("text/event-stream") || params.stream) {
            const peeked = await peekStreamForRateLimit(result.response.body);
            if (peeked.isRateLimit) {
              isRateLimit = true;
              rateLimitMsg = peeked.errMsg || "Stream token rate limit";
              try {
                await peeked.reader.cancel();
              } catch {}
            } else {
              // Healthy stream: reconstruct stream so zero bytes/chunks are dropped
              result.response = new Response(
                reconstructStream(
                  peeked.head,
                  peeked.reader,
                  peeked.pendingRead,
                ),
                {
                  status: result.response.status,
                  statusText: result.response.statusText,
                  headers: result.response.headers,
                },
              );
              return result;
            }
          } else if (ct.includes("application/json")) {
            try {
              const cloned = result.response.clone();
              const json = await cloned.json();
              const err = json?.error?.message || json?.error || json?.message;
              if (isAgentRouterRateLimitError(err)) {
                isRateLimit = true;
                rateLimitMsg =
                  typeof err === "string" ? err : JSON.stringify(err);
              }
            } catch {}
            if (!isRateLimit) return result;
          } else {
            return result;
          }
        } else {
          // Non-200 non-429 error
          try {
            const cloned = result.response.clone();
            const text = await cloned.text();
            if (isAgentRouterRateLimitError(text)) {
              isRateLimit = true;
              rateLimitMsg = text;
            }
          } catch {}
          if (!isRateLimit) return result;
        }

        if (isRateLimit) {
          lastRateLimitMsg = rateLimitMsg;
          if (attempt <= maxRetries && !params.signal?.aborted) {
            const cleanMsg =
              typeof rateLimitMsg === "string"
                ? rateLimitMsg.slice(0, 150)
                : "";
            params.log?.warn?.(
              "AGENTROUTER",
              `[RATE_LIMIT] ${params.model}: Rate limit detected ("${cleanMsg}"). Retrying in ${retryDelayMs / 1000}s (attempt ${attempt}/${maxRetries})...`,
            );
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
            continue;
          }
        }
      } else {
        return result;
      }
    }

    if (lastRateLimitMsg) {
      params.log?.error?.(
        "AGENTROUTER",
        `[RATE_LIMIT] ${params.model}: Rate limit persisted after ${maxRetries} retries ("${lastRateLimitMsg}").`,
      );
      return {
        response: new Response(
          JSON.stringify({
            error: {
              message: lastRateLimitMsg,
              type: "rate_limit_error",
              code: 429,
            },
          }),
          {
            status: 429,
            headers: { "Content-Type": "application/json" },
          },
        ),
        url: lastResult?.url,
        headers: lastResult?.headers,
        transformedBody: lastResult?.transformedBody,
        responseFormat: lastResult?.responseFormat,
      };
    }

    return lastResult;
  }

  async executeWithResponsesEndpoint({
    model,
    body,
    stream,
    credentials,
    signal,
    log,
    proxyOptions = null,
  }) {
    const rawBase =
      credentials?.providerSpecificData?.baseUrl ||
      this.config.baseUrl ||
      DEFAULT_BASE_URL;
    const base = cleanBaseUrl(rawBase);
    const url = `${base}/responses`;
    const transformedBody = openaiToOpenAIResponsesRequest(
      model,
      body,
      stream,
      credentials,
    );
    const headers = this.buildHeaders(
      credentials,
      stream,
      url,
      model,
      transformedBody,
    );

    log?.debug?.("AGENTROUTER", `Sending escalated request to ${url}`);

    const response = await proxyAwareFetch(
      url,
      {
        method: "POST",
        headers,
        body: JSON.stringify(transformedBody),
        signal,
      },
      proxyOptions,
    );

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
