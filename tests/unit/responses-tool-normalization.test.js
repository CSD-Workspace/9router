import { describe, it, expect, vi } from "vitest";
import "../translator/registerAll.js";
import {
  normalizeResponsesTools,
  normalizeResponsesToolChoice,
  normalizeToolParameters,
  RESPONSES_HOSTED_TOOL_TYPES
} from "../../open-sse/translator/formats/responsesApi.js";
import { openaiToOpenAIResponsesRequest } from "../../open-sse/translator/request/openai-responses.js";
import { AgentRouterExecutor } from "../../open-sse/executors/agentrouter.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

describe("OpenAI Responses Tool Normalization", () => {
  // -------------------------------------------------------------
  // Group 1: Native Responses API Requests
  // -------------------------------------------------------------
  describe("Group 1: Native Responses API requests", () => {
    it("preserves valid flat Responses function declarations without re-wrapping", () => {
      const input = [
        {
          type: "function",
          name: "get_weather",
          description: "Get the current weather",
          parameters: {
            type: "object",
            properties: {
              location: { type: "string" },
            },
            required: ["location"],
          },
          strict: true,
        },
      ];

      const normalized = normalizeResponsesTools(input);
      expect(normalized).toHaveLength(1);
      expect(normalized[0]).toEqual({
        type: "function",
        name: "get_weather",
        description: "Get the current weather",
        parameters: {
          type: "object",
          properties: {
            location: { type: "string" },
          },
          required: ["location"],
        },
        strict: true,
      });
      // Crucial: top-level name exists, NO nested function object
      expect(normalized[0].name).toBe("get_weather");
      expect(normalized[0].function).toBeUndefined();
    });

    it("does not mutate the original input array or tool objects", () => {
      const originalTool = {
        type: "function",
        name: "calculator",
        description: "Calculate math",
        parameters: { type: "object", properties: {} },
      };
      const input = [originalTool];

      const normalized = normalizeResponsesTools(input);
      expect(normalized).not.toBe(input);
      expect(normalized[0]).not.toBe(originalTool);
      expect(originalTool.name).toBe("calculator");
    });
  });

  // -------------------------------------------------------------
  // Group 2: Missing Function Name Handling
  // -------------------------------------------------------------
  describe("Group 2: Missing function name handling", () => {
    it("safely drops function tools missing top-level name and function.name", () => {
      const input = [
        { type: "function", description: "No name anywhere" },
        { type: "function", name: "", description: "Empty name" },
        { type: "function", name: "   ", description: "Whitespace name" },
        { type: "function", function: { description: "Nested but no name" } },
        { type: "function", function: { name: "" } },
        { type: "function", function: { name: "   " } },
      ];

      const normalized = normalizeResponsesTools(input);
      expect(normalized).toEqual([]);
    });

    it("emits diagnostic warnings when invalid tools are encountered", () => {
      const warnMock = vi.fn();
      const mockLog = { warn: warnMock };

      const input = [
        { type: "function", description: "malformed tool" },
      ];

      const normalized = normalizeResponsesTools(input, { log: mockLog });
      expect(normalized).toEqual([]);
      expect(warnMock).toHaveBeenCalled();
      expect(warnMock.mock.calls[0][1]).toContain("missing required 'name'");
    });
  });

  // -------------------------------------------------------------
  // Group 3: Chat Completions Function Conversion
  // -------------------------------------------------------------
  describe("Group 3: Chat Completions function conversion", () => {
    it("converts standard Chat Completions { type: 'function', function: { name, ... } } to Responses flat format", () => {
      const input = [
        {
          type: "function",
          function: {
            name: "fetch_document",
            description: "Fetches a document by ID",
            parameters: {
              type: "object",
              properties: {
                id: { type: "string" },
              },
              required: ["id"],
            },
            strict: true,
          },
        },
      ];

      const normalized = normalizeResponsesTools(input);
      expect(normalized).toHaveLength(1);
      expect(normalized[0]).toEqual({
        type: "function",
        name: "fetch_document",
        description: "Fetches a document by ID",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
          required: ["id"],
        },
        strict: true,
      });
      expect(normalized[0].function).toBeUndefined();
    });

    it("handles untyped tools with nested function or top-level name", () => {
      const input = [
        {
          name: "untyped_top_level",
          description: "No type field provided",
          parameters: { type: "object" },
        },
        {
          function: {
            name: "untyped_nested_function",
            description: "Nested function without outer type",
            parameters: { type: "object" },
          },
        },
      ];

      const normalized = normalizeResponsesTools(input);
      expect(normalized).toHaveLength(2);
      expect(normalized[0].type).toBe("function");
      expect(normalized[0].name).toBe("untyped_top_level");
      expect(normalized[1].type).toBe("function");
      expect(normalized[1].name).toBe("untyped_nested_function");
    });
  });

  // -------------------------------------------------------------
  // Group 4: Mixed Valid and Invalid Tools
  // -------------------------------------------------------------
  describe("Group 4: Mixed valid and invalid tools", () => {
    it("filters out invalid tools while preserving valid tools in original order", () => {
      const input = [
        { type: "function", name: "tool_1" },
        null,
        { type: "function" }, // invalid: no name
        "invalid_string_tool",
        {
          type: "function",
          function: { name: "tool_2", description: "Chat completions format" },
        },
        undefined,
        { type: "custom", name: "tool_3" },
        {}, // empty object
        { type: "web_search" },
      ];

      const normalized = normalizeResponsesTools(input);
      expect(normalized).toHaveLength(4);
      expect(normalized[0].name).toBe("tool_1");
      expect(normalized[1].name).toBe("tool_2");
      expect(normalized[2].name).toBe("tool_3");
      expect(normalized[3].type).toBe("web_search");
    });
  });

  // -------------------------------------------------------------
  // Group 5: Custom Tools
  // -------------------------------------------------------------
  describe("Group 5: Custom tools", () => {
    it("preserves custom tool declarations with format specification", () => {
      const input = [
        {
          type: "custom",
          name: "bash_evaluator",
          description: "Execute bash command",
          format: {
            type: "grammar",
            syntax: "bash",
          },
        },
      ];

      const normalized = normalizeResponsesTools(input);
      expect(normalized).toHaveLength(1);
      expect(normalized[0]).toEqual({
        type: "custom",
        name: "bash_evaluator",
        description: "Execute bash command",
        format: {
          type: "grammar",
          syntax: "bash",
        },
      });
    });

    it("drops custom tools that lack a name", () => {
      const input = [
        { type: "custom", description: "No name custom tool" },
      ];

      const normalized = normalizeResponsesTools(input);
      expect(normalized).toEqual([]);
    });
  });

  // -------------------------------------------------------------
  // Group 6: Hosted Tools
  // -------------------------------------------------------------
  describe("Group 6: Hosted tools", () => {
    it("preserves officially supported hosted tool types without requiring name", () => {
      const hostedTypes = [
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
      ];

      const input = hostedTypes.map(type => ({ type, extraConfig: true }));
      const normalized = normalizeResponsesTools(input);

      expect(normalized).toHaveLength(hostedTypes.length);
      for (let i = 0; i < hostedTypes.length; i++) {
        expect(normalized[i].type).toBe(hostedTypes[i]);
        expect(normalized[i].extraConfig).toBe(true);
        expect(normalized[i].name).toBeUndefined(); // Hosted tools do NOT have name
      }
    });

    it("does not mutate hosted tools into function tools", () => {
      const input = [{ type: "web_search" }];
      const normalized = normalizeResponsesTools(input);
      expect(normalized[0].type).toBe("web_search");
      expect(normalized[0].function).toBeUndefined();
    });
  });

  // -------------------------------------------------------------
  // Group 7: Invalid Input Types & Parameter Normalization
  // -------------------------------------------------------------
  describe("Group 7: Invalid input types and parameter edge cases", () => {
    it("returns empty array for non-array inputs", () => {
      expect(normalizeResponsesTools(null)).toEqual([]);
      expect(normalizeResponsesTools(undefined)).toEqual([]);
      expect(normalizeResponsesTools("tools")).toEqual([]);
      expect(normalizeResponsesTools(123)).toEqual([]);
      expect(normalizeResponsesTools({})).toEqual([]);
    });

    it("truncates tool names exceeding MAX_RESPONSES_TOOL_NAME_LEN (128 chars)", () => {
      const longName = "a".repeat(200);
      const input = [{ type: "function", name: longName }];
      const normalized = normalizeResponsesTools(input);
      expect(normalized).toHaveLength(1);
      expect(normalized[0].name).toBe("a".repeat(128));
    });

    it("normalizes non-object parameters to default object schema", () => {
      expect(normalizeToolParameters(null)).toEqual({ type: "object", properties: {} });
      expect(normalizeToolParameters(undefined)).toEqual({ type: "object", properties: {} });
      expect(normalizeToolParameters("string")).toEqual({ type: "object", properties: {} });
      expect(normalizeToolParameters([1, 2, 3])).toEqual({ type: "object", properties: {} });
      expect(normalizeToolParameters({})).toEqual({ type: "object", properties: {} });
      expect(
        normalizeToolParameters({ type: "object", properties: { a: { type: "number" } } })
      ).toEqual({ type: "object", properties: { a: { type: "number" } } });
    });

    it("drops unknown tool types missing both name and supported hosted type", () => {
      const input = [
        { type: "completely_unknown_type" },
      ];
      const normalized = normalizeResponsesTools(input);
      expect(normalized).toEqual([]);
    });
  });

  // -------------------------------------------------------------
  // Group 8: Early Return Regression (openaiToOpenAIResponsesRequest)
  // -------------------------------------------------------------
  describe("Group 8: Early return regression in openaiToOpenAIResponsesRequest", () => {
    it("normalizes tools when request body already has input (fixing early-return bypass)", () => {
      const bodyWithInputAndCCtools = {
        input: [
          { role: "user", content: "What is the weather in Paris?" },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Weather tool",
              parameters: { type: "object", properties: { city: { type: "string" } } },
            },
          },
          {
            type: "function", // invalid: missing name
            description: "Broken tool",
          },
        ],
        tool_choice: "auto",
        max_tokens: 1000,
      };

      const out = openaiToOpenAIResponsesRequest("gpt-6.1-sol", bodyWithInputAndCCtools, true);

      expect(out.model).toBe("gpt-6.1-sol");
      expect(out.max_output_tokens).toBe(1000);
      expect(out.max_tokens).toBeUndefined();

      // Check normalized tools
      expect(out.tools).toHaveLength(1);
      expect(out.tools[0].name).toBe("get_weather");
      expect(out.tools[0].function).toBeUndefined();
      expect(out.tools[0].type).toBe("function");
    });

    it("preserves valid flat tools when converting standard messages request", () => {
      const bodyWithMessagesAndFlatTools = {
        messages: [
          { role: "user", content: "Search for 9router docs" },
        ],
        tools: [
          {
            type: "function",
            name: "search_docs",
            description: "Documentation search",
            parameters: { type: "object", properties: { q: { type: "string" } } },
            strict: true,
          },
          {
            type: "web_search",
          },
        ],
      };

      const out = openaiToOpenAIResponsesRequest("gpt-6.1-sol", bodyWithMessagesAndFlatTools, true);

      expect(out.input).toBeDefined();
      expect(out.tools).toHaveLength(2);
      expect(out.tools[0].name).toBe("search_docs");
      expect(out.tools[0].function).toBeUndefined();
      expect(out.tools[1].type).toBe("web_search");
    });

    it("normalizes Chat Completions tool_choice correctly", () => {
      const body = {
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "my_tool" } }],
        tool_choice: { type: "function", function: { name: "my_tool" } },
      };

      const out = openaiToOpenAIResponsesRequest("gpt-6.1-sol", body, true);
      expect(out.tool_choice).toEqual({ type: "function", name: "my_tool" });
    });
  });

  // -------------------------------------------------------------
  // Group 9: AgentRouter Executor Integration
  // -------------------------------------------------------------
  describe("Group 9: AgentRouter Executor integration", () => {
    const executor = new AgentRouterExecutor();

    it("preserves flat Responses tools for Responses models (gpt-6.1-sol, gpt-6-astra, gpt-5.6-sol)", () => {
      const responsesBody = {
        model: "gpt-6.1-sol",
        input: [{ role: "user", content: "hello" }],
        tools: [
          {
            type: "function",
            name: "execute_command",
            description: "Run shell command",
            parameters: { type: "object", properties: { cmd: { type: "string" } } },
          },
          {
            type: "web_search",
          },
        ],
      };

      const transformed = executor.transformRequest("gpt-6.1-sol", responsesBody);

      expect(transformed.tools).toHaveLength(2);
      // Flat Responses tool remains flat with top-level name
      expect(transformed.tools[0].name).toBe("execute_command");
      expect(transformed.tools[0].function).toBeUndefined();
      // Hosted tool remains intact
      expect(transformed.tools[1].type).toBe("web_search");
    });

    it("wraps tools into Chat Completions format for OpenAI / DeepSeek models", () => {
      const chatBody = {
        model: "deepseek-v3.2",
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            name: "execute_command",
            description: "Run shell command",
            parameters: { type: "object", properties: { cmd: { type: "string" } } },
          },
        ],
      };

      const transformed = executor.transformRequest("deepseek-v3.2", chatBody);

      expect(transformed.tools).toHaveLength(1);
      // Chat Completions format uses nested function object
      expect(transformed.tools[0].type).toBe("function");
      expect(transformed.tools[0].function.name).toBe("execute_command");
    });

    it("leaves tools untouched for Claude models on AgentRouter", () => {
      const claudeBody = {
        model: "claude-opus-4-6",
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            name: "bash",
            description: "Bash tool",
            input_schema: { type: "object" },
          },
        ],
      };

      const transformed = executor.transformRequest("claude-opus-4-6", claudeBody);
      expect(transformed.tools).toEqual(claudeBody.tools);
    });
  });

  // -------------------------------------------------------------
  // Group 10: Full Request Pipeline End-to-End Translation
  // -------------------------------------------------------------
  describe("Group 10: End-to-end request translation pipeline", () => {
    it("translates Claude request to OpenAI Responses with clean tools for gpt-6.1-sol", () => {
      const claudeRequest = {
        model: "agentrouter/gpt-6.1-sol",
        messages: [
          { role: "user", content: "What is the capital of France?" },
        ],
        tools: [
          {
            name: "get_capital",
            description: "Get capital of country",
            input_schema: {
              type: "object",
              properties: { country: { type: "string" } },
              required: ["country"],
            },
          },
        ],
      };

      const translated = translateRequest(
        FORMATS.CLAUDE,
        FORMATS.OPENAI_RESPONSES,
        "gpt-6.1-sol",
        claudeRequest,
        true,
        {},
        "agentrouter"
      );

      expect(translated).toBeDefined();
      expect(translated.model).toBe("gpt-6.1-sol");
      expect(translated.input).toBeDefined();
      expect(translated.tools).toHaveLength(1);
      // Flat Responses tool format
      expect(translated.tools[0].type).toBe("function");
      expect(translated.tools[0].name).toBe("get_capital");
      expect(translated.tools[0].function).toBeUndefined();
      expect(translated.tools[0].parameters).toBeDefined();
      expect(translated.tools[0].parameters.properties.country.type).toBe("string");
    });

    it("translates OpenAI Chat request with malformed tool to Responses with invalid tool safely dropped", () => {
      const openAIRequest = {
        model: "gpt-6.1-sol",
        messages: [{ role: "user", content: "test" }],
        tools: [
          { type: "function", function: { name: "valid_tool" } },
          { type: "function", function: { description: "no name" } },
        ],
      };

      const translated = translateRequest(
        FORMATS.OPENAI,
        FORMATS.OPENAI_RESPONSES,
        "gpt-6.1-sol",
        openAIRequest,
        true,
        {},
        "agentrouter"
      );

      expect(translated).toBeDefined();
      expect(translated.tools).toHaveLength(1);
      expect(translated.tools[0].name).toBe("valid_tool");
    });
  });
});
