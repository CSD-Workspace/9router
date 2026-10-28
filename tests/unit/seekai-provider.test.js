import { describe, it, expect } from "vitest";
import seekai from "../../open-sse/providers/registry/seekai.js";
import { PROVIDERS } from "../../open-sse/providers/index.js";
import { FREE_TIER_PROVIDERS } from "../../src/shared/constants/providers.js";
import { isValidModel } from "../../src/shared/constants/models.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";

describe("SeekAi Provider & Free Tier Integration", () => {
  it("belongs to category freeTier and has apikey auth", () => {
    expect(seekai.id).toBe("seekai");
    expect(seekai.alias).toBe("ska");
    expect(seekai.category).toBe("freeTier");
    expect(seekai.authType).toBe("apikey");
    expect(seekai.authModes).toContain("apikey");
    expect(seekai.hasFree).toBe(true);
    expect(seekai.passthroughModels).toBe(true);
    expect(seekai.modelsFetcher).toEqual({
      url: "https://seekai.cc/v1/models",
      type: "openai",
    });
  });

  it("is present in FREE_TIER_PROVIDERS with proper UI metadata", () => {
    expect(FREE_TIER_PROVIDERS.seekai).toBeDefined();
    expect(FREE_TIER_PROVIDERS.seekai.id).toBe("seekai");
    expect(FREE_TIER_PROVIDERS.seekai.alias).toBe("ska");
    expect(FREE_TIER_PROVIDERS.seekai.name).toBe("SeekAi");
    expect(FREE_TIER_PROVIDERS.seekai.website).toBe("https://seekai.cc");
    expect(FREE_TIER_PROVIDERS.seekai.hasFree).toBe(true);
    expect(FREE_TIER_PROVIDERS.seekai.passthroughModels).toBe(true);
  });

  it("populates PROVIDERS endpoint configurations", () => {
    expect(PROVIDERS.seekai).toBeDefined();
    expect(PROVIDERS.seekai.baseUrl).toBe("https://seekai.cc/v1/chat/completions");
    expect(PROVIDERS.seekai.validateUrl).toBe("https://seekai.cc/v1/models");
    expect(PROVIDERS.seekai.format).toBe("openai");
  });

  it("routes through DefaultExecutor as standard OpenAI-compatible gateway", () => {
    expect(getExecutor("seekai")).toBeInstanceOf(DefaultExecutor);
  });

  it("accepts any model via passthrough for both id and alias", () => {
    expect(isValidModel("seekai", "claude-sonnet-5")).toBe(true);
    expect(isValidModel("ska", "gpt-5.6")).toBe(true);
  });
});

