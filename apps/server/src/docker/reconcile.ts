import type { BrokerConfig } from "../config.js";
import type { Logger } from "../log.js";
import type { DockerClient } from "./client.js";
import { removeStaleHelpers } from "./firewallHelper.js";
import { isBrokerOwned, labelRole, ownershipFilters, parseSandboxLabels } from "./labels.js";

export type ReconcileReport = {
  sandboxes: number;
  restarted: number;
  failed: number;
  staleHelpersRemoved: number;
};

export type ReconcileTarget = {
  sandboxId: string;
  containerId: string;
  running: boolean;
};

/**
 * Lists the sandboxes this broker namespace owns.
 *
 * Ownership is decided by labels, and the Docker-side filter is re-checked in
 * code: a container that does not carry both the managed-by marker and this
 * namespace is never touched, so unrelated workloads on the same host — or
 * another broker's sandboxes — are invisible to reconciliation.
 */
export async function listOwnedSandboxes(
  docker: DockerClient,
  config: BrokerConfig,
): Promise<ReconcileTarget[]> {
  const summaries = await docker.listContainers({
    all: true,
    filters: ownershipFilters(config.ownerNamespace, "sandbox"),
  });

  const targets: ReconcileTarget[] = [];
  for (const summary of summaries) {
    const labels = summary.Labels ?? {};
    if (!isBrokerOwned(labels, config.ownerNamespace)) continue;
    if (labelRole(labels) !== "sandbox") continue;
    const parsed = parseSandboxLabels(labels);
    if (!parsed) continue;
    targets.push({
      sandboxId: parsed.id,
      containerId: summary.Id,
      running: summary.State === "running",
    });
  }
  return targets;
}

/**
 * Brings Docker back in line with what the broker can guarantee.
 *
 * A sandbox found running at startup belongs to a broker process that is gone.
 * A command may still be executing inside it and its network policy cannot be
 * trusted, so it is restarted and its policy re-applied before anything else
 * is accepted. Workspaces are volumes and are untouched.
 */
export async function reconcile(
  docker: DockerClient,
  config: BrokerConfig,
  logger: Logger,
  handlers: {
    restartAndSecure: (target: ReconcileTarget) => Promise<void>;
  },
): Promise<ReconcileReport> {
  const staleHelpersRemoved = await removeStaleHelpers(docker, config);
  if (staleHelpersRemoved > 0) {
    logger.info("removed stale firewall helpers", { removed: staleHelpersRemoved });
  }

  const targets = await listOwnedSandboxes(docker, config);
  let restarted = 0;
  let failed = 0;

  for (const target of targets) {
    if (!target.running) continue;
    try {
      await handlers.restartAndSecure(target);
      restarted += 1;
    } catch (error) {
      failed += 1;
      // One unrecoverable sandbox must not stop the broker from serving the
      // rest; it stays visible in `error` state instead.
      logger.error("could not reconcile sandbox", { sandboxId: target.sandboxId, error });
    }
  }

  const report = { sandboxes: targets.length, restarted, failed, staleHelpersRemoved };
  logger.info("reconciled broker state from Docker", report);
  return report;
}
