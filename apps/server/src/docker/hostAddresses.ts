import { networkInterfaces } from "node:os";

import type { BrokerConfig } from "../config.js";
import type { DockerClient } from "./client.js";
import { MANDATORY_BLOCKED_CIDRS } from "./network.js";
import { runHelper } from "./firewallHelper.js";

/**
 * Addresses of the process running the broker. In production that is the
 * broker's own container, so this is exactly the control endpoint a sandbox
 * must not be able to reach.
 */
export function brokerInterfaceCidrs(): string[] {
  const out: string[] = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && address.address) out.push(`${address.address}/32`);
    }
  }
  return out;
}

/**
 * Every Docker-managed subnet and gateway on the host: docker0, the broker's
 * own egress bridge, and — importantly — the application/database networks the
 * sandbox must never touch.
 */
export async function dockerNetworkCidrs(docker: DockerClient): Promise<string[]> {
  const networks = await docker.listNetworks();
  const out: string[] = [];
  for (const network of networks) {
    for (const entry of network.IPAM?.Config ?? []) {
      const subnet = (entry as { Subnet?: string; Gateway?: string }).Subnet;
      const gateway = (entry as { Subnet?: string; Gateway?: string }).Gateway;
      if (subnet && !subnet.includes(":")) out.push(subnet);
      if (gateway && !gateway.includes(":")) out.push(`${gateway}/32`);
    }
  }
  return out;
}

/**
 * Reads the host's real interface addresses by running the trusted helper in
 * the host network namespace for a fraction of a second.
 *
 * This is the only way for a containerized broker to learn the host's *public*
 * address, which is the one range RFC1918 blocking cannot cover. If the probe
 * fails, the caller must surface it rather than silently shipping a policy with
 * a hole in it.
 */
export async function probeHostAddresses(
  docker: DockerClient,
  config: BrokerConfig,
): Promise<string[]> {
  const result = await runHelper(docker, config, {
    sandboxId: "host-probe",
    mode: "host-addresses",
    networkMode: "host",
    capabilities: [],
  });
  if (result.exitCode !== 0 || !result.output.includes("HOST_ADDRESSES_OK")) {
    throw new Error(
      `Host address probe failed (exit ${result.exitCode}): ${result.output.trim().slice(0, 500)}`,
    );
  }
  return result.output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+\.\d+\.\d+\.\d+\/32$/.test(line));
}

export type BlockedCidrSources = {
  hostAddresses: readonly string[];
  dockerNetworks: readonly string[];
  brokerInterfaces: readonly string[];
  configured: readonly string[];
};

/**
 * The full drop list for `unrestricted` mode: the mandatory ranges plus every
 * address the deployment actually uses. Deduplicated and IPv4-only, because
 * IPv6 is dropped wholesale by a separate rule.
 */
export function computeBlockedCidrs(sources: BlockedCidrSources): string[] {
  const all = [
    ...MANDATORY_BLOCKED_CIDRS,
    ...sources.hostAddresses,
    ...sources.dockerNetworks,
    ...sources.brokerInterfaces,
    ...sources.configured,
  ];
  const unique = new Set<string>();
  for (const raw of all) {
    const cidr = raw.trim();
    if (!cidr || cidr.includes(":")) continue;
    const normalized = normalizeCidr(cidr);
    if (normalized) unique.add(normalized);
  }
  return collapseCidrs([...unique]);
}

/**
 * Canonicalizes to `network/prefix`. A host address written with a subnet mask
 * (`192.168.8.109/24`) is reduced to its network address, because that is what
 * nftables stores and what the verification step reads back.
 */
export function normalizeCidr(input: string): string | null {
  const [address, prefixRaw] = input.includes("/") ? input.split("/") : [input, "32"];
  const prefix = Number(prefixRaw);
  const value = ipv4ToInt(address ?? "");
  if (value === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return `${intToIpv4((value & mask) >>> 0)}/${prefix}`;
}

/**
 * Removes any CIDR fully contained in another.
 *
 * nftables interval sets reject overlapping elements outright, and the inputs
 * genuinely overlap in practice: a Docker bridge gateway such as 172.17.0.1/32
 * sits inside the mandatory 172.16.0.0/12 block. Dropping the redundant entry
 * changes nothing about what is blocked.
 */
export function collapseCidrs(cidrs: readonly string[]): string[] {
  const parsed = cidrs
    .map((cidr) => {
      const normalized = normalizeCidr(cidr);
      if (!normalized) return null;
      const [address, prefixRaw] = normalized.split("/");
      const start = ipv4ToInt(address ?? "");
      if (start === null) return null;
      const prefix = Number(prefixRaw);
      const size = prefix === 0 ? 0x100000000 : 2 ** (32 - prefix);
      return { cidr: normalized, start, end: start + size - 1 };
    })
    .filter((entry): entry is { cidr: string; start: number; end: number } => entry !== null)
    // Widest range first at each starting point, so a container is always seen
    // before anything it contains.
    .sort((a, b) => a.start - b.start || b.end - a.end);

  const kept: { start: number; end: number; cidr: string }[] = [];
  for (const entry of parsed) {
    const covered = kept.some((k) => k.start <= entry.start && entry.end <= k.end);
    if (!covered) kept.push(entry);
  }
  return kept.map((entry) => entry.cidr).sort();
}

function ipv4ToInt(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function intToIpv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join(".");
}
