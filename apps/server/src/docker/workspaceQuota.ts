import { randomUUID } from "node:crypto";

import { WORKSPACE_ROOT, type QuotaMode } from "@sandbox-broker/contracts";
import type { Container } from "dockerode";

import type { BrokerConfig } from "../config.js";
import type { WorkspaceQuotaReport } from "../app.js";
import { BrokerError } from "../errors.js";
import type { Logger } from "../log.js";
import type { DockerClient } from "./client.js";
import { execCapture } from "./execCapture.js";

export function quotaBytes(limits: { workspaceMiB: number }): number {
  return limits.workspaceMiB * 1024 * 1024;
}

/** Parses `du -sb` output. Returns `null` when the value cannot be trusted. */
export function parseDuBytes(output: string): number | null {
  const first = output.trim().split("\n")[0] ?? "";
  const match = /^(\d+)\b/.exec(first.trim());
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/**
 * `usedBytes === null` means the measurement failed. That is treated as a
 * breach: refusing a write is recoverable, silently blowing past the limit is
 * not.
 */
export function wouldExceedQuota(input: {
  limits: { workspaceMiB: number };
  usedBytes: number | null;
  incomingBytes: number;
}): boolean {
  if (input.usedBytes === null) return true;
  return input.usedBytes + input.incomingBytes > quotaBytes(input.limits);
}

export async function measureWorkspaceUsage(container: Container): Promise<number | null> {
  const result = await execCapture(container, [
    "/bin/sh",
    "-c",
    `du -sb ${WORKSPACE_ROOT} 2>/dev/null || true`,
  ]).catch(() => null);
  return result ? parseDuBytes(result.stdout) : null;
}

export async function assertWorkspaceQuota(
  container: Container,
  limits: { workspaceMiB: number },
  incomingBytes: number,
): Promise<void> {
  const usedBytes = await measureWorkspaceUsage(container);
  if (wouldExceedQuota({ limits, usedBytes, incomingBytes })) {
    throw new BrokerError(
      "conflict",
      `Workspace quota of ${limits.workspaceMiB} MiB would be exceeded.`,
      { workspaceMiB: limits.workspaceMiB, usedBytes },
    );
  }
}

/**
 * Samples workspace usage while a command runs and aborts it on breach.
 *
 * This is the honest enforcement mechanism in `watchdog` mode: usage can
 * momentarily exceed the limit between samples, but a runaway write is stopped
 * rather than allowed to fill the host.
 */
export class QuotaWatchdog {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly container: Container,
    private readonly limits: { workspaceMiB: number },
    private readonly onBreach: (usedBytes: number) => void,
    private readonly intervalMs = 2_000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void measureWorkspaceUsage(this.container).then((usedBytes) => {
        if (usedBytes !== null && usedBytes > quotaBytes(this.limits)) {
          this.stop();
          this.onBreach(usedBytes);
        }
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

export type QuotaEnforcement = WorkspaceQuotaReport;

const WATCHDOG_DETAIL =
  "Best-effort: Docker's local volume driver provides no portable per-volume byte " +
  "quota, so the broker measures usage before and after each command and samples it " +
  "with a watchdog during execution. Usage can briefly exceed the limit between " +
  "samples. See docs/workspace-quota.md.";

/**
 * Determines what the configured quota mode can actually deliver on this host.
 *
 * In `hard` mode this genuinely tries to overflow a probe volume created with
 * the configured driver options; if the write succeeds, the host cannot enforce
 * a byte ceiling and readiness must fail rather than the broker claiming one.
 */
export async function probeQuotaEnforcement(
  docker: DockerClient,
  config: BrokerConfig,
  logger: Logger,
): Promise<QuotaEnforcement> {
  if (config.quotaMode === "watchdog") {
    return { mode: "watchdog", enforced: false, detail: WATCHDOG_DETAIL };
  }

  const volumeName = `sandbox-broker-quota-probe-${randomUUID()}`;
  let container: Container | null = null;
  try {
    await docker.createVolume({
      Name: volumeName,
      Driver: config.volumeDriver,
      DriverOpts: { ...config.volumeOpts },
      Labels: {
        "sandbox-broker.managed-by": "sandbox-broker",
        "sandbox-broker.namespace": config.ownerNamespace,
        "sandbox-broker.role": "quota-probe",
      },
    });

    container = await docker.createContainer({
      Image: config.sandboxImage,
      // 8 MiB of writes into a probe volume. If the driver enforces a smaller
      // size this fails; if it succeeds, there is no hard quota.
      Cmd: ["/bin/sh", "-c", "dd if=/dev/zero of=/probe/fill bs=1M count=8 2>&1; echo rc=$?"],
      Entrypoint: [],
      User: "0:0",
      HostConfig: {
        Mounts: [{ Type: "volume", Source: volumeName, Target: "/probe", ReadOnly: false }],
        NetworkMode: "none",
        AutoRemove: false,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        Memory: 256 * 1024 * 1024,
        PidsLimit: 64,
      },
    });
    await container.start();
    await container.wait();
    const logs = await container.logs({ stdout: true, stderr: true });
    const output = Buffer.isBuffer(logs) ? logs.toString("utf8") : String(logs);
    const wroteEverything = /rc=0/.test(output);

    return wroteEverything
      ? {
          mode: "hard",
          enforced: false,
          detail:
            `Volume driver ${config.volumeDriver} accepted an 8 MiB write into a probe volume ` +
            "created with the configured options, so it does not enforce a byte ceiling. " +
            "Use SANDBOX_BROKER_QUOTA_MODE=watchdog or configure a driver that enforces size.",
        }
      : {
          mode: "hard",
          enforced: true,
          detail: `Volume driver ${config.volumeDriver} refused a write past the configured size.`,
        };
  } catch (error) {
    logger.warn("workspace quota probe failed", { error });
    return {
      mode: "hard",
      enforced: false,
      detail: `Quota probe could not run: ${(error as Error).message}`,
    };
  } finally {
    await container?.remove({ force: true }).catch(() => undefined);
    await docker
      .getVolume(volumeName)
      .remove({ force: true })
      .catch(() => undefined);
  }
}

/** Readiness fails when `hard` was promised but cannot be delivered. */
export function quotaReadinessCheck(
  mode: QuotaMode,
  enforcement: QuotaEnforcement,
): { name: string; ok: boolean; detail: string } {
  const ok = mode !== "hard" || enforcement.enforced;
  return { name: "workspace-quota", ok, detail: enforcement.detail };
}
