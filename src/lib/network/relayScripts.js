// Edge relay sources for the Vercel, Cloudflare and Deno proxy pools.
//
// Each platform stamps the request with headers naming the original client (the
// machine running 9Router): CF-Connecting-IP, X-Forwarded-For, X-Vercel-Forwarded-For,
// X-NF-Client-Connection-IP, True-Client-IP, X-Real-IP and so on. A relay that
// copies request.headers straight through hands those to the provider, which
// then reads the real address even though the TCP connection came from the edge
// network. The pool masks nothing that way.
//
// Every relay here strips them first, so the only address the provider can see
// is the edge egress IP. x-9r-real-ip is 9Router's own client-address header
// (stamped by custom-server.js) and goes for the same reason.

export const relayIpHeaders = [
  "forwarded",
  "x-forwarded-for",
  "x-real-ip",
  "client-ip",
  "x-client-ip",
  "x-cluster-client-ip",
  "x-original-forwarded-for",
  "true-client-ip",
  "cf-connecting-ip",
  "cf-connecting-ipv6",
  "x-vercel-forwarded-for",
  "x-nf-client-connection-ip",
  "fastly-client-ip",
  "x-azure-clientip",
  "x-appengine-user-ip",
  "x-9r-real-ip",
];

// Statement prepended to each relay source so the deployed artifact is standalone.
const ipHeaderSet = `const relayIpHeaders = new Set(${JSON.stringify(relayIpHeaders)});`;

export const cloudflareRelayCode = `${ipHeaderSet}
export default {
  async fetch(request, env, ctx) {
    const target = request.headers.get("x-relay-target");
    const relayPath = request.headers.get("x-relay-path") || "/";

    if (!target) {
      return new Response(JSON.stringify({ error: "Missing x-relay-target header" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    const targetUrl = target.replace(/\\/$/, "") + relayPath;
    const forwarded = new Headers(request.headers);
    forwarded.delete("x-relay-target");
    forwarded.delete("x-relay-path");
    forwarded.delete("host");
    for (const name of relayIpHeaders) forwarded.delete(name);

    const newRequestInit = {
      method: request.method,
      headers: forwarded,
    };

    if (request.method !== "GET" && request.method !== "HEAD") {
      newRequestInit.body = request.body;
      newRequestInit.duplex = "half";
    }

    try {
      const response = await fetch(targetUrl, newRequestInit);
      return new Response(response.body, {
        status: response.status,
        headers: response.headers,
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    }
  },
};
`;

export const vercelRelayCode = `${ipHeaderSet}
export const config = { runtime: "edge" };

export default async function handler(req) {
  const target = req.headers.get("x-relay-target");
  const relayPath = req.headers.get("x-relay-path") || "/";
  if (!target) {
    return new Response(JSON.stringify({ error: "Missing x-relay-target header" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const targetUrl = target.replace(/\\/$/, "") + relayPath;

  const rawHeaders = {};
  for (const [k, v] of req.headers.entries()) rawHeaders[k] = v;
  delete rawHeaders["x-relay-target"];
  delete rawHeaders["x-relay-path"];
  delete rawHeaders["host"];
  for (const name of relayIpHeaders) delete rawHeaders[name];

  const response = await fetch(targetUrl, {
    method: req.method,
    headers: rawHeaders,
    body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
    duplex: "half",
  });

  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  });
}
`;

export const denoRelayCode = `${ipHeaderSet}
Deno.serve(async (request) => {
  const target = request.headers.get("x-relay-target");
  const relayPath = request.headers.get("x-relay-path") || "/";

  if (!target) {
    return new Response(JSON.stringify({ error: "Missing x-relay-target header" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const targetUrl = target.replace(/\\/$/, "") + relayPath;
  const newHeaders = new Headers(request.headers);
  newHeaders.delete("x-relay-target");
  newHeaders.delete("x-relay-path");
  newHeaders.delete("host");
  for (const name of relayIpHeaders) newHeaders.delete(name);

  const init = {
    method: request.method,
    headers: newHeaders,
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }

  try {
    const response = await fetch(targetUrl, init);
    return new Response(response.body, {
      status: response.status,
      headers: response.headers,
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
});`;
