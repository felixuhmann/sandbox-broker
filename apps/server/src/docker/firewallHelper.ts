import { randomUUID } from "node:crypto";

import type { BrokerConfig } from "../config.js";
import type { DockerClient } from "./client.js";
import { buildHelperLabels, ownershipFilters } from "./labels.js";

export type HelperMode = "apply" | "verify" | "host-addresses" | "capture";

export type HelperRun = {
  sandboxId: string;
  mode: HelperMode;
  /** `container:<id>` for policy work, `host` only for the address probe. */
  networkMode: string;
  capabilities: readonly string[];
  env?: Record<string, string>;
  timeoutMs?: number;
};

export type HelperResult = { exitCode: number; output: string };

const DEFAULT_HELPER_TIMEOUT_MS = 60_000;

/**
 * Runs the trusted firewall helper once and removes it.
 *
 * The helper is short-lived by construction: it is started, waited on, its
 * output collected, and then deleted, so no long-running privileged container
 * accompanies a sandbox.
 */
export async function runHelper(
  docker: DockerClient,
  config: BrokerConfig,
  run: HelperRun,
): Promise<HelperResult> {
  const container = await docker.createContainer({
    name: `sandbox-broker-fw-${run.mode}-${randomUUID()}`,
    Image: config.firewallImage,
    Cmd: [run.mode],
    // Root is needed to program nftables in the target namespace; the helper
    // runs a fixed script and never touches caller input.
    User: "0:0",
    Env: Object.entries(run.env ?? {}).map(([key, value]) => `${key}=${value}`),
    Labels: buildHelperLabels(config, run.sandboxId),
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    HostConfig: {
      NetworkMode: run.networkMode,
      Privileged: false,
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      CapAdd: [...run.capabilities],
      SecurityOpt: ["no-new-privileges:true"],
      Tmpfs: { "/tmp": "rw,nosuid,nodev,size=32m" },
      Binds: [],
      Memory: 128 * 1024 * 1024,
      PidsLimit: 128,
      AutoRemove: false,
      RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
      PortBindings: {},
      PublishAllPorts: false,
    },
  });

  try {
    const stream = await container.attach({ stream: true, stdout: true, stderr: true });
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));

    await container.start();

    const timeoutMs = run.timeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS;
    const waited = await Promise.race([
      container.wait(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);

    if (waited === null) {
      await container.stop({ t: 1 }).catch(() => undefined);
      return { exitCode: 124, output: demultiplex(Buffer.concat(chunks)) };
    }

    // Give the attached stream a tick to flush the last frames.
    await new Promise((resolve) => setTimeout(resolve, 50));
    return {
      exitCode: (waited as { StatusCode?: number }).StatusCode ?? -1,
      output: demultiplex(Buffer.concat(chunks)),
    };
  } finally {
    await container.remove({ force: true }).catch(() => undefined);
  }
}

/** Removes helper containers left behind by a crashed broker. */
export async function removeStaleHelpers(
  docker: DockerClient,
  config: BrokerConfig,
): Promise<number> {
  const containers = await docker.listContainers({
    all: true,
    filters: ownershipFilters(config.ownerNamespace, "firewall-helper"),
  });
  let removed = 0;
  for (const summary of containers) {
    try {
      await docker.getContainer(summary.Id).remove({ force: true });
      removed += 1;
    } catch {
      /* already gone */
    }
  }
  return removed;
}

/** Strips Docker's 8-byte stream multiplexing headers. */
export function demultiplex(raw: Buffer): string {
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= raw.length) {
    const size = raw.readUInt32BE(offset + 4);
    if (size < 0 || offset + 8 + size > raw.length) break;
    parts.push(raw.subarray(offset + 8, offset + 8 + size));
    offset += 8 + size;
  }
  // Non-multiplexed output (TTY mode) falls through unchanged.
  return parts.length > 0 ? Buffer.concat(parts).toString("utf8") : raw.toString("utf8");
}
