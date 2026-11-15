import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { HEADER_PRESETS } from "../../src/shared/constants/headerPresets.js";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let adapter;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-clear-logs-test-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  await db.updateSettings({ enableObservability: true, observabilityBatchSize: 1 });

  const { getAdapter } = await import("@/lib/db/driver.js");
  adapter = await getAdapter();
});

afterAll(() => {
  if (tempDir) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("Custom Header Presets", () => {
  it("exports valid HEADER_PRESETS with expected spoofing profiles", () => {
    expect(Array.isArray(HEADER_PRESETS)).toBe(true);
    expect(HEADER_PRESETS.length).toBeGreaterThanOrEqual(8);

    const ids = HEADER_PRESETS.map((p) => p.id);
    expect(ids).toContain("claude-code");
    expect(ids).toContain("opencode");
    expect(ids).toContain("cursor");
    expect(ids).toContain("codex");
    expect(ids).toContain("cline");
    expect(ids).toContain("roo-code");
    expect(ids).toContain("copilot");
    expect(ids).toContain("generic");

    for (const preset of HEADER_PRESETS) {
      expect(typeof preset.id).toBe("string");
      expect(typeof preset.name).toBe("string");
      expect(typeof preset.description).toBe("string");
      expect(typeof preset.headers).toBe("object");
      expect(Object.keys(preset.headers).length).toBeGreaterThan(0);

      // Verify no blocked headers are included in presets
      const blocked = ["host", "content-length", "content-type", "connection", "transfer-encoding", "authorization", "cookie"];
      for (const h of Object.keys(preset.headers)) {
        expect(blocked.includes(h.toLowerCase())).toBe(false);
      }
    }
  });

  it("claude-code preset includes standard anthropic direct access headers", () => {
    const claudePreset = HEADER_PRESETS.find((p) => p.id === "claude-code");
    expect(claudePreset).toBeDefined();
    expect(claudePreset.headers["User-Agent"]).toContain("claude-cli");
    expect(claudePreset.headers["X-App"]).toBe("cli");
    expect(claudePreset.headers["Anthropic-Dangerous-Direct-Browser-Access"]).toBe("true");
  });

  it("opencode preset includes opencode user agent", () => {
    const opencode = HEADER_PRESETS.find((p) => p.id === "opencode");
    expect(opencode).toBeDefined();
    expect(opencode.headers["User-Agent"]).toBe("opencode/1.18.25");
  });
});

describe("Clear Logs Enhancement (wipes requestDetails AND usage/analytics)", () => {
  it("clearUsageData wipes usageHistory, usageDaily, resets lifetime counter and ring", async () => {
    // Seed some usage data
    await db.saveRequestUsage({
      provider: "openai",
      model: "gpt-4o",
      tokens: { prompt_tokens: 100, completion_tokens: 50 },
      timestamp: new Date().toISOString(),
      endpoint: "/v1/chat/completions",
    });

    await db.saveRequestUsage({
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      tokens: { prompt_tokens: 200, completion_tokens: 100 },
      timestamp: new Date().toISOString(),
      endpoint: "/v1/messages",
    });

    const statsBefore = await db.getUsageStats("all");
    expect(statsBefore.totalRequests).toBeGreaterThanOrEqual(2);
    expect(statsBefore.totalPromptTokens).toBeGreaterThanOrEqual(300);

    // Call clearUsageData
    const res = await db.clearUsageData();
    expect(res.deletedHistory).toBeGreaterThanOrEqual(2);

    // Check DB tables are completely empty
    const histRows = adapter.all("SELECT * FROM usageHistory");
    expect(histRows.length).toBe(0);

    const dailyRows = adapter.all("SELECT * FROM usageDaily");
    expect(dailyRows.length).toBe(0);

    const meta = adapter.get("SELECT value FROM _meta WHERE key = 'totalRequestsLifetime'");
    expect(meta?.value).toBe("0");

    // Check getUsageStats returns zeroed metrics
    const statsAfter = await db.getUsageStats("all");
    expect(statsAfter.totalRequests).toBe(0);
    expect(statsAfter.totalPromptTokens).toBe(0);
    expect(statsAfter.totalCompletionTokens).toBe(0);
    expect(statsAfter.recentRequests.length).toBe(0);
  });

  it("clearRequestDetails clears requestDetails AND usage data atomically", async () => {
    // Seed request details and usage
    await db.saveRequestDetail({
      id: "req-detail-1",
      provider: "openai",
      model: "gpt-4o",
      status: "success",
      timestamp: new Date().toISOString(),
      tokens: { prompt_tokens: 50, completion_tokens: 25 },
    });
    // Wait small tick for buffer flush
    await new Promise((r) => setTimeout(r, 60));

    await db.saveRequestUsage({
      provider: "openai",
      model: "gpt-4o",
      tokens: { prompt_tokens: 50, completion_tokens: 25 },
      timestamp: new Date().toISOString(),
      endpoint: "/v1/chat/completions",
    });

    const detailsBefore = await db.getRequestDetails({});
    expect(detailsBefore.details.length).toBeGreaterThan(0);

    const statsBefore = await db.getUsageStats("all");
    expect(statsBefore.totalRequests).toBeGreaterThan(0);

    // Clear via clearRequestDetails()
    await db.clearRequestDetails();

    const detailsAfter = await db.getRequestDetails({});
    expect(detailsAfter.details.length).toBe(0);

    const statsAfter = await db.getUsageStats("all");
    expect(statsAfter.totalRequests).toBe(0);
    expect(statsAfter.totalPromptTokens).toBe(0);
  });

  it("DELETE /api/usage/request-details clears both logs and usage data", async () => {
    const { DELETE } = await import("@/app/api/usage/request-details/route.js");

    // Seed data
    await db.saveRequestDetail({
      id: "req-detail-api-1",
      provider: "anthropic",
      model: "claude-3-opus",
      status: "success",
      timestamp: new Date().toISOString(),
      tokens: { prompt_tokens: 150, completion_tokens: 80 },
    });
    await new Promise((r) => setTimeout(r, 60));

    await db.saveRequestUsage({
      provider: "anthropic",
      model: "claude-3-opus",
      tokens: { prompt_tokens: 150, completion_tokens: 80 },
      timestamp: new Date().toISOString(),
      endpoint: "/v1/messages",
    });

    const req = new Request("http://localhost/api/usage/request-details", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "all" }),
    });

    const res = await DELETE(req);
    const body = await res.json();
    expect(body.success).toBe(true);

    const details = await db.getRequestDetails({});
    expect(details.details.length).toBe(0);

    const stats = await db.getUsageStats("all");
    expect(stats.totalRequests).toBe(0);
  });

  it("deleteUsageDataBefore only wipes data older than cutoff", async () => {
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago
    const newDate = new Date().toISOString(); // now

    await db.saveRequestUsage({
      provider: "google",
      model: "gemini-2.5-pro",
      tokens: { prompt_tokens: 300, completion_tokens: 150 },
      timestamp: oldDate,
      endpoint: "/v1beta/models",
    });

    await db.saveRequestUsage({
      provider: "google",
      model: "gemini-2.5-pro",
      tokens: { prompt_tokens: 50, completion_tokens: 20 },
      timestamp: newDate,
      endpoint: "/v1beta/models",
    });

    const cutoff = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(); // 5 days ago
    await db.deleteUsageDataBefore(cutoff);

    // Old record should be gone, new record should remain
    const remaining = adapter.all("SELECT * FROM usageHistory");
    expect(remaining.length).toBe(1);
    expect(new Date(remaining[0].timestamp).getTime()).toBeGreaterThan(new Date(cutoff).getTime());
  });
});

