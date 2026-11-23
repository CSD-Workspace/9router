// Proxy Pools "Test" reports the address the pool actually exits from.
//
// The pool's TCP egress is what the provider sees, so a test that only checks
// "can we connect" says nothing about whether the pool masks the caller. The
// test route now also echoes the egress IP back through the pool and stores it
// so the dashboard can show it after a reload.
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/models", () => ({
  getProxyPoolById: vi.fn(),
  updateProxyPool: vi.fn(async (id, data) => ({ id, ...data })),
}));

vi.mock("@/lib/network/proxyTest", async () => {
  const actual = await vi.importActual("../../src/lib/network/proxyTest.js");
  return {
    ...actual,
    testProxyUrl: vi.fn(),
    getProxyEgressIp: vi.fn(),
    getRelayEgressIp: vi.fn(),
    getDirectEgressIp: vi.fn(),
  };
});

const { getProxyPoolById, updateProxyPool } = await import("@/models");
const proxyt = await import("@/lib/network/proxyTest.js");
const { parseEgressIp } = proxyt;
const { POST } = await import("../../src/app/api/proxy-pools/[id]/test/route.js");

const post = () => new Request("http://localhost/x", { method: "POST" });

beforeEach(() => {
  vi.clearAllMocks();
  proxyt.testProxyUrl.mockResolvedValue({ ok: true, status: 200, elapsedMs: 12 });
  proxyt.getProxyEgressIp.mockResolvedValue({ ok: true, ip: "198.51.100.9" });
  proxyt.getRelayEgressIp.mockResolvedValue({ ok: true, ip: "198.51.100.9" });
  proxyt.getDirectEgressIp.mockResolvedValue("203.0.113.77");
});

describe("parseEgressIp", () => {
  it("accepts IPv4 with surrounding whitespace", () => {
    expect(parseEgressIp("198.51.100.9\n")).toBe("198.51.100.9");
    expect(parseEgressIp("  198.51.100.9  ")).toBe("198.51.100.9");
  });

  it("rejects IPv6 — only IPv4 is reported", () => {
    expect(parseEgressIp("2001:db8::1")).toBeNull();
    expect(parseEgressIp("::1")).toBeNull();
  });

  it("rejects non-addresses instead of storing an error page", () => {
    expect(parseEgressIp("")).toBeNull();
    expect(parseEgressIp("<html>blocked</html>")).toBeNull();
    expect(parseEgressIp("999.1.1.1")).toBeNull();
    expect(parseEgressIp("not an ip")).toBeNull();
  });
});

describe("POST /api/proxy-pools/[id]/test", () => {
  it("stores the egress IP of a standard proxy pool", async () => {
    getProxyPoolById.mockResolvedValue({ id: "p1", type: "http", proxyUrl: "http://127.0.0.1:7890" });

    const res = await POST(post(), { params: Promise.resolve({ id: "p1" }) });
    const data = await res.json();

    expect(proxyt.getProxyEgressIp).toHaveBeenCalledWith({ proxyUrl: "http://127.0.0.1:7890" });
    expect(data.egressIp).toBe("198.51.100.9");
    expect(data.egressIpIsLocal).toBe(false);
    expect(updateProxyPool).toHaveBeenCalledWith("p1", expect.objectContaining({
      egressIp: "198.51.100.9",
      egressIpError: null,
      egressIpIsLocal: false,
    }));
  });

  it("uses the relay lookup for every relay pool type", async () => {
    for (const type of ["vercel", "cloudflare", "deno", "netlify"]) {
      vi.clearAllMocks();
      getProxyPoolById.mockResolvedValue({ id: "r1", type, proxyUrl: "https://relay.example/x" });
      proxyt.getRelayEgressIp.mockResolvedValue({ ok: true, ip: "198.51.100.9" });
      proxyt.getDirectEgressIp.mockResolvedValue("203.0.113.77");

      const res = await POST(post(), { params: Promise.resolve({ id: "r1" }) });
      expect(res.status).toBe(200);
      expect(proxyt.getRelayEgressIp).toHaveBeenCalledWith({ relayUrl: "https://relay.example/x" });
      expect(proxyt.getProxyEgressIp).not.toHaveBeenCalled();
    }
  });

  it("fails the test when the pool exits from this machine's own address", async () => {
    getProxyPoolById.mockResolvedValue({ id: "p2", type: "http", proxyUrl: "http://127.0.0.1:7890" });
    proxyt.getProxyEgressIp.mockResolvedValue({ ok: true, ip: "203.0.113.77" });
    proxyt.getDirectEgressIp.mockResolvedValue("203.0.113.77");

    const res = await POST(post(), { params: Promise.resolve({ id: "p2" }) });
    const data = await res.json();

    expect(data.ok).toBe(false);
    expect(data.egressIp).toBe("203.0.113.77");
    expect(data.egressIpIsLocal).toBe(true);
    expect(data.error).toMatch(/not masking/i);
    // A pool that leaks the real IP must not stay enabled.
    expect(updateProxyPool).toHaveBeenCalledWith("p2", expect.objectContaining({
      testStatus: "error",
      isActive: false,
      lastError: expect.stringMatching(/not masking/i),
    }));
  });

  it("keeps the test verdict when the IP lookup fails", async () => {
    getProxyPoolById.mockResolvedValue({ id: "p3", type: "http", proxyUrl: "http://127.0.0.1:7890" });
    proxyt.getProxyEgressIp.mockResolvedValue({ ok: false, error: "IP lookup timed out" });

    const res = await POST(post(), { params: Promise.resolve({ id: "p3" }) });
    const data = await res.json();

    expect(data.ok).toBe(true);
    expect(data.egressIp).toBeNull();
    expect(data.egressIpError).toBe("IP lookup timed out");
    expect(updateProxyPool).toHaveBeenCalledWith("p3", expect.objectContaining({
      testStatus: "active",
      egressIp: null,
      egressIpIsLocal: null,
    }));
  });

  it("does not claim same-IP when the direct lookup is unavailable", async () => {
    getProxyPoolById.mockResolvedValue({ id: "p4", type: "http", proxyUrl: "http://127.0.0.1:7890" });
    proxyt.getProxyEgressIp.mockResolvedValue({ ok: true, ip: "198.51.100.9" });
    proxyt.getDirectEgressIp.mockResolvedValue(null);

    const res = await POST(post(), { params: Promise.resolve({ id: "p4" }) });
    expect((await res.json()).egressIpIsLocal).toBe(false);
  });

  it("still reports a failed pool", async () => {
    getProxyPoolById.mockResolvedValue({ id: "p5", type: "http", proxyUrl: "http://127.0.0.1:1" });
    proxyt.testProxyUrl.mockResolvedValue({ ok: false, status: 500, error: "ECONNREFUSED" });

    const res = await POST(post(), { params: Promise.resolve({ id: "p5" }) });
    const data = await res.json();

    expect(data.ok).toBe(false);
    expect(data.error).toBe("ECONNREFUSED");
    expect(updateProxyPool).toHaveBeenCalledWith("p5", expect.objectContaining({ testStatus: "error" }));
  });
});
