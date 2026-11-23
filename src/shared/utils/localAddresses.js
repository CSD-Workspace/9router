import os from "os";
import dgram from "dgram";

// Interface names are not a usable signal: on Windows the real LAN adapter is
// routinely called "vEthernet (...)" while a VPN client can hold a public-range
// address. Address shape plus the routing table are what actually describe reachability.

// 169.254/16 (APIPA) means DHCP never answered; that address routes nowhere.
const APIPA_PREFIX = "169.254.";

const DEFAULT_PORT = 20128;

// Probe target only ever used to consult the routing table — `connect()` on a UDP
// socket sends no packet, it just asks which local address the OS would bind.
const ROUTE_PROBE_HOST = "8.8.8.8";
const ROUTE_PROBE_PORT = 80;
const ROUTE_PROBE_TIMEOUT_MS = 300;

/** @returns {number|null} 32-bit value of a dotted-quad IPv4, or null if unparseable */
function ipv4ToInt(address) {
  if (typeof address !== "string") return null;
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

// Host-only adapters (VirtualBox 192.168.56.1, VMware 192.168.x.1, Hyper-V default
// switch …) mint the first usable address of their own subnet. No other machine can
// route to them, so they are never a reachable endpoint.
function isOwnSubnetGateway(address, netmask) {
  const ip = ipv4ToInt(address);
  const mask = ipv4ToInt(netmask);
  if (ip === null || mask === null) return false;
  const network = (ip & mask) >>> 0;
  return ip === (network + 1) >>> 0;
}

// Higher wins. The address the routing table picked is authoritative; after that
// prefer the private ranges a LAN peer is most likely to share.
function scoreAddress(address, routeAddress) {
  if (routeAddress && address === routeAddress) return 100;
  if (address.startsWith("192.168.")) return 3;
  if (address.startsWith("10.")) return 2;
  const m = /^172\.(\d+)\./.exec(address);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return 1;
  return 0;
}

/**
 * Pick this host's LAN IPv4 addresses, best candidate first.
 * Pure over the `os.networkInterfaces()` shape so it stays unit-testable.
 * @param {Object} interfaces - result of os.networkInterfaces()
 * @param {{routeAddress?: string|null}} [options] - address the default route uses, if known
 * @returns {string[]}
 */
export function pickLocalIpv4Addresses(interfaces, { routeAddress = null } = {}) {
  const candidates = [];
  for (const addrs of Object.values(interfaces || {})) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.internal) continue;
      // `family` is "IPv4" on current Node and the number 4 on Node 18.0–18.3.
      if (addr.family !== "IPv4" && addr.family !== 4) continue;
      if (!addr.address || addr.address.startsWith(APIPA_PREFIX)) continue;
      if (isOwnSubnetGateway(addr.address, addr.netmask) && addr.address !== routeAddress) continue;
      if (!candidates.includes(addr.address)) candidates.push(addr.address);
    }
  }
  return candidates.sort(
    (a, b) => scoreAddress(b, routeAddress) - scoreAddress(a, routeAddress)
  );
}

/**
 * The local address the OS would use to leave this machine, i.e. the one a peer on
 * the same network can reach. Null when there is no default route (offline).
 * @returns {Promise<string|null>}
 */
export function getDefaultRouteAddress({ timeoutMs = ROUTE_PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = dgram.createSocket("udp4");
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    socket.once("error", () => finish(null));
    socket.connect(ROUTE_PROBE_PORT, ROUTE_PROBE_HOST, () => {
      const local = socket.address();
      finish(local?.family === "IPv4" ? local.address : null);
    });
  });
}

/** @returns {Promise<string[]>} */
export async function getLocalIpv4Addresses() {
  const routeAddress = await getDefaultRouteAddress();
  return pickLocalIpv4Addresses(os.networkInterfaces(), { routeAddress });
}

/** Port the gateway listens on. `next start` and the CLI export PORT; 20128 is the CLI default. */
export function getServerPort() {
  const port = Number.parseInt(process.env.PORT || "", 10);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT;
}

/**
 * Copy-ready `/v1` base URLs for reaching this server from another machine.
 * Empty when the host has no reachable address, so callers can fall back.
 * @param {string[]} [addresses] - defaults to this host's detected addresses
 * @returns {string[]}
 */
export function buildLocalEndpointUrls(addresses) {
  const port = getServerPort();
  return addresses.map((ip) => `http://${ip}:${port}/v1`);
}

/** @returns {Promise<string[]>} */
export async function getLocalEndpointUrls() {
  return buildLocalEndpointUrls(await getLocalIpv4Addresses());
}
