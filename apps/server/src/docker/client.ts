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
  const existing = await docker.listNetworks({ filters: { name: [name] } });
  const exact = existing.find((network) => network.Name === name);
  if (exact) return { name, id: exact.Id, created: false };

  const network = await docker.createNetwork({
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
      "com.docker.network.bridge.name": truncateBridgeName(name),
    },
  });
  return { name, id: network.id, created: true };
}

/** Linux interface names are capped at 15 characters. */
function truncateBridgeName(name: string): string {
  const sanitized = `br-${name.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)}`;
  return sanitized.slice(0, 15);
}
