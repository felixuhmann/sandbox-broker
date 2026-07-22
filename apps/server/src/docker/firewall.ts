import type { NetworkMode } from "@sandbox-broker/contracts";

import type { BrokerConfig } from "../config.js";
import type { Logger } from "../log.js";
import type { DockerClient } from "./client.js";
import { runHelper } from "./firewallHelper.js";
import {
  brokerInterfaceCidrs,
  computeBlockedCidrs,
  dockerNetworkCidrs,
  probeHostAddresses,
} from "./hostAddresses.js";
import { requiresFirewall } from "./network.js";

export class FirewallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FirewallError";
  }
}

export type FirewallDeps = {
  docker: DockerClient;
  config: BrokerConfig;
  logger: Logger;
};

/**
 * Caches the destination list for the lifetime of the process. Host and Docker
 * topology does not change per sandbox, and the probe costs a container start.
 */
export class BlockedDestinations {
  private cached: string[] | null = null;

  constructor(private readonly deps: FirewallDeps) {}

  async resolve(): Promise<string[]> {
    if (this.cached) return this.cached;

    const [hostAddresses, dockerNetworks] = await Promise.all([
      probeHostAddresses(this.deps.docker, this.deps.config),
      dockerNetworkCidrs(this.deps.docker),
    ]);

    const blocked = computeBlockedCidrs({
      hostAddresses,
      dockerNetworks,
      brokerInterfaces: brokerInterfaceCidrs(),
      configured: this.deps.config.extraBlockedCidrs,
    });

    this.deps.logger.info("resolved sandbox egress block list", {
      count: blocked.length,
      hostAddresses: hostAddresses.length,
      dockerNetworks: dockerNetworks.length,
    });
    this.cached = blocked;
    return blocked;
  }

  /** Forces a re-probe, e.g. after the host gains an address. */
  invalidate(): void {
    this.cached = null;
  }
}

/**
 * Installs and independently verifies the egress policy in a sandbox's network
 * namespace.
 *
 * Must be called after *every* container start, because stopping a container
 * destroys its network namespace along with any rules in it. The broker refuses
 * to run commands until this has succeeded.
 */
export async function applyAndVerifyPolicy(
  deps: FirewallDeps,
  input: { sandboxId: string; containerId: string; blockedCidrs: readonly string[] },
): Promise<void> {
  const { sandboxId, containerId, blockedCidrs } = input;
  if (blockedCidrs.length === 0) {
    throw new FirewallError("Refusing to apply an empty egress policy.");
  }

  const env = { SANDBOX_BROKER_BLOCKED_CIDRS: blockedCidrs.join(",") };
  const networkMode = `container:${containerId}`;

  const applied = await runHelper(deps.docker, deps.config, {
    sandboxId,
    mode: "apply",
    networkMode,
    // Exactly the capabilities nftables needs, and only in the sandbox's
    // namespace. The sandbox itself never holds these.
    capabilities: ["NET_ADMIN", "NET_RAW"],
    env,
  });
  if (applied.exitCode !== 0 || !applied.output.includes("POLICY_APPLIED")) {
    throw new FirewallError(
      `Failed to apply sandbox network policy (exit ${applied.exitCode}): ${summarize(applied.output)}`,
    );
  }

  // Verification runs as a separate helper so the readback is independent of
  // the process that wrote the rules.
  const verified = await runHelper(deps.docker, deps.config, {
    sandboxId,
    mode: "verify",
    networkMode,
    capabilities: ["NET_ADMIN"],
    env,
  });
  if (verified.exitCode !== 0 || !verified.output.includes("POLICY_OK")) {
    throw new FirewallError(
      `Sandbox network policy verification failed (exit ${verified.exitCode}): ${summarize(verified.output)}`,
    );
  }

  deps.logger.info("sandbox network policy verified", {
    sandboxId,
    blockedCidrs: blockedCidrs.length,
  });
}

/**
 * Ensures a sandbox is network-ready. `deny-all` needs nothing installed: the
 * `none` network has no path to anywhere by construction.
 */
export async function ensureNetworkPolicy(
  deps: FirewallDeps,
  input: {
    sandboxId: string;
    containerId: string;
    networkMode: NetworkMode;
    destinations: BlockedDestinations;
  },
): Promise<void> {
  if (!requiresFirewall(input.networkMode)) return;
  const blockedCidrs = await input.destinations.resolve();
  await applyAndVerifyPolicy(deps, {
    sandboxId: input.sandboxId,
    containerId: input.containerId,
    blockedCidrs,
  });
}

function summarize(output: string): string {
  return output.replace(/\s+/g, " ").trim().slice(0, 500);
}
