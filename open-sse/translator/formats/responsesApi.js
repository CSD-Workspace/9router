import { ROLE, OPENAI_BLOCK, RESPONSES_ITEM } from "../schema/index.js";

/**
 * Normalize Responses API input to array format.
 * Accepts string or array, returns array of message items.
 * An empty array is treated like an empty string — providers require at least one user
 * message, so we inject a placeholder rather than forwarding an empty messages[].
 * @param {string|Array} input - raw input from Responses API body
 * @returns {Array|null} normalized array or null if invalid
 */
export function normalizeResponsesInput(input) {
  if (typeof input === "string") {
    const text = input.trim() === "" ? "..." : input;
    return [{ type: RESPONSES_ITEM.MESSAGE, role: ROLE.USER, content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text }] }];
  }
  if (Array.isArray(input)) {
    // Empty input[] would produce messages:[] which all providers reject (#389)
    if (input.length === 0) {
      return [{ type: RESPONSES_ITEM.MESSAGE, role: ROLE.USER, content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text: "..." }] }];
    }
    return input;
  }
  return null;
}

// Strict Responses upstreams reject overlong call_ids with InputValidationError (#393).
export const MAX_RESPONSES_CALL_ID_LEN = 64;

// Fallback ids share one Date.now() when a batch of items is sanitized in a tight
// loop — a per-process sequence keeps same-millisecond ids unique so
// function_call ↔ function_call_output correlation never collides.
let responsesCallIdSeq = 0;

export function clampResponsesCallId(id) {
  if (typeof id !== "string" || !id) return `call_${Date.now()}_${(responsesCallIdSeq += 1)}`;
  return id.length > MAX_RESPONSES_CALL_ID_LEN ? id.substring(0, MAX_RESPONSES_CALL_ID_LEN) : id;
}

// Single-stringify: objects → JSON once; valid JSON strings pass through untouched;
// anything else (partial fragments, empty) falls back to "{}" instead of
// double-encoding and tripping upstream InputValidationError.
export function coerceResponsesArguments(value) {
  if (value === undefined || value === null || value === "") return "{}";
  if (typeof value !== "string") {
    try {
      return JSON.stringify(value);
    } catch {
      return "{}";
    }
  }
  try {
    JSON.parse(value);
    return value;
  } catch {
    return "{}";
  }
}

