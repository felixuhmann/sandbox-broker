import { describe, expect, it } from "vitest";

import { computeBlockedCidrs } from "./hostAddresses.js";
import { CLOUD_METADATA_ADDRESS, MANDATORY_BLOCKED_CIDRS } from "./network.js";

const empty = {
  hostAddresses: [],
  dockerNetworks: [],
  brokerInterfaces: [],
  configured: [],
};

describe("computeBlockedCidrs", () => {
  it("covers every mandatory range", () => {
    const blocked = computeBlockedCidrs(empty);
    for (const cidr of MANDATORY_BLOCKED_CIDRS) {
      // Some mandatory entries sit inside others (255.255.255.255/32 inside
      // 240.0.0.0/4); coverage, not literal membership, is the requirement.
      expect(blocked.some((entry) => covers(entry, cidr))).toBe(true);
    }
  });

  it("covers the cloud metadata endpoint through link-local", () => {
    const blocked = computeBlockedCidrs(empty);
    expect(blocked).toContain("169.254.0.0/16");
    // 169.254.169.254 falls inside that range.
    expect(CLOUD_METADATA_ADDRESS.startsWith("169.254.")).toBe(true);
  });

  it("adds the host's public address, which RFC1918 blocking cannot cover", () => {
    const blocked = computeBlockedCidrs({ ...empty, hostAddresses: ["93.184.216.34/32"] });
    expect(blocked).toContain("93.184.216.34/32");
    // Without it, that address would be indistinguishable from any other
    // public destination and therefore reachable.
    expect(computeBlockedCidrs(empty)).not.toContain("93.184.216.34/32");
  });

  it("adds Docker subnets, gateways, broker addresses and configured endpoints", () => {
    const blocked = computeBlockedCidrs({
      hostAddresses: ["198.51.100.5/32"],
      dockerNetworks: ["172.19.0.0/16", "172.19.0.1/32"],
      brokerInterfaces: ["172.19.0.2/32"],
      configured: ["8.8.4.4/32"],
    });
    // 172.19.* already sits inside the mandatory 172.16.0.0/12 block.
    expect(blocked).toEqual(expect.arrayContaining(["8.8.4.4/32", "172.16.0.0/12"]));
    expect(blocked).toContain("198.51.100.0/24");
  });

  it("collapses ranges that another entry already covers", () => {
    // nftables interval sets reject overlapping elements, and Docker gateway
    // addresses genuinely fall inside the mandatory RFC1918 blocks.
    const blocked = computeBlockedCidrs({
      ...empty,
      dockerNetworks: ["172.17.0.0/16", "172.17.0.1/32", "10.42.0.0/24"],
      brokerInterfaces: ["127.0.0.1/32", "10.42.0.5/32"],
    });
    expect(blocked).not.toContain("172.17.0.1/32");
    expect(blocked).not.toContain("172.17.0.0/16");
    expect(blocked).not.toContain("127.0.0.1/32");
    expect(blocked).not.toContain("10.42.0.5/32");
    expect(blocked).toContain("172.16.0.0/12");
    expect(blocked).toContain("10.0.0.0/8");

    // No two remaining entries may overlap.
    for (const a of blocked) {
      for (const b of blocked) {
        if (a === b) continue;
        expect(covers(a, b)).toBe(false);
      }
    }
  });

  it("reduces a host address written with a subnet mask to its network", () => {
    const blocked = computeBlockedCidrs({ ...empty, configured: ["203.0.114.109/24"] });
    expect(blocked).toContain("203.0.114.0/24");
  });

  it("deduplicates and sorts deterministically", () => {
    const first = computeBlockedCidrs({ ...empty, configured: ["10.0.0.0/8", "10.0.0.0/8"] });
    const second = computeBlockedCidrs({ ...empty, configured: ["10.0.0.0/8"] });
    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(first.length);
  });

  it("normalizes bare addresses to /32", () => {
    expect(computeBlockedCidrs({ ...empty, configured: ["93.184.216.9"] })).toContain(
      "93.184.216.9/32",
    );
  });

  it("drops IPv6 entries, which are handled by a separate wholesale rule", () => {
    const blocked = computeBlockedCidrs({
      ...empty,
      dockerNetworks: ["fd00::/64"],
      hostAddresses: ["fe80::1/128"],
    });
    expect(blocked.some((cidr) => cidr.includes(":"))).toBe(false);
  });
});

/** True when `outer` fully contains `inner`. */
function covers(outer: string, inner: string): boolean {
  const range = (cidr: string) => {
    const [address, prefix] = cidr.split("/");
    const start = (address ?? "")
      .split(".")
      .reduce((acc, octet) => acc * 256 + Number(octet), 0);
    const size = 2 ** (32 - Number(prefix));
    return { start, end: start + size - 1 };
  };
  const o = range(outer);
  const i = range(inner);
  return o.start <= i.start && i.end <= o.end;
}
