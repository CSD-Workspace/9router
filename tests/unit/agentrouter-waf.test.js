import { describe, it, expect } from "vitest";
import {
  extractWafCookies,
  mergeWafCookies,
  isWafBlock,
  WafCookieStore,
  globalWafStore,
  WARMUP_HEADERS,
} from "../../open-sse/providers/agentrouterWaf.js";
import { getAgentRouterHeaders } from "../../open-sse/providers/agentrouterPolicy.js";

describe("AgentRouter WAF Bypass & Session Cookie Store", () => {
  it("extracts only valid WAF cookies and skips empty or irrelevant cookies", () => {
    const rawCookies = [
      "acw_tc=1a2b3c4d5e; Path=/; HttpOnly",
      "session_id=ignored_cookie; Path=/",
      "cdn_sec_tc=sec_val_999; Secure",
      "acw_sc__v2=challenge_token; Path=/",
      "acw_sc__v3=v3_token; Path=/",
      "acw_tc=; max-age=0", // cleared cookie
      "malformed-cookie-without-equals",
    ];

    const extracted = extractWafCookies(rawCookies);
    expect(extracted).toContain("acw_tc=1a2b3c4d5e");
    expect(extracted).toContain("cdn_sec_tc=sec_val_999");
    expect(extracted).toContain("acw_sc__v2=challenge_token");
    expect(extracted).toContain("acw_sc__v3=v3_token");
    expect(extracted).not.toContain("session_id=ignored_cookie");
    expect(extracted).toHaveLength(4);
  });

  it("merges cookies by name, giving precedence to fresh cookies", () => {
    const current = ["acw_tc=old_token", "cdn_sec_tc=retained_edge"];
    const fresh = ["acw_tc=fresh_token", "acw_sc__v2=new_challenge"];

    const merged = mergeWafCookies(current, fresh);
    expect(merged).toContain("acw_tc=fresh_token");
    expect(merged).toContain("cdn_sec_tc=retained_edge");
    expect(merged).toContain("acw_sc__v2=new_challenge");
    expect(merged).toHaveLength(3);
  });

  it("identifies WAF block pages accurately based on markers and status code", () => {
    // 403 with alicdn
    expect(isWafBlock(403, "<html><script src='https://g.alicdn.com/waf.js'></script></html>")).toBe(true);
    // 405 with block_message
    expect(isWafBlock(405, "error: block_message triggered")).toBe(true);
    // 403 with renderData
    expect(isWafBlock(403, "window.renderData = {}")).toBe(true);
    // 403 without WAF markers (e.g. standard auth forbidden)
    expect(isWafBlock(403, '{"error":"Invalid API key"}')).toBe(false);
    // 200 containing marker (e.g. documentation or prompt discussion)
    expect(isWafBlock(200, "discussing alicdn")).toBe(false);
    // 404
    expect(isWafBlock(404, "not found")).toBe(false);
  });

  it("injects captured WAF cookies into outbound request headers", () => {
    globalWafStore.set(["acw_tc=session_123", "acw_sc__v2=token_456"]);

    const headers = getAgentRouterHeaders({
      isClaudeEndpoint: true,
      apiKey: "sk-test",
    });

    expect(headers["Cookie"]).toContain("acw_tc=session_123");
    expect(headers["Cookie"]).toContain("acw_sc__v2=token_456");
  });

  it("WafCookieStore captures cookies from response headers", () => {
    const store = new WafCookieStore();

    const mockResponse = {
      headers: {
        getSetCookie: () => ["acw_tc=rotated_cookie; Path=/"],
      },
    };

    store.capture(mockResponse);
    expect(store.get()).toBe("acw_tc=rotated_cookie");
  });
});