// function_call_output.output must be a string — never null/object.
export function coerceResponsesOutput(value) {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) {
    return value.map((c) => {
      try {
        return c?.text ?? JSON.stringify(c);
      } catch {
        return String(c);
      }
    }).join("");
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Convert OpenAI Responses API format to standard chat completions format
 * Responses API uses: { input: [...], instructions: "..." }
 * Chat API uses: { messages: [...] }
 */
export function convertResponsesApiFormat(body) {
  if (!body.input) return body;

  const result = { ...body };
  result.messages = [];

  // Convert instructions to system message
  if (body.instructions) {
    result.messages.push({ role: ROLE.SYSTEM, content: body.instructions });
  }

  // Group items by conversation turn
  let currentAssistantMsg = null;
  let pendingToolCalls = [];
  let pendingToolResults = [];

  const inputItems = normalizeResponsesInput(body.input);
  if (!inputItems) return body;

  for (const item of inputItems) {
    // Determine item type - Droid CLI sends role-based items without 'type' field
    // Fallback: if no type but has role property, treat as message
    const itemType = item.type || (item.role ? RESPONSES_ITEM.MESSAGE : null);

    if (itemType === RESPONSES_ITEM.MESSAGE) {
      // Flush any pending assistant message with tool calls
      if (currentAssistantMsg) {
        result.messages.push(currentAssistantMsg);
        currentAssistantMsg = null;
      }
      // Flush pending tool results
      if (pendingToolResults.length > 0) {
        for (const tr of pendingToolResults) {
          result.messages.push(tr);
        }
        pendingToolResults = [];
      }

      // Convert content: input_text → text, output_text → text, input_image → image_url
      const content = Array.isArray(item.content)
        ? item.content.map(c => {
          if (c.type === RESPONSES_ITEM.INPUT_TEXT) return { type: OPENAI_BLOCK.TEXT, text: c.text };
          if (c.type === RESPONSES_ITEM.OUTPUT_TEXT) return { type: OPENAI_BLOCK.TEXT, text: c.text };
          if (c.type === RESPONSES_ITEM.INPUT_IMAGE) {
            const url = c.image_url || c.file_id || "";
            return { type: OPENAI_BLOCK.IMAGE_URL, image_url: { url, detail: c.detail || "auto" } };
          }
          return c;
        })
        : item.content;
      result.messages.push({ role: item.role, content });
    }
    else if (itemType === RESPONSES_ITEM.FUNCTION_CALL) {
      // Start or append to assistant message with tool_calls
      if (!currentAssistantMsg) {
        currentAssistantMsg = {
          role: ROLE.ASSISTANT,
          content: null,
          tool_calls: []
        };
      }
      // Skip items with empty/missing name — upstream APIs reject nameless tool calls (#444)
      if (!item.name || typeof item.name !== "string" || item.name.trim() === "") continue;
      currentAssistantMsg.tool_calls.push({
        id: item.call_id,
        type: OPENAI_BLOCK.FUNCTION,
        function: {
          name: item.name,
          arguments: item.arguments
        }
      });
    }
    else if (itemType === RESPONSES_ITEM.FUNCTION_CALL_OUTPUT) {
      // Flush assistant message first if exists
      if (currentAssistantMsg) {
        result.messages.push(currentAssistantMsg);
        currentAssistantMsg = null;
      }
      // Add tool result
      pendingToolResults.push({
        role: ROLE.TOOL,
        tool_call_id: item.call_id,
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output)
      });
    }
    else if (itemType === RESPONSES_ITEM.REASONING) {
      // Skip reasoning items - they are for display only
      continue;
    }
  }

  // Flush remaining
  if (currentAssistantMsg) {
    result.messages.push(currentAssistantMsg);
  }
  if (pendingToolResults.length > 0) {
    for (const tr of pendingToolResults) {
      result.messages.push(tr);
    }
  }

  // Cleanup Responses API specific fields
  delete result.input;
  delete result.instructions;
  delete result.include;
  delete result.prompt_cache_key;
  delete result.store;
  delete result.reasoning;

  return result;
}

export const MAX_RESPONSES_TOOL_NAME_LEN = 128;

// Hosted tool types that Responses API executes server-side without requiring a name
export const RESPONSES_HOSTED_TOOL_TYPES = new Set([
  "web_search",
  "web_search_preview",
  "file_search",
  "computer",
  "computer_use_preview",
  "code_interpreter",
  "image_generation",
  "local_shell",
  "mcp",
  "tool_search",
  "request_user_input",
]);

// Freeform custom tool types that require a name
export const RESPONSES_PASSTHROUGH_TOOL_TYPES = new Set([
  "custom",
]);

/**
 * Ensure object schema always has properties field (required by Codex / Responses API)
 */
export function normalizeToolParameters(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return { type: "object", properties: {} };
  }
  if (params.type === "object" && !params.properties) {
    return { ...params, properties: {} };
  }
  if (!params.type && Object.keys(params).length === 0) {
    return { type: "object", properties: {} };
  }
  return params;
}

/**
 * Normalize an array of tool declarations into standard OpenAI Responses API format.
 *
 * Responses API expects flat tool declarations:
 * - function: { type: "function", name: string, description?: string, parameters: object, strict?: boolean }
 * - custom:   { type: "custom", name: string, description?: string, format?: object }
 * - hosted:   { type: "web_search" | ... } (name not required)
 *
 * Handles Chat Completions format ({ type: "function", function: { name, ... } }),
 * preserves already valid Responses API declarations, preserves hosted and custom tools,
 * filters malformed declarations, and produces diagnostic output.
 *
 * @param {Array} tools - raw tools array
 * @param {Object} [options]
 * @param {Array} [options.diagnostics] - optional array to collect diagnostic objects
 * @param {Object} [options.log] - optional logger instance
 * @returns {Array|undefined} normalized tools array, or undefined if input was null/undefined
 */
