// The Proxy column reads proxyName back from the database, not from the object
// that built the detail. Persistence copies an explicit allowlist of fields, so a
// field that is threaded correctly through the handlers but missing from that
// allowlist is silently dropped — every row then renders "Direct".
//
// This goes through the real DB adapter (save → flush → read) so that class of
// mistake fails here instead of in the dashboard.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;

async function loadRepo() {
  vi.resetModules();
  delete global._dbAdapter;
  // Request details are written only while observability is on. The UI setting
  // wins over the env fallback, and it defaults to off.
  const { updateSettings } = await import("@/lib/db/repos/settingsRepo.js");
  await updateSettings({ enableObservability: true, observabilityBatchSize: 1, observabilityFlushIntervalMs: 10 });
  return import("@/lib/db/repos/requestDetailsRepo.js");
}

async function persist(detail) {
  const repo = await loadRepo();
  await repo.saveRequestDetail(detail);
  // The flush is asynchronous; poll instead of sleeping for the interval.
  for (let i = 0; i < 60; i += 1) {
    const found = await repo.getRequestDetailById(detail.id);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

describe("proxyName survives request-detail persistence", () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-proxy-persist-"));
    process.env.DATA_DIR = tempDir;
  });

  afterEach(() => {
    global._dbAdapter?.instance?.close?.();
    delete global._dbAdapter;
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("stores the proxy name and reads it back", async () => {
    const stored = await persist({
      id: "detail-proxy-1",
      timestamp: new Date().toISOString(),
      provider: "openai",
      model: "gpt-4o",
      connectionId: "conn-1",
      status: "success",
      proxyName: "Cloudflare Relay",
      latency: { ttft: 10, total: 20 },
      tokens: { prompt_tokens: 1, completion_tokens: 2 },
    });

    expect(stored).not.toBeNull();
    expect(stored.proxyName).toBe("Cloudflare Relay");
  });

  it("stores null for a direct request", async () => {
    const stored = await persist({
      id: "detail-proxy-2",
      timestamp: new Date().toISOString(),
      provider: "openai",
      model: "gpt-4o",
      status: "success",
      proxyName: null,
    });

    expect(stored).not.toBeNull();
    expect(stored.proxyName ?? null).toBeNull();
  });
});
