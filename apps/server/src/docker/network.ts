import type { NetworkMode } from "@sandbox-broker/contracts";

import type { BrokerConfig } from "../config.js";

/** Docker's built-in network with only a loopback interface. */
export const DENY_ALL_NETWORK = "none";

/** Docker's embedded DNS resolver address inside a user-defined bridge. */
export const DOCKER_EMBEDDED_DNS = "127.0.0.11";

/**
 * Destinations an `unrestricted` sandbox must never reach, regardless of what
 * the operator configures. Covers loopback, RFC1918, CGNAT, link-local
 * (including the 169.254.169.254 cloud metadata endpoint), documentation and
 * benchmarking ranges, multicast and reserved space.
 *
 * Docker bridge subnets and every address detected on a host interface are
 * added on top of this at policy-application time.
 */
export const MANDATORY_BLOCKED_CIDRS: readonly string[] = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "255.255.255.255/32",
];

/** The metadata address is called out separately because it is tested by name. */
export const CLOUD_METADATA_ADDRESS = "169.254.169.254";

export function resolveNetworkName(config: BrokerConfig, mode: NetworkMode): string {
  return mode === "deny-all" ? DENY_ALL_NETWORK : config.egressNetworkName;
}

/** True when the mode needs the nftables helper before exec may be accepted. */
export function requiresFirewall(mode: NetworkMode): boolean {
  return mode === "unrestricted";
}

export function describeNetworkPolicy(mode: NetworkMode): string {
  return mode === "deny-all"
    ? "No network namespace connectivity: Docker network `none`, loopback only."
    : "Public IPv4 egress only. Loopback, RFC1918, CGNAT, link-local, cloud metadata, " +
        "Docker bridge ranges, all detected host addresses and configured control " +
        "endpoints are dropped. IPv6 is disabled.";
}
