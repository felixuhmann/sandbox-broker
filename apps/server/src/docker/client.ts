import { createHash } from "node:crypto";

import Docker from "dockerode";

import type { BrokerConfig } from "../config.js";

export type DockerClient = Docker;

/**
 * Connects to the local Docker daemon. Only the broker ever holds this socket;
 * it is equivalent to host root, which is why nothing else in the deployment
 * receives it.
 */
export function createDockerClient(env: NodeJS.ProcessEnv = process.env): DockerClient {
  const host = env["DOCKER_HOST"];
  if (host && /^tcp:\/\//.test(host)) {
    const url = new URL(host);
    return new Docker({ host: url.hostname, port: Number(url.port || 2375) });
  }
  const socketPath = env["DOCKER_SOCKET"] ?? "/var/run/docker.sock";
  return new Docker({ socketPath });
}

export type DockerInfo = {
  serverVersion: string;
  securityOptions: string[];
};

export async function probeDocker(docker: DockerClient): Promise<DockerInfo> {
  const info = (await docker.info()) as {
    ServerVersion?: string;
    SecurityOptions?: string[];
  };
  return {
    serverVersion: info.ServerVersion ?? "unknown",
    securityOptions: info.SecurityOptions ?? [],
  };
}

/** True when the daemon reports both seccomp and AppArmor/SELinux confinement. */
export function hasMandatoryConfinement(info: DockerInfo): boolean {
  const joined = info.securityOptions.join(" ");
  return joined.includes("seccomp") && (joined.includes("apparmor") || joined.includes("selinux"));
}

export type NetworkEnsureResult = { name: string; id: string; created: boolean };

/**
 * Creates (once) the broker-owned egress bridge used by `unrestricted`
 * sandboxes. It is deliberately a dedicated network so a sandbox never shares
 * a segment with the application or its database.
 */
export async function ensureEgressNetwork(
  docker: DockerClient,
  config: BrokerConfig,
): Promise<NetworkEnsureResult> {
  const name = config.egressNetworkName;
  const found = await findNetwork(docker, name);
  if (found) return { name, id: found, created: false };

  let network;
  try {
    network = await createEgressNetwork(docker, config, name);
  } catch (error) {
    // Another broker (or a racing startup) created it between the lookup and
    // the create. That is a success, not a failure.
    if ((error as { statusCode?: number }).statusCode !== 409) throw error;
    const raced = await findNetwork(docker, name);
    if (!raced) throw error;
    return { name, id: raced, created: false };
  }
  return { name, id: network.id, created: true };
}

async function findNetwork(docker: DockerClient, name: string): Promise<string | null> {
  const existing = await docker.listNetworks({ filters: { name: [name] } });
  return existing.find((network) => network.Name === name)?.Id ?? null;
}

function createEgressNetwork(docker: DockerClient, config: BrokerConfig, name: string) {
  return docker.createNetwork({
    Name: name,
    Driver: "bridge",
    CheckDuplicate: true,
    EnableIPv6: false,
    Internal: false,
    Attachable: false,
    Labels: {
      "sandbox-broker.managed-by": "sandbox-broker",
      "sandbox-broker.namespace": config.ownerNamespace,
      "sandbox-broker.role": "egress",
    },
    Options: {
      // Inter-container communication off: sandboxes on this bridge cannot
      // talk to each other, only outward through the gateway.
      "com.docker.network.bridge.enable_icc": "false",
      "com.docker.network.bridge.name": bridgeInterfaceName(name),
    },
  });
}

/**
 * Derives the host bridge interface name for a Docker network.
 *
 * Linux caps interface names at 15 characters, and Docker refuses to create a
 * network whose bridge name is already taken. Truncating the network name
 * collides for anything sharing a long prefix ("sandbox-broker-itest-egress"
 * and "sandbox-broker-smoke-egress"), so the suffix is a hash instead.
 */
export function bridgeInterfaceName(networkName: string): string {
  const digest = createHash("sha256").update(networkName).digest("hex").slice(0, 9);
  return `br-sb-${digest}`;
}
