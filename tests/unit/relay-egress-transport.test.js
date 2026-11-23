// Real observed failures in the Proxy Pools "Test" button, both reproduced while
// the connection test kept passing:
//
// 1. "Relay returned an unreadable address" — a relay copies the upstream's
//    `content-encoding` onto a body the edge already decoded. undici's `fetch`
//    trusts the header and tries to brotli/gzip-decode plain text, which throws
//    "Decompression failed (ERR__ERROR_FORMAT_HUFFMAN_SPACE)". The reader now uses
//    undici's `request`, which hands back raw bytes untouched.
//
// 2. Same message again, from a live workers.dev relay: a Cloudflare Worker
//    egresses over IPv6, so the echo service reported "2a06:98c0:3600::103" even
//    for api4.ipify.org. The reader now walks a candidate list and skips IPv6
//    answers instead of treating them as the final result.
//
// No vi.mock in this file on purpose: these cases exercise the real transport
// against a local server. (The route test mocks these functions, which would
// stub out the very code under test.)
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import {
  getRelayEgressIp,
  getProxyEgressIp,
  getDirectEgressIp,
} from "../../src/lib/network/proxyTest.js";

// `respond` gets the incoming request so a case can vary by x-relay-target.
async function withServer(respond, run) {
  const server = createServer(respond);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await run(`http://127.0.0.1:${server.address().port}/`);
  } finally {
    server.close();
  }
}

function fixed({ contentEncoding, body, status = 200 }) {
  return (req, res) => {
    res.statusCode = status;
    res.setHeader("content-type", "text/plain");
    if (contentEncoding) res.setHeader("content-encoding", contentEncoding);
    res.end(body);
  };
}

describe("relay egress survives a forwarded content-encoding header", () => {
  it.each([
    ["no encoding", undefined],
    ["stale gzip header on an already-decoded body", "gzip"],
    ["stale br header on an already-decoded body", "br"],
  ])("reads the address with %s", async (_name, contentEncoding) => {
    const result = await withServer(
      fixed({ contentEncoding, body: "198.51.100.9" }),
      (url) => getRelayEgressIp({ relayUrl: url }),
    );
    expect(result).toEqual({ ok: true, ip: "198.51.100.9" });
  });
});

describe("relay egress skips an IPv6 answer", () => {
  it("falls through to the next candidate instead of giving up", async () => {
    // First candidate answers IPv6 (what a Worker egressing over IPv6 gets),
    // later ones answer IPv4. The IPv6 body must not end the search.
    let calls = 0;
    const result = await withServer(
      (req, res) => {
        calls += 1;
        res.statusCode = 200;
        res.setHeader("content-type", "text/plain");
        res.end(calls === 1 ? "2a06:98c0:3600::103" : "172.68.164.157");
      },
      (url) => getRelayEgressIp({ relayUrl: url }),
    );
    expect(result).toEqual({ ok: true, ip: "172.68.164.157" });
  });

  it("reports unreadable when every candidate answers IPv6", async () => {
    const result = await withServer(
      fixed({ body: "2a06:98c0:3600::103" }),
      (url) => getRelayEgressIp({ relayUrl: url }),
    );
    expect(result).toEqual({ ok: false, error: "Relay returned an unreadable address" });
  });
});

describe("relay egress error reporting", () => {
  it("treats a non-2xx relay response as a failure", async () => {
    const result = await withServer(
      fixed({ body: "nope", status: 502 }),
      (url) => getRelayEgressIp({ relayUrl: url }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/502/);
  });

  it("rejects a body that is not an IP", async () => {
    const result = await withServer(
      fixed({ body: "<html>blocked</html>" }),
      (url) => getRelayEgressIp({ relayUrl: url }),
    );
    expect(result).toEqual({ ok: false, error: "Relay returned an unreadable address" });
  });
});

describe("direct egress lookup", () => {
  it("returns an IPv4 address or null, never throws", async () => {
    const ip = await getDirectEgressIp({ timeoutMs: 15000 });
    if (ip !== null) expect(ip).toMatch(/^(\d{1,3}\.){3}\d{1,3}$/);
  });

  it("returns a structured error for an unusable proxy url", async () => {
    const result = await getProxyEgressIp({ proxyUrl: "not-a-url::" });
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
  });
});
