import { WORKSPACE_ROOT, type CreateSandboxRequest } from "@sandbox-broker/contracts";
import type Docker from "dockerode";

import type { BrokerConfig } from "../config.js";
import { buildSandboxLabels } from "./labels.js";

/** Fixed UID/GID baked into the sandbox image. Requests cannot change it. */
export const SANDBOX_UID = 10_001;
export const SANDBOX_GID = 10_001;

/** Writable tmpfs mounts. Both noexec so dropped payloads cannot be run from them. */
const TMPFS = {
  "/tmp": "rw,noexec,nosuid,nodev,size=128m",
  "/run/sandbox-broker": "rw,noexec,nosuid,nodev,size=16m",
} as const;

export function sandboxContainerName(id: string): string {
  return `sandbox-broker-sbx-${id}`;
}

export function workspaceVolumeName(id: string): string {
  return `sandbox-broker-ws-${id}`;
}

/**
 * `CgroupnsMode` is a documented Docker Engine field that @types/dockerode does
 * not declare. Extending the type keeps the option type-checked rather than
 * casting the whole HostConfig to `any`.
 */
type HardenedHostConfig = NonNullable<Docker.ContainerCreateOptions["HostConfig"]> & {
  CgroupnsMode?: "private" | "host";
};

export type SandboxContainerCreateOptions = Omit<Docker.ContainerCreateOptions, "HostConfig"> & {
  HostConfig: HardenedHostConfig;
};

export type SandboxCreateInput = {
  id: string;
  createdAt: string;
  config: BrokerConfig;
  request: CreateSandboxRequest;
};

/**
 * Builds the one and only container shape this broker will create.
 *
 * Everything here is derived from the broker's own configuration plus the four
 * fields of {@link CreateSandboxRequest}. No part of the request can select an
 * image, mount, capability, device, namespace, user or privileged flag — that
 * is the core security property of the service.
 */
export function buildSandboxCreateOptions(
  input: SandboxCreateInput,
): SandboxContainerCreateOptions {
  const { id, config, request } = input;
  const { limits } = request;
  const memoryBytes = limits.memoryMiB * 1024 * 1024;

  return {
    name: sandboxContainerName(id),
    Image: config.sandboxImage,
    Hostname: "sandbox",
    User: `${SANDBOX_UID}:${SANDBOX_GID}`,
    WorkingDir: WORKSPACE_ROOT,
    // Inert PID 1 under tini; the container start path executes nothing that
    // originated with the caller.
    Entrypoint: ["/usr/bin/tini", "--", "/usr/local/bin/sandbox-entrypoint"],
    Cmd: [],
    Env: [
      `HOME=${WORKSPACE_ROOT}`,
      "LANG=C.UTF-8",
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "PYTHONDONTWRITEBYTECODE=1",
    ],
    Labels: buildSandboxLabels(input),
    AttachStdin: false,
    AttachStdout: false,
    AttachStderr: false,
    OpenStdin: false,
    StdinOnce: false,
    Tty: false,
    ExposedPorts: {},
    HostConfig: {
      Privileged: false,
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      CapAdd: [],
      // Default seccomp and AppArmor profiles stay in force; only
      // no-new-privileges is added.
      SecurityOpt: ["no-new-privileges:true"],
      PidsLimit: limits.pids,
      Memory: memoryBytes,
      // Equal to Memory: swap is disabled rather than silently doubled.
      MemorySwap: memoryBytes,
      MemorySwappiness: 0,
      NanoCpus: limits.cpuCores * 1_000_000_000,
      NetworkMode: resolveNetworkMode(config, request),
      Tmpfs: { ...TMPFS },
      Binds: [],
      Mounts: [
        {
          Type: "volume",
          Source: workspaceVolumeName(id),
          Target: WORKSPACE_ROOT,
          ReadOnly: false,
        },
      ],
      Devices: [],
      DeviceCgroupRules: [],
      // No host namespace sharing of any kind.
      IpcMode: "private",
      CgroupnsMode: "private",
      PortBindings: {},
      PublishAllPorts: false,
      AutoRemove: false,
      RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
      // IPv6 is out of scope for v1 policy enforcement, so it is switched off
      // in the sandbox network namespace and verified after start.
      Sysctls: {
        "net.ipv6.conf.all.disable_ipv6": "1",
        "net.ipv6.conf.default.disable_ipv6": "1",
      },
      Ulimits: [{ Name: "nofile", Soft: 4096, Hard: 8192 }],
    },
  };
}

/**
 * `deny-all` uses Docker's `none` network, which gives the container a
 * namespace with only loopback. `unrestricted` attaches the broker-owned
 * egress bridge, which is never the application or database network.
 */
export function resolveNetworkMode(
  config: BrokerConfig,
  request: Pick<CreateSandboxRequest, "networkMode">,
): string {
  return request.networkMode === "deny-all" ? "none" : config.egressNetworkName;
}
