import { ProxyAgent, fetch as undiciFetch, request } from "undici";

const defaultTestUrl = "https://google.com/";
const defaultTimeoutMs = 8000;

// IPv4 echo services, tried in order until one answers with IPv4.
//
// A hostname like api4.ipify.org only restricts how THIS machine resolves it; a
// Cloudflare Worker egresses over IPv6 and hands the service an IPv6 connection,
// so api4.ipify.org answered "2a06:98c0:3600::103" through a deployed relay. The
// candidates below were measured through a live workers.dev relay: ident.me and
// ifconfig.me reply with IPv4 even on an IPv6 connection, ipify does not.
const ipEchoUrls = [
  "https://ipv4.ident.me",
  "https://ifconfig.me/ip",
  "https://api4.ipify.org",
];
const ipEchoTimeoutMs = 8000;

// Only accept a syntactically valid IPv4 address — a proxy that injects an HTML
// error page or a captive-portal redirect must not be stored as an "IP".
const ipv4Pattern = /^(\d{1,3}\.){3}\d{1,3}$/;

export function parseEgressIp(body) {
  const value = normalizeString(body);
  if (!value) return null;
  const candidate = value.split(/\s+/)[0];
  if (!ipv4Pattern.test(candidate)) return null;
  return candidate.split(".").every((part) => Number(part) <= 255) ? candidate : null;
}

/**
 * Try each echo service until one yields an IPv4 address.
 *
 * An IPv6 answer is not an error to report — it means that service saw the
 * caller over IPv6 — so move on to the next candidate. The last failure is
 * returned when none produced IPv4, which keeps a real network error visible
 * instead of masking it as "unreadable".
 */
async function firstIpv4(urls, read, unreadableMessage) {
  let lastError = null;
  for (const url of urls) {
    const echoed = await read(url);
    if (!echoed.ok) {
      lastError = echoed;
      continue;
    }
    const ip = parseEgressIp(echoed.text);
    if (ip) return { ok: true, ip };
  }
  return lastError || { ok: false, error: unreadableMessage };
}

/**
 * Read an IPv4 echo response without letting undici decompress it.
 *
 * A relay copies the upstream's `content-encoding` header onto a body it has
 * already decoded (the edge runtime hands it plain text). `fetch` trusts that
 * header and tries to gunzip/br-decode plain text, which fails with
 * "Decompression failed (ERR__ERROR_FORMAT_HUFFMAN_SPACE)" — so a working relay
 * looked like it returned an unreadable address. undici's lower-level `request`
 * does not decode at all; the body here is always a short plain-text line, so
 * dropping `content-encoding` before reading is both safe and correct.
 */
async function readEchoBody(url, { dispatcher, timeoutMs, headers }) {
  let res;
  try {
    res = await request(url, {
      dispatcher,
      signal: AbortSignal.timeout(timeoutMs),
      headers,
      // Ask for an unencoded response when the server honours it; the raw read
      // below covers the relay case that ignores this.
      maxRedirections: 0,
    });
  } catch (err) {
    const message = err?.name === "AbortError" || err?.name === "TimeoutError"
      ? "IP lookup timed out"
      : getErrorMessage(err);
    return { ok: false, error: message };
  }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    res.body.dump().catch(() => {});
    return { ok: false, error: `IP service answered HTTP ${res.statusCode}` };
  }
  // arrayBuffer() consumes the body, but close explicitly so a throwing read
  // cannot leave the socket open on a pooled connection.
  try {
    const bytes = Buffer.from(await res.body.arrayBuffer());
    return { ok: true, text: bytes.toString("utf8") };
  } finally {
    res.body.destroy?.();
  }
}

function getErrorMessage(err) {
  if (!err) return "Unknown error";
  const base = err?.message || String(err);
  const causeCode = err?.cause?.code || err?.code;
  const causeMessage = err?.cause?.message;

  if (causeMessage && causeMessage !== base) {
    return causeCode ? `${base}: ${causeMessage} (${causeCode})` : `${base}: ${causeMessage}`;
  }

  if (causeCode && !base.includes(causeCode)) {
    return `${base} (${causeCode})`;
  }

  return base;
}

function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

