// Proxy-pool relays must not hand the provider the machine's real IP.
//
// Vercel / Cloudflare / Deno / Netlify all inject request headers naming the
// original client (CF-Connecting-IP, X-Forwarded-For, X-Vercel-Forwarded-For,
// X-NF-Client-Connection-IP, ...). The relays copied `request.headers` to the
// upstream, so the provider read the real address even though the TCP connection
// came from the edge network — the pool masked nothing. Each relay now strips
// those headers before forwarding, leaving the edge egress IP as the only
// address the provider can see.
import { describe, expect, it, vi } from "vitest";
import {
  cloudflareRelayCode,
  denoRelayCode,
  relayIpHeaders,
  vercelRelayCode,
} from "../../src/lib/network/relayScripts.js";
import { netlifyRelayFunctionCode } from "../../src/lib/network/netlifyRelay.js";

vi.mock("@/models", () => ({
  createProxyPool: vi.fn(async (data) => ({ id: "pool-1", ...data })),
  getProxyPoolById: vi.fn(),
}));

const REAL_IP = "203.0.113.77";

// What an edge platform hands the relay: real provider headers plus every
// client-address header the platform observed.
const INBOUND_HEADERS = {
  "content-type": "application/json",
  authorization: "Bearer sk-test",
  "user-agent": "9router",
  "cf-connecting-ip": REAL_IP,
  "cf-connecting-ipv6": REAL_IP,
  "x-forwarded-for": REAL_IP,
  "x-real-ip": REAL_IP,
  "x-vercel-forwarded-for": REAL_IP,
  "x-nf-client-connection-ip": REAL_IP,
  "true-client-ip": REAL_IP,
  "x-client-ip": REAL_IP,
  forwarded: `for=${REAL_IP}`,
  "x-9r-real-ip": REAL_IP,
  "x-relay-target": "https://api.example.com",
  "x-relay-path": "/v1/chat",
};

const FORWARDED_KEYS = [
  "content-type",
  "authorization",
  "user-agent",
];

function newInboundHeaders() {
  return new Request("https://relay.example/", {
    method: "POST",
    headers: INBOUND_HEADERS,
    body: "{}",
  }).headers;
}

function captureFetch() {
  const seen = {};
  const fakeFetch = async (url, init) => {
    const headers = init.headers instanceof Headers
      ? Object.fromEntries(init.headers.entries())
      : Object.fromEntries(new Headers(init.headers || {}).entries());
    seen.url = typeof url === "string" ? url : String(url);
    seen.headers = headers;
    return {
      status: 200,
      headers: new Headers(),
      body: null,
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
  return { seen, fakeFetch };
}

function expectNoClientIp(seen) {
  for (const name of relayIpHeaders) {
    expect(seen.headers, `relay forwarded ${name} to the provider`).not.toHaveProperty(name);
  }
  // Relay control headers are internal and never belong upstream.
  expect(seen.headers).not.toHaveProperty("x-relay-target");
  expect(seen.headers).not.toHaveProperty("x-relay-path");
  // Ordinary request headers still go through.
  for (const key of FORWARDED_KEYS) expect(seen.headers).toHaveProperty(key);
}

async function runCloudflare(fakeFetch) {
  const mod = {};
  new Function("exports", cloudflareRelayCode.replace("export default", "exports.default ="))(mod);
  return mod.default.fetch(
    new Request("https://relay.example/", { method: "POST", headers: INBOUND_HEADERS, body: "{}" }),
    {},
    {},
  );
}

async function runVercel(fakeFetch) {
  const src = vercelRelayCode
    .replace('export const config = { runtime: "edge" };', "")
    .replace("export default async function handler", "async function handler");
  const handler = new Function(`${src}; return handler;`)();
  return handler(
    new Request("https://relay.example/", { method: "POST", headers: INBOUND_HEADERS, body: "{}" }),
  );
}

async function runDeno(fakeFetch) {
  let handler;
  const DenoStub = { serve: (fn) => { handler = fn; } };
  new Function("Deno", denoRelayCode)(DenoStub);
  return handler(
    new Request("https://relay.example/", { method: "POST", headers: INBOUND_HEADERS, body: "{}" }),
  );
}

async function runNetlify(fakeFetch) {
  const exportsObj = {};
  new Function("exports", "fetch", "Buffer", netlifyRelayFunctionCode)(
    exportsObj, fakeFetch, Buffer,
  );
  return exportsObj.handler({ httpMethod: "POST", headers: INBOUND_HEADERS, body: "{}" });
}

const RELAYS = [
  ["cloudflare", runCloudflare],
  ["vercel", runVercel],
  ["deno", runDeno],
  ["netlify", runNetlify],
];

describe.each(RELAYS)("%s relay masks the client IP", (_name, run) => {
  it("does not forward platform client-address headers", async () => {
    const { seen, fakeFetch } = captureFetch();
    const realFetch = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      await run(fakeFetch);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(seen.url).toBe("https://api.example.com/v1/chat");
    expectNoClientIp(seen);
  });
});

describe("relayIpHeaders", () => {
  it("covers every platform's client-address header", () => {
    expect(relayIpHeaders).toEqual(expect.arrayContaining([
      "x-forwarded-for",
      "x-real-ip",
      "cf-connecting-ip",
      "x-vercel-forwarded-for",
      "x-nf-client-connection-ip",
      "true-client-ip",
      "forwarded",
      "x-9r-real-ip",
    ]));
  });

  it("is embedded in every deployed relay source", () => {
    for (const code of [cloudflareRelayCode, vercelRelayCode, denoRelayCode, netlifyRelayFunctionCode]) {
      expect(code).toContain("const relayIpHeaders = new Set(");
    }
  });
});

describe("deploy routes ship the stripping source", () => {
  it("Cloudflare uploads a worker that strips client IP headers", async () => {
    const { POST } = await import("../../src/app/api/proxy-pools/cloudflare-deploy/route.js");
    const bodies = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      bodies.push({ url: String(url), body: init?.body });
      if (String(url).includes("/subdomain")) {
        return { ok: true, json: async () => ({ result: { subdomain: "acct" } }) };
      }
      return { ok: true, json: async () => ({}) };
    });
    try {
      const res = await POST(new Request("http://localhost/x", {
        method: "POST",
        body: JSON.stringify({ accountId: "a", apiToken: "t", projectName: "p" }),
      }));
      expect(res.status).toBe(201);
    } finally {
      globalThis.fetch = fetch;
    }
    const upload = bodies.find((b) => b.body instanceof FormData);
    const source = await upload.body.get("index.js").text();
    expect(source).toContain("relayIpHeaders");
    expect(source).toContain("cf-connecting-ip");
  });
});
