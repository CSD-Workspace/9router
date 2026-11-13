// Address selection must work even when a VPN grabs the highest-priority-looking
// range. The real LAN interface is the one the routing table picks for outbound.
import { afterEach, describe, expect, it } from "vitest";
import {
  buildLocalEndpointUrls,
  getServerPort,
  pickLocalIpv4Addresses,
} from "../../src/shared/utils/localAddresses.js";

function ipv4(address, { internal = false, family = "IPv4", netmask = "255.255.255.0" } = {}) {
  return { address, internal, family, netmask, mac: "00:00:00:00:00:00", cidr: `${address}/24` };
}

describe("pickLocalIpv4Addresses", () => {
  it("ranks the routing-table address above all others", () => {
    const addrs = pickLocalIpv4Addresses(
      {
        "Radmin VPN": [ipv4("26.224.196.76")],
        "vEthernet (LocalHost)": [ipv4("192.168.0.128")],
      },
      { routeAddress: "192.168.0.128" }
    );

    // Extra addresses stay listed as fallbacks, but the routed one must lead.
    expect(addrs).toEqual(["192.168.0.128", "26.224.196.76"]);
  });

  it("falls back to the highest-ranked address when no route address is known", () => {
    const addrs = pickLocalIpv4Addresses({
      "Radmin VPN": [ipv4("26.224.196.76")],
      "Wi-Fi": [ipv4("192.168.1.50")],
    });

    expect(addrs).toEqual(["192.168.1.50", "26.224.196.76"]);
  });

  it("skips VirtualBox/VMware host-only .1 gateway addresses", () => {
    const addrs = pickLocalIpv4Addresses({
      Ethernet: [ipv4("192.168.56.1")],
      "Wi-Fi": [ipv4("192.168.1.50")],
    });

    expect(addrs).toEqual(["192.168.1.50"]);
  });

  it("keeps the .1 address when it is also the route address", () => {
    const addrs = pickLocalIpv4Addresses(
      {
        Ethernet: [ipv4("192.168.56.1")],
        "Wi-Fi": [ipv4("192.168.1.50")],
      },
      { routeAddress: "192.168.1.50" }
    );

    expect(addrs).toEqual(["192.168.1.50"]);
  });

  it("ignores loopback, IPv6, APIPA and internal addresses", () => {
    const addrs = pickLocalIpv4Addresses({
      lo: [ipv4("127.0.0.1", { internal: true })],
      Ethernet: [ipv4("169.254.13.7")],
      "Wi-Fi": [{ ...ipv4("fe80::1"), family: "IPv6" }],
    });

    expect(addrs).toEqual([]);
  });

  it("ranks 192.168 over 10/8 over 172.16-31 over other ranges", () => {
    const addrs = pickLocalIpv4Addresses({
      a: [ipv4("172.20.5.5")],
      b: [ipv4("203.0.113.9")],
      c: [ipv4("10.0.0.4")],
      d: [ipv4("192.168.0.7")],
    });

    expect(addrs).toEqual(["192.168.0.7", "10.0.0.4", "172.20.5.5", "203.0.113.9"]);
  });

  it("accepts the numeric family value that older Node reports", () => {
    const addrs = pickLocalIpv4Addresses(
      { Ethernet: [ipv4("192.168.7.7", { family: 4 })] },
      { routeAddress: "192.168.7.7" }
    );

    expect(addrs).toEqual(["192.168.7.7"]);
  });

  it("de-duplicates an address bound to two interfaces", () => {
    const addrs = pickLocalIpv4Addresses(
      { Ethernet: [ipv4("10.1.1.1")], "Ethernet 2": [ipv4("10.1.1.1")] },
      { routeAddress: "10.1.1.1" }
    );

    expect(addrs).toEqual(["10.1.1.1"]);
  });

  it("survives empty or missing interface map", () => {
    expect(pickLocalIpv4Addresses({})).toEqual([]);
    expect(pickLocalIpv4Addresses(undefined)).toEqual([]);
  });
});

describe("getServerPort", () => {
  const saved = process.env.PORT;

  afterEach(() => {
    if (saved === undefined) delete process.env.PORT;
    else process.env.PORT = saved;
  });

  it("falls back to CLI default when PORT is unset", () => {
    delete process.env.PORT;
    expect(getServerPort()).toBe(20128);
  });

  it("falls back to CLI default for non-numeric or out-of-range values", () => {
    for (const bad of ["", "hello", "0", "-1", "65536"]) {
      process.env.PORT = bad;
      expect(getServerPort()).toBe(20128);
    }
  });

  it("honours a valid PORT value", () => {
    process.env.PORT = "20200";
    expect(getServerPort()).toBe(20200);
  });
});

describe("buildLocalEndpointUrls", () => {
  it("returns copy-ready /v1 URLs with the correct port", () => {
    expect(buildLocalEndpointUrls(["192.168.1.50", "10.0.0.4"], { port: 20128 })).toEqual([
      "http://192.168.1.50:20128/v1",
      "http://10.0.0.4:20128/v1",
    ]);
  });

  it("returns no URLs when given an empty array", () => {
    expect(buildLocalEndpointUrls([])).toEqual([]);
  });
});
