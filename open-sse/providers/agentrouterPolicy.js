import {
  ANTHROPIC_API_VERSION,
  CLAUDE_CLI_VERSION,
  mapStainlessArch,
  mapStainlessOs,
  selectAnthropicBeta,
} from "./shared.js";
import { globalWafStore } from "./agentrouterWaf.js";
export { globalWafStore } from "./agentrouterWaf.js";

export const SUPPORTED_PROFILES = [
  "opencode",
  "claude-code",
  "codex",
  "qwen",
  "cline",
  "roo",
  "kilo",
  "cursor",
  "trae",
  "pi",
  "openclaw",
  "hermes",
  "droid",
  "copilot",
  "gemini",
  "generic",
];

const PROFILE_ALIASES = {
  claude: "claude-code",
  "qwen-code": "qwen",
  roocode: "roo",
  "roo-code": "roo",
  kilocode: "kilo",
  "kilo-code": "kilo",
  factory: "droid",
  "factory-droid": "droid",
  "github-copilot": "copilot",
  none: "generic",
};

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function normalizeProfile(p) {
  const raw = String(p || "").toLowerCase().trim();
  if (!raw) return "opencode";
  return PROFILE_ALIASES[raw] || raw;
}

export function isValidProfile(p) {
  const norm = normalizeProfile(p);
  return SUPPORTED_PROFILES.includes(norm);
}

export function getGenericHeadersForProfile(profile) {
  const norm = normalizeProfile(profile);
  switch (norm) {
    case "opencode":
      return {
        "User-Agent": "opencode/1.18.25",
      };
    case "claude-code":
      return {
        "User-Agent": `claude-cli/${CLAUDE_CLI_VERSION} (external, sdk-cli)`,
        "X-App": "cli",
        "X-Stainless-Helper-Method": "stream",
        "X-Stainless-Retry-Count": "0",
        "X-Stainless-Runtime-Version": "v24.14.0",
        "X-Stainless-Package-Version": "0.80.0",
        "X-Stainless-Runtime": "node",
        "X-Stainless-Lang": "js",
        "X-Stainless-Arch": mapStainlessArch(),
        "X-Stainless-Os": mapStainlessOs(),
        "X-Stainless-Timeout": "600",
      };
    case "codex":
      return {
        "User-Agent": "codex-cli/0.52.0 (external, codex)",
        "X-App": "codex",
      };
    case "qwen":
      return {
        "User-Agent": "qwen-code/0.2.1 (external, qwen)",
        "X-App": "qwen-code",
      };
    case "cline":
      return {
        "User-Agent": "Cline/3.18.0 (external, cline)",
        "X-App": "cline",
      };
    case "roo":
      return {
        "User-Agent": "Roo-Code/3.20.0 (external, roo)",
        "X-App": "roo-code",
      };
    case "kilo":
      return {
        "User-Agent": "Kilo-Code/4.0.0 (external, kilo)",
        "X-App": "kilo-code",
      };
    case "cursor":
      return {
        "User-Agent": "Cursor/1.5.0 (external, cursor)",
        "X-App": "cursor",
      };
    case "trae":
      return {
        "User-Agent": "Trae/2.0.5 (external, trae)",
        "X-App": "trae",
      };
    case "pi":
      return {
        "User-Agent": "pi/0.5.0 (external, pi)",
        "X-App": "pi",
      };
    case "openclaw":
      return {
        "User-Agent": "openclaw/1.0.0 (external, openclaw)",
        "X-App": "openclaw",
      };
    case "hermes":
      return {
        "User-Agent": "hermes/1.0.0 (external, hermes)",
        "X-App": "hermes",
      };
    case "droid":
      return {
        "User-Agent": "factory-droid/0.8.0 (external, droid)",
        "X-App": "droid",
      };
    case "copilot":
      return {
        "User-Agent": "GitHubCopilotChat/0.26.0 (external, copilot)",
        "X-App": "copilot",
      };
    case "gemini":
      return {
        "User-Agent": "GeminiCLI/0.10.0 (external, gemini)",
        "X-App": "gemini",
      };
    case "generic":
      return {
        "User-Agent": "agentrouter-spoof-proxy/1.0.0",
        "X-App": "generic",
      };
    default:
      return {
        "User-Agent": "opencode/1.18.25",
      };
  }
}

export function getAnthropicHeadersForProfile(profile, model = "", body = null) {
  const norm = normalizeProfile(profile);
  if (norm === "claude-code") {
    return {
      "Anthropic-Version": ANTHROPIC_API_VERSION,
      "Anthropic-Beta": selectAnthropicBeta(model, body),
      "Anthropic-Dangerous-Direct-Browser-Access": "true",
      ...getGenericHeadersForProfile("claude-code"),
    };
  }

  const generic = getGenericHeadersForProfile(norm);
  const beta = norm === "opencode"
    ? "interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14"
    : "interleaved-thinking-2025-05-14";

  return {
    "Anthropic-Version": ANTHROPIC_API_VERSION,
    "Anthropic-Beta": beta,
    "Anthropic-Dangerous-Direct-Browser-Access": "true",
    ...generic,
  };
}

export function filterHopByHopHeaders(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      out[key] = value;
    }
  }
  return out;
}

export function getAgentRouterHeaders({
  profile = null,
  model = "",
  isClaudeEndpoint = false,
  stream = true,
  apiKey = "",
  customHeaders = null,
  body = null,
}) {
  const effectiveProfile = profile || (isClaudeEndpoint ? "claude-code" : "opencode");
  const headers = {
    "Content-Type": "application/json",
  };

  if (stream) {
    headers["Accept"] = "text/event-stream";
  }

  if (isClaudeEndpoint) {
    Object.assign(headers, getAnthropicHeadersForProfile(effectiveProfile, model, body));
    if (apiKey) {
      headers["x-api-key"] = apiKey;
    }
  } else {
    Object.assign(headers, getGenericHeadersForProfile(effectiveProfile));
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
  }

  if (customHeaders && typeof customHeaders === "object") {
    Object.assign(headers, customHeaders);
  }

  // Forward captured WAF challenge cookies (acw_tc, cdn_sec_tc, acw_sc__v2...)
  const wafCookie = globalWafStore.get();
  if (wafCookie && !headers["Cookie"] && !headers["cookie"]) {
    headers["Cookie"] = wafCookie;
  }

  return filterHopByHopHeaders(headers);
}
