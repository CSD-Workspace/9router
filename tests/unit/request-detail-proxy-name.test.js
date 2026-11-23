// Request Log shows which proxy carried each request.
//
// The name is captured at credential resolution (where the pool is picked, so
// "Random" resolves to the pool actually used) and carried onto the request
// detail. Direct requests report null and the UI renders "Direct".
import { describe, expect, it } from "vitest";
import { buildRequestDetail } from "../../open-sse/handlers/chatCore/requestDetail.js";

describe("buildRequestDetail proxyName", () => {
  const base = {
    provider: "openai",
    model: "gpt-4o",
    connectionId: "conn-1",
    request: {},
  };

  it("records the pool name when a proxy carried the request", () => {
    const detail = buildRequestDetail({ ...base, proxyName: "Cloudflare Relay" });
    expect(detail.proxyName).toBe("Cloudflare Relay");
  });

  it("records null for a direct request", () => {
    const detail = buildRequestDetail(base);
    expect(detail.proxyName).toBeNull();
  });

  it("keeps the name through overrides passed by a caller", () => {
    const detail = buildRequestDetail({ ...base, proxyName: "Pool A" }, { status: "success" });
    expect(detail.proxyName).toBe("Pool A");
    expect(detail.status).toBe("success");
  });
});
