// "Random" proxy mode: a connection stores the "__random__" sentinel and every
// request draws a fresh active pool.
//
// Decided with the user: a direct (no-proxy) request is never drawn, and the
// draw applies to every request path (chat, models, quota ping, STT) because it
// happens inside the shared resolver.
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/models", () => ({
  getProxyPoolById: vi.fn(),
  getProxyPools: vi.fn(),
}));

const { getProxyPoolById, getProxyPools } = await import("@/models");
const {
  resolveConnectionProxyConfig,
  randomProxyPool,
} = await import("../../src/lib/network/connectionProxy.js");

function pool(id, overrides = {}) {
  return { id, name: id, proxyUrl: `http://proxy-${id}:8080`, noProxy: "", isActive: true, strictProxy: false, ...overrides };
}

// Mirrors getProxyPools({ isActive: true }): the repo filters in SQL, so the
// mock has to apply the same filter for these cases to mean anything.
function mockActivePools(pools) {
  getProxyPools.mockImplementation(async (filter = {}) =>
    filter.isActive === undefined ? pools : pools.filter((p) => p.isActive === true));
}

beforeEach(() => {
  vi.clearAllMocks();
  getProxyPoolById.mockImplementation(async (id) => pool(id));
});

describe("randomProxyPool sentinel", () => {
  it("resolves to an active pool, never to a direct connection", async () => {
    getProxyPools.mockResolvedValue([pool("a"), pool("b"), pool("c")]);

    const cfg = await resolveConnectionProxyConfig({ proxyPoolId: randomProxyPool });

    expect("abc").toContain(cfg.proxyPoolId);
    expect(cfg.source).toBe("pool");
    expect(cfg.connectionProxyEnabled).toBe(true);
    expect(cfg.connectionProxyUrl).toContain("proxy-");
  });

  it("draws again on every call", async () => {
    getProxyPools.mockResolvedValue([pool("a"), pool("b")]);
    const seen = new Set();
    for (let i = 0; i < 40; i += 1) {
      const cfg = await resolveConnectionProxyConfig({ proxyPoolId: randomProxyPool });
      seen.add(cfg.proxyPoolId);
    }
    // Both pools must come up across 40 draws; a cached pick would show one.
    expect(seen).toEqual(new Set(["a", "b"]));
  });

  it("skips inactive pools and pools without a url", async () => {
    // getProxyPools({ isActive: true }) already filters in SQL; the mock must
    // mirror that or the case tests nothing.
    mockActivePools([
      pool("inactive", { isActive: false }),
      pool("nourl", { proxyUrl: "" }),
      pool("good"),
    ]);

    for (let i = 0; i < 10; i += 1) {
      const cfg = await resolveConnectionProxyConfig({ proxyPoolId: randomProxyPool });
      expect(cfg.proxyPoolId).toBe("good");
    }
  });

  it("falls back to a direct connection when no pool is usable", async () => {
    // No active pool to rotate through. Rather than failing every request the
    // resolver treats it as unproxied, so the provider still answers.
    mockActivePools([pool("inactive", { isActive: false })]);

    const cfg = await resolveConnectionProxyConfig({ proxyPoolId: randomProxyPool });

    expect(cfg.proxyPoolId).toBe(null);
    expect(cfg.source).toBe("none");
    expect(cfg.connectionProxyEnabled).toBe(false);
    expect(cfg.connectionProxyUrl).toBe("");
  });

  it("treats an empty pool list as direct as well", async () => {
    mockActivePools([]);

    const cfg = await resolveConnectionProxyConfig({ proxyPoolId: randomProxyPool });
    expect(cfg.source).toBe("none");
    expect(cfg.connectionProxyEnabled).toBe(false);
  });

  it("still reports strictProxy when the drawn pool is strict", async () => {
    getProxyPools.mockResolvedValue([pool("strict", { strictProxy: true })]);
    getProxyPoolById.mockResolvedValue(pool("strict", { strictProxy: true }));

    const cfg = await resolveConnectionProxyConfig({ proxyPoolId: randomProxyPool });
    expect(cfg.strictProxy).toBe(true);
  });
});

describe("fixed pool assignment is unaffected", () => {
  it("resolves the exact assigned pool without consulting the pool list", async () => {
    getProxyPools.mockResolvedValue([pool("a"), pool("b")]);

    const cfg = await resolveConnectionProxyConfig({ proxyPoolId: "b" });

    expect(cfg.proxyPoolId).toBe("b");
    expect(getProxyPools).not.toHaveBeenCalled();
  });

  it("treats a missing pool url as no proxy", async () => {
    getProxyPoolById.mockResolvedValue({ id: "x", isActive: true, proxyUrl: "" });
    const cfg = await resolveConnectionProxyConfig({ proxyPoolId: "x" });
    expect(cfg.proxyPoolId).toBe("x");
    expect(cfg.connectionProxyEnabled).toBe(false);
  });
});
