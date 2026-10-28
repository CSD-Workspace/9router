import { describe, it, expect } from "vitest";
import agentrouter from "../../open-sse/providers/registry/agentrouter.js";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { FREE_TIER_PROVIDERS } from "../../src/shared/constants/providers.js";
import { getModelTargetFormat, getModelSupportedFormats } from "../../open-sse/config/providerModels.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

describe("AgentRouter Registry & Free Tier Integration", () => {
  it("belongs to category freeTier and has apikey auth", () => {
    expect(agentrouter.category).toBe("freeTier");
    expect(agentrouter.authType).toBe("apikey");
    expect(agentrouter.authModes).toContain("apikey");
    expect(agentrouter.passthroughModels).toBe(true);
    expect(agentrouter.modelsFetcher).toEqual({
      url: "https://agentrouter.org/v1/models",
      type: "openai",
    });
  });

  it("is present in FREE_TIER_PROVIDERS with proper UI metadata", () => {
    expect(FREE_TIER_PROVIDERS.agentrouter).toBeDefined();
    expect(FREE_TIER_PROVIDERS.agentrouter.id).toBe("agentrouter");
    expect(FREE_TIER_PROVIDERS.agentrouter.alias).toBe("ar");
    expect(FREE_TIER_PROVIDERS.agentrouter.name).toBe("AgentRouter");
    expect(FREE_TIER_PROVIDERS.agentrouter.passthroughModels).toBe(true);
  });

  it("populates PROVIDERS and PROVIDER_MODELS", () => {
    expect(PROVIDERS.agentrouter).toBeDefined();
    expect(PROVIDER_MODELS.ar).toBeDefined();
    const modelIds = PROVIDER_MODELS.ar.map((m) => m.id);
    expect(modelIds).toEqual(["gpt-5.6-sol", "gpt-6-astra", "gpt-6.1-sol"]);
  });

  it("resolves targetFormat and supportedFormats for curated models", () => {
    expect(getModelTargetFormat("ar", "gpt-5.6-sol")).toBe(FORMATS.OPENAI_RESPONSES);
    expect(getModelSupportedFormats("ar", "gpt-5.6-sol")).toContain(FORMATS.OPENAI_RESPONSES);

    expect(getModelTargetFormat("ar", "gpt-6-astra")).toBe(FORMATS.OPENAI_RESPONSES);
    expect(getModelSupportedFormats("ar", "gpt-6-astra")).toContain(FORMATS.OPENAI_RESPONSES);

    expect(getModelTargetFormat("ar", "gpt-6.1-sol")).toBe(FORMATS.OPENAI_RESPONSES);
    expect(getModelSupportedFormats("ar", "gpt-6.1-sol")).toContain(FORMATS.OPENAI_RESPONSES);
  });

  it("resolves endpoint family for uncurated passthrough models", () => {
    // Claude passthrough model
    expect(getModelTargetFormat("ar", "claude-opus-4-6")).toBe(FORMATS.CLAUDE);
    expect(getModelSupportedFormats("ar", "claude-opus-4-6")).toContain(FORMATS.CLAUDE);
    expect(getModelTargetFormat("ar", "claude-sonnet-4-5-20251111")).toBe(FORMATS.CLAUDE);
    expect(getModelSupportedFormats("ar", "claude-sonnet-4-5-20251111")).toContain(FORMATS.CLAUDE);

    // DeepSeek / GLM / Qwen passthrough model
    expect(getModelTargetFormat("ar", "deepseek-v3.2")).toBe(FORMATS.OPENAI);
    expect(getModelSupportedFormats("ar", "deepseek-v3.2")).toContain(FORMATS.OPENAI);
    expect(getModelTargetFormat("ar", "glm-5.1")).toBe(FORMATS.OPENAI);
    expect(getModelSupportedFormats("ar", "qwen-2.5-coder-32b")).toContain(FORMATS.OPENAI);

    // GPT-5 / GPT-6 / Codex passthrough models
    expect(getModelTargetFormat("ar", "gpt-6-astra")).toBe(FORMATS.OPENAI_RESPONSES);
    expect(getModelSupportedFormats("ar", "gpt-5.6-luna")).toContain(FORMATS.OPENAI_RESPONSES);
  });
});
