/**
 * AgentRouter WAF bypass & session cookie store.
 * Ported from agentrouter-spoof-proxy/internal/auth/waf.go.
 *
 * Upstream agentrouter.org uses Alibaba Cloud / CDN WAF challenges.
 * This module:
 * 1. Warmups GET https://agentrouter.org/ with browser-like Chrome headers to acquire
 *    challenge cookies (acw_tc, acw_sc__v2, acw_sc__v3, cdn_sec_tc).
 * 2. Captures Set-Cookie from every API response to keep cookies rotated in-flight.
 * 3. Injects Cookie: acw_tc=...; cdn_sec_tc=... into outbound requests.
 * 4. Detects WAF 403/405 block pages and triggers a re-warmup + single retry.
 */

const WAF_COOKIE_NAMES = new Set([
  "acw_tc",
  "acw_sc__v2",
  "acw_sc__v3",
  "cdn_sec_tc",
]);

export const WARMUP_HEADERS = {
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Connection": "keep-alive",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
};

const WAF_BLOCK_MARKERS = ["alicdn", "block_message", "renderData", "waf.js"];

/**
 * Extracts valid WAF cookies from Set-Cookie header strings.
 * @param {string[]|string} setCookieValues
 * @returns {string[]} array of "name=value"
 */
export function extractWafCookies(setCookieValues) {
  if (!setCookieValues) return [];
  const entries = Array.isArray(setCookieValues) ? setCookieValues : [setCookieValues];
  const waf = [];

  for (const raw of entries) {
    if (typeof raw !== "string") continue;
    // Each Set-Cookie entry can have multiple semi-colon separated directives
    const pair = raw.split(";")[0].trim();
    const eqIdx = pair.indexOf("=");
    if (eqIdx < 1) continue;

    const name = pair.slice(0, eqIdx).trim();
    const value = pair.slice(eqIdx + 1).trim();

    if (WAF_COOKIE_NAMES.has(name) && value) {
      waf.push(`${name}=${value}`);
    }
  }

  return waf;
}

/**
 * Merges cookie lists by name, fresh replaces existing.
 * @param {string[]} current
 * @param {string[]} fresh
 * @returns {string[]}
 */
export function mergeWafCookies(current = [], fresh = []) {
  const map = new Map();

  for (const c of current) {
    const eq = c.indexOf("=");
    if (eq > 0) map.set(c.slice(0, eq), c);
  }

  for (const c of fresh) {
    const eq = c.indexOf("=");
    if (eq > 0) map.set(c.slice(0, eq), c);
  }

  return [...map.values()];
}

/**
 * Detects whether an upstream response is a WAF block page.
 * @param {number} statusCode
 * @param {string} bodyText
 * @returns {boolean}
 */
export function isWafBlock(statusCode, bodyText) {
  if (statusCode !== 403 && statusCode !== 405) {
    return false;
  }
  const text = String(bodyText || "");
  return WAF_BLOCK_MARKERS.some((m) => text.includes(m));
}

/**
 * WAF Cookie Store holding cookies safely in memory.
 */
export class WafCookieStore {
  constructor(defaultTarget = "https://agentrouter.org") {
    this.cookies = [];
    this.targetUrl = defaultTarget;
    this.warmingPromise = null;
  }

  setTarget(url) {
    if (url) this.targetUrl = url;
  }

  get() {
    return this.cookies.join("; ");
  }

  set(cookieArray) {
    this.cookies = Array.isArray(cookieArray) ? [...cookieArray] : [];
  }

  /**
   * Captures rotated WAF cookies from an HTTP response.
   * @param {Response} response
   */
  capture(response) {
    if (!response?.headers) return;
    let setCookies = [];

    if (typeof response.headers.getSetCookie === "function") {
      setCookies = response.headers.getSetCookie();
    } else {
      const single = response.headers.get("set-cookie");
      if (single) setCookies = [single];
    }

    const fresh = extractWafCookies(setCookies);
    if (fresh.length > 0) {
      this.cookies = mergeWafCookies(this.cookies, fresh);
    }
  }

  /**
   * Warmup sends a browser-like GET request to upstream root to capture challenge cookies.
   * Retries up to 3 times with exponential backoff (1s, 2s).
   * @param {string} [originUrl]
   * @returns {Promise<boolean>}
   */
  async warmup(originUrl = null) {
    if (this.warmingPromise) return this.warmingPromise;

    this.warmingPromise = (async () => {
      const target = (originUrl || this.targetUrl || "https://agentrouter.org").replace(/\/v1.*$/, "/");
      const backoffs = [1000, 2000];

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await fetch(target, {
            method: "GET",
            headers: WARMUP_HEADERS,
            signal: AbortSignal.timeout(10000),
          });

          this.capture(res);

          if (this.cookies.length > 0) {
            return true;
          }
        } catch {
          // ignore warmup network error and try next attempt
        }

        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, backoffs[attempt]));
        }
      }

      return this.cookies.length > 0;
    })().finally(() => {
      this.warmingPromise = null;
    });

    return this.warmingPromise;
  }
}

// Global shared store instance for agentrouter
export const globalWafStore = new WafCookieStore("https://agentrouter.org");