export function normalizeResponsesTools(tools, options = {}) {
  if (tools === null || tools === undefined) {
    return options.preserveNullOrUndefined ? tools : [];
  }
  if (!Array.isArray(tools)) {
    const reason = `Expected tools to be an array, got ${typeof tools}`;
    options.diagnostics?.push({ index: -1, type: typeof tools, reason });
    options.log?.warn?.("TOOL_VALIDATION", reason);
    return [];
  }
  if (tools.length === 0) return [];

  const diagnostics = options.diagnostics;
  const log = options.log;
  const result = [];

  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i];

    // Must be a non-null object and not an array
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
      const reason = `Tool declaration at index ${i} is not a valid object (${tool === null ? "null" : typeof tool})`;
      diagnostics?.push({ index: i, type: null, reason });
      log?.warn?.("TOOL_VALIDATION", `Dropped invalid tool: ${reason}`);
      continue;
    }

    const type = typeof tool.type === "string" ? tool.type.trim() : "";

    // 1. Hosted tools: native structure preserved without requiring name
    if (type && RESPONSES_HOSTED_TOOL_TYPES.has(type)) {
      result.push({ ...tool });
      continue;
    }

    // 2. Custom tools: Responses-native freeform tools require a non-empty name
    if (type === "custom") {
      const rawName = typeof tool.name === "string" ? tool.name : "";
      const name = rawName.trim();
      if (!name) {
        const reason = `Custom tool at index ${i} is missing required 'name'`;
        diagnostics?.push({ index: i, type: "custom", reason });
        log?.warn?.("TOOL_VALIDATION", `Dropped invalid tool: ${reason}`);
        continue;
      }
      result.push({
        ...tool,
        name: name.slice(0, MAX_RESPONSES_TOOL_NAME_LEN),
      });
      continue;
    }

    // 3. Namespace tools (e.g. Codex)
    if (type === "namespace") {
      result.push({ ...tool });
      continue;
    }

    // 4. Function tools: resolve function.name or top-level name
    const fn = tool.function && typeof tool.function === "object" && !Array.isArray(tool.function)
      ? tool.function
      : null;

    const rawName = typeof tool.name === "string"
      ? tool.name
      : (typeof fn?.name === "string" ? fn.name : "");
    const name = rawName.trim();

    // Check if name is missing or invalid
    if (!name) {
      const reason = `Function tool at index ${i} is missing required 'name'`;
      diagnostics?.push({ index: i, type: type || "function", reason });
      log?.warn?.("TOOL_VALIDATION", `Dropped invalid tool: ${reason}`);
      continue;
    }

    // Resolve description
    const description = typeof tool.description === "string"
      ? tool.description
      : (typeof fn?.description === "string" ? fn.description : "");

    // Resolve parameters
    const rawParams = (tool.parameters && typeof tool.parameters === "object" && !Array.isArray(tool.parameters))
      ? tool.parameters
      : (fn?.parameters && typeof fn.parameters === "object" && !Array.isArray(fn.parameters)
          ? fn.parameters
          : (tool.input_schema && typeof tool.input_schema === "object" && !Array.isArray(tool.input_schema)
              ? tool.input_schema
              : null));
    const parameters = normalizeToolParameters(rawParams);

    // Resolve strict
    const strict = typeof tool.strict === "boolean"
      ? tool.strict
      : (typeof fn?.strict === "boolean" ? fn.strict : undefined);

    const normalized = {
      type: OPENAI_BLOCK.FUNCTION,
      name: name.slice(0, MAX_RESPONSES_TOOL_NAME_LEN),
      description: String(description || ""),
      parameters,
    };

    if (strict !== undefined) {
      normalized.strict = strict;
    }

    result.push(normalized);
  }

  return result;
}

/**
 * Normalize tool_choice for OpenAI Responses API.
 * Supports "auto", "none", "required", and specific tool choice objects.
 */
export function normalizeResponsesToolChoice(choice, validToolNames = null) {
  if (choice === undefined || choice === null) return choice;
  if (typeof choice === "string") {
    return choice;
  }
  if (typeof choice === "object" && !Array.isArray(choice)) {
    const type = typeof choice.type === "string" ? choice.type.trim() : "";
    if (type === "function") {
      const rawName = choice.name ?? choice.function?.name;
      const name = typeof rawName === "string" ? rawName.trim() : "";
      if (!name) return undefined;
      if (validToolNames && !validToolNames.has(name)) return undefined;
      return { type: "function", name };
    }
    if (RESPONSES_HOSTED_TOOL_TYPES.has(type)) {
      return { ...choice };
    }
  }
  return choice;
}

