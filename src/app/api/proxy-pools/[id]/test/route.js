import { NextResponse } from "next/server";
import { getProxyPoolById, updateProxyPool } from "@/models";
import {
  getDirectEgressIp,
  getProxyEgressIp,
  getRelayEgressIp,
  testProxyUrl,
} from "@/lib/network/proxyTest";
import { fetch as undiciFetch } from "undici";

function isRelayPool(proxyPool) {
  return proxyPool?.type === "vercel"
    || proxyPool?.type === "cloudflare"
    || proxyPool?.type === "deno"
    || proxyPool?.type === "netlify";
}

async function testVercelRelay(relayUrl, timeoutMs = 10000) {
  const controller = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await undiciFetch(relayUrl, {
      method: "GET",
      headers: {
        "x-relay-target": "https://httpbin.org",
        "x-relay-path": "/get",
      },
      signal: controller.signal,
    });
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: err?.name === "AbortError" ? "Relay test timed out" : (err?.message || String(err)),
    };
  } finally {
    clearTimeout(timer);
  }
}

// POST /api/proxy-pools/[id]/test - Test proxy pool entry
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const proxyPool = await getProxyPoolById(id);

    if (!proxyPool) {
      return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 });
    }

    const isRelay = isRelayPool(proxyPool);
    const result = isRelay
      ? await testVercelRelay(proxyPool.proxyUrl)
      : await testProxyUrl({ proxyUrl: proxyPool.proxyUrl });

    // Read the address the pool actually exits from. Best-effort: a pool can be
    // perfectly usable while the echo service is blocked or slow, so this never
    // changes the pass/fail verdict.
    const egress = isRelay
      ? await getRelayEgressIp({ relayUrl: proxyPool.proxyUrl })
      : await getProxyEgressIp({ proxyUrl: proxyPool.proxyUrl });
    const egressIp = egress?.ok ? egress.ip : null;

    // A pool that exits from this machine's own IPv4 is not masking anything, so
    // the test fails outright. Only claim that when the direct lookup succeeded;
    // an unavailable direct address must never turn into a false "same IP".
    const directIp = egressIp ? await getDirectEgressIp() : null;
    const egressIpIsLocal = Boolean(egressIp && directIp && directIp === egressIp);

    const egressIpError = egressIp ? null : (egress?.error || "IP lookup failed");
    const maskingError = egressIpIsLocal
      ? `Proxy is not masking your IP (egress ${egressIp} is this machine's address)`
      : null;

    const ok = result.ok && !egressIpIsLocal;
    const now = new Date().toISOString();
    const updates = {
      testStatus: ok ? "active" : "error",
      lastTestedAt: now,
      lastError: result.ok ? maskingError : (result.error || `Proxy test failed with status ${result.status}`),
      isActive: ok,
      egressIp,
      egressIpCheckedAt: now,
      egressIpError,
      egressIpIsLocal: egressIp ? egressIpIsLocal : null,
    };

    await updateProxyPool(id, updates);

    return NextResponse.json({
      ok,
      status: result.status,
      statusText: result.statusText || null,
      error: updates.lastError,
      elapsedMs: result.elapsedMs || 0,
      testedAt: now,
      egressIp,
      egressIpIsLocal: updates.egressIpIsLocal,
      egressIpError,
    });
  } catch (error) {
    console.log("Error testing proxy pool:", error);
    return NextResponse.json({ error: "Failed to test proxy pool" }, { status: 500 });
  }
}