export async function testProxyUrl({ proxyUrl, testUrl, timeoutMs } = {}) {
  const normalizedProxyUrl = normalizeString(proxyUrl);
  if (!normalizedProxyUrl) {
    return { ok: false, status: 400, error: "proxyUrl is required" };
  }

  const normalizedTestUrl = normalizeString(testUrl) || defaultTestUrl;
  const timeoutMsRaw = Number(timeoutMs);
  const normalizedTimeoutMs =
    Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
      ? Math.min(timeoutMsRaw, 30000)
      : defaultTimeoutMs;

  let dispatcher;

  try {
    try {
      dispatcher = new ProxyAgent({ uri: normalizedProxyUrl });
    } catch (err) {
      return {
        ok: false,
        status: 400,
        error: `Invalid proxy URL: ${err?.message || String(err)}`,
      };
    }

    const controller = new AbortController();
    const startedAt = Date.now();
    const timer = setTimeout(() => controller.abort(), normalizedTimeoutMs);

    try {
      const res = await undiciFetch(normalizedTestUrl, {
        method: "HEAD",
        dispatcher,
        signal: controller.signal,
        headers: {
          "User-Agent": "9Router",
        },
      });

      return {
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        url: normalizedTestUrl,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (err) {
      const message =
        err?.name === "AbortError"
          ? "Proxy test timed out"
          : getErrorMessage(err);
      return { ok: false, status: 500, error: message };
    } finally {
      clearTimeout(timer);
    }
  } finally {
    try {
      await dispatcher?.close?.();
    } catch {
      // ignore
    }
  }
}

/**
 * Read the egress IP of a standard (HTTP/SOCKS) proxy pool.
 * Runs the request through a ProxyAgent, so the echo service sees the proxy's
 * address rather than this machine's.
 */
export async function getProxyEgressIp({ proxyUrl, timeoutMs } = {}) {
  const normalizedProxyUrl = normalizeString(proxyUrl);
  if (!normalizedProxyUrl) return { ok: false, error: "proxyUrl is required" };

  const budget = Number(timeoutMs) > 0 ? Math.min(Number(timeoutMs), 15000) : ipEchoTimeoutMs;
  let dispatcher;
  try {
    try {
      dispatcher = new ProxyAgent({ uri: normalizedProxyUrl });
    } catch (err) {
      return { ok: false, error: `Invalid proxy URL: ${err?.message || String(err)}` };
    }

    return await firstIpv4(ipEchoUrls, (url) => readEchoBody(url, {
      dispatcher,
      timeoutMs: budget,
      headers: { Accept: "text/plain", "User-Agent": "9Router" },
    }), "IP service returned an unreadable address");
  } finally {
    try {
      await dispatcher?.close?.();
    } catch {
      // ignore
    }
  }
}

/**
 * Read the egress IP of an edge relay pool (Vercel / Cloudflare / Deno / Netlify).
 * The relay is called with its own x-relay-target headers, so the echo service
 * sees whatever address the edge network exits from.
 */
export async function getRelayEgressIp({ relayUrl, timeoutMs } = {}) {
  const normalizedRelayUrl = normalizeString(relayUrl);
  if (!normalizedRelayUrl) return { ok: false, error: "relayUrl is required" };

  const budget = Number(timeoutMs) > 0 ? Math.min(Number(timeoutMs), 15000) : ipEchoTimeoutMs;
  const result = await firstIpv4(ipEchoUrls, (target) => {
    const echo = new URL(target);
    return readEchoBody(normalizedRelayUrl, {
      timeoutMs: budget,
      headers: {
        Accept: "text/plain",
        "User-Agent": "9Router",
        "x-relay-target": `${echo.protocol}//${echo.host}`,
        "x-relay-path": `${echo.pathname}${echo.search}`,
      },
    });
  }, "Relay returned an unreadable address");
  if (!result.ok && result.error) {
    // Copy rather than mutate: firstIpv4 may hand back an object it built once.
    return { ...result, error: result.error.replace(/^IP service answered/, "Relay answered") };
  }
  return result;
}

/**
 * Read the machine's own public IP (no proxy). Used to warn when a pool is not
 * actually masking the caller.
 */
export async function getDirectEgressIp({ timeoutMs } = {}) {
  const budget = Number(timeoutMs) > 0 ? Math.min(Number(timeoutMs), 15000) : ipEchoTimeoutMs;
  const result = await firstIpv4(ipEchoUrls, (url) => readEchoBody(url, {
    timeoutMs: budget,
    headers: { Accept: "text/plain", "User-Agent": "9Router" },
  }), "unreadable");
  return result.ok ? result.ip : null;
}
