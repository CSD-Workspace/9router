// The provider connection API must accept the "__random__" sentinel.
//
// It is a mode, not a pool, so the usual "does this pool id exist?" validation
// would otherwise reject it and the dashboard's Random option could never be
// saved.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;

let tempDir;
let createConnection;
let updateConnection;
let getStoredConnection;

function request(method, url, body) {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("provider connection random proxy mode", () => {
  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-random-proxy-"));
    process.env.DATA_DIR = tempDir;
    delete global._dbAdapter;
    vi.resetModules();
    vi.doMock("next/server", () => ({
      NextResponse: {
        json(body, init = {}) {
          return new Response(JSON.stringify(body), {
            status: init.status || 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      },
    }));

    ({ POST: createConnection } = await import("@/app/api/providers/route.js"));
    ({ PUT: updateConnection } = await import("@/app/api/providers/[id]/route.js"));
    ({ getProviderConnectionById: getStoredConnection } = await import("@/models/index.js"));
  });

  afterEach(() => {
    vi.doUnmock("next/server");
    vi.resetModules();
    global._dbAdapter?.instance?.close?.();
    delete global._dbAdapter;
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  async function createApiKeyConnection() {
    const res = await createConnection(request("POST", "https://9router.local/api/providers", {
      provider: "openai",
      name: "random proxy test",
      apiKey: "sk-test",
    }));
    expect(res.status).toBe(201);
    return (await res.json()).connection.id;
  }

  it("stores the sentinel instead of rejecting an unknown pool id", async () => {
    const id = await createApiKeyConnection();

    const res = await updateConnection(
      request("PUT", `https://9router.local/api/providers/${id}`, { proxyPoolId: "__random__" }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(200);

    const stored = await getStoredConnection(id);
    expect(stored.providerSpecificData.proxyPoolId).toBe("__random__");
  });

  it("still rejects a genuinely unknown pool id", async () => {
    const id = await createApiKeyConnection();

    const res = await updateConnection(
      request("PUT", `https://9router.local/api/providers/${id}`, { proxyPoolId: "no-such-pool" }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not found/i);
  });

  it("clears the assignment with null", async () => {
    const id = await createApiKeyConnection();
    await updateConnection(
      request("PUT", `https://9router.local/api/providers/${id}`, { proxyPoolId: "__random__" }),
      { params: Promise.resolve({ id }) },
    );

    await updateConnection(
      request("PUT", `https://9router.local/api/providers/${id}`, { proxyPoolId: null }),
      { params: Promise.resolve({ id }) },
    );

    const stored = await getStoredConnection(id);
    expect(stored.providerSpecificData.proxyPoolId).toBeUndefined();
  });
});

describe("creating a connection with random mode", () => {
  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-random-proxy-create-"));
    process.env.DATA_DIR = tempDir;
    delete global._dbAdapter;
    vi.resetModules();
    vi.doMock("next/server", () => ({
      NextResponse: {
        json(body, init = {}) {
          return new Response(JSON.stringify(body), {
            status: init.status || 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      },
    }));
    ({ POST: createConnection } = await import("@/app/api/providers/route.js"));
    ({ getProviderConnectionById: getStoredConnection } = await import("@/models/index.js"));
  });

  afterEach(() => {
    vi.doUnmock("next/server");
    vi.resetModules();
    global._dbAdapter?.instance?.close?.();
    delete global._dbAdapter;
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("accepts the sentinel at creation time", async () => {
    const res = await createConnection(request("POST", "https://9router.local/api/providers", {
      provider: "openai",
      name: "created with random",
      apiKey: "sk-test",
      proxyPoolId: "__random__",
    }));
    expect(res.status).toBe(201);
    const { connection } = await res.json();
    const stored = await getStoredConnection(connection.id);
    expect(stored.providerSpecificData.proxyPoolId).toBe("__random__");
  });

  it("still rejects an unknown pool id at creation time", async () => {
    const res = await createConnection(request("POST", "https://9router.local/api/providers", {
      provider: "openai",
      name: "created with bad pool",
      apiKey: "sk-test",
      proxyPoolId: "no-such-pool",
    }));
    expect(res.status).toBe(400);
  });
});
