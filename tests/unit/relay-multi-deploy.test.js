// Creating several relays in one submit.
//
// Naming: one relay keeps the plain base name (matches what the form shows and
// what earlier releases created); several get -1..-N.
//
// Reusing a name replaces that relay. Cloudflare answers a PUT for an existing
// script by overwriting it, which is how you refresh a deployed relay's code
// after a fix, so the route does not block it.
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/models", () => ({
  createProxyPool: vi.fn(async (data) => ({ id: "p1", ...data })),
  getProxyPoolById: vi.fn(),
}));

const { POST: cloudflareDeploy } = await import(
  "../../src/app/api/proxy-pools/cloudflare-deploy/route.js"
);

function deployRequest(body) {
  return new Request("http://localhost/api/proxy-pools/cloudflare-deploy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const CREDENTIALS = { accountId: "acct", apiToken: "tok" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Cloudflare deploy", () => {
  it("uploads the worker even when the name already exists", async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method });
      if (init.method === "GET" && String(url).endsWith("/workers/subdomain")) {
        return { ok: true, status: 200, json: async () => ({ result: { subdomain: "acct" } }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    const res = await cloudflareDeploy(deployRequest({ ...CREDENTIALS, projectName: "relay-1" }));

    expect(res.status).toBe(201);
    // Straight to the upload: no existence probe, no 409.
    expect(calls.some((c) => c.method === "PUT")).toBe(true);
    expect(calls.some((c) => c.method === "GET" && c.url.includes("/workers/scripts/"))).toBe(false);
  });

  it("reports the deploy URL for the submitted name", async () => {
    globalThis.fetch = vi.fn(async (url, init = {}) => {
      const u = String(url);
      if (init.method === "GET" && u.endsWith("/workers/subdomain")) {
        return { ok: true, status: 200, json: async () => ({ result: { subdomain: "acct" } }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    const res = await cloudflareDeploy(deployRequest({ ...CREDENTIALS, projectName: "relay-2" }));
    expect((await res.json()).deployUrl).toBe("https://relay-2.acct.workers.dev");
  });
});
