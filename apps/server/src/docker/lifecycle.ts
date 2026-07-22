import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";

import {
  type CreateSandboxRequest,
  type ExecEvent,
  type ExecRequest,
  type Sandbox,
} from "@sandbox-broker/contracts";
import type { Container } from "dockerode";

import type { ReadyCheck, SandboxService, WorkspaceQuotaReport } from "../app.js";
import type { BrokerConfig } from "../config.js";
import { BrokerError } from "../errors.js";
import type { Logger } from "../log.js";
import {
  ensureEgressNetwork,
  hasMandatoryConfinement,
  probeDocker,
  type DockerClient,
} from "./client.js";
import {
  buildSandboxCreateOptions,
  sandboxContainerName,
  workspaceVolumeName,
} from "./createSandbox.js";
import { ExecutionRegistry, reserveExecution, runExec } from "./exec.js";
import { BlockedDestinations, ensureNetworkPolicy, type FirewallDeps } from "./firewall.js";
import { deleteWorkspacePath, readWorkspaceFile, writeWorkspaceFile } from "./files.js";
import { checkRequiredImages } from "./images.js";
import { toSandbox, type SandboxView } from "./inspectSandbox.js";
import { hashRef, LABEL, ownershipFilters, parseSandboxLabels } from "./labels.js";
import { requiresFirewall } from "./network.js";
import { reconcile, type ReconcileReport } from "./reconcile.js";
import {
  probeQuotaEnforcement,
  quotaBytes,
  quotaReadinessCheck,
  QuotaWatchdog,
  type QuotaEnforcement,
} from "./workspaceQuota.js";

export type ServiceDeps = {
  docker: DockerClient;
  config: BrokerConfig;
  logger: Logger;
};

/**
 * The Docker-backed implementation of the control API.
 *
 * All durable state lives in Docker labels, so a restarted broker rebuilds its
 * view by listing containers rather than reading a database. The only in-memory
 * state is which sandboxes currently have a *verified* network policy, and that
 * is deliberately not persisted: a namespace is destroyed by a stop, so after a
 * restart the answer must be "unknown" until the policy is re-applied.
 */
export class DockerSandboxService implements SandboxService {
  private readonly registry = new ExecutionRegistry();
  private readonly destinations: BlockedDestinations;
  private readonly firewallDeps: FirewallDeps;
  private readonly policyReady = new Set<string>();
  private quotaEnforcement: QuotaEnforcement | null = null;

  constructor(private readonly deps: ServiceDeps) {
    this.firewallDeps = { docker: deps.docker, config: deps.config, logger: deps.logger };
    this.destinations = new BlockedDestinations(this.firewallDeps);
  }

  // ---------------------------------------------------------------- readiness

  async readyChecks(): Promise<ReadyCheck[]> {
    const checks: ReadyCheck[] = [];

    try {
      const info = await probeDocker(this.deps.docker);
      checks.push({ name: "docker", ok: true, detail: `Engine ${info.serverVersion}` });
      checks.push({
        name: "kernel-confinement",
        ok: hasMandatoryConfinement(info),
        detail: info.securityOptions.join(", ") || "no security options reported",
      });
    } catch (error) {
      checks.push({ name: "docker", ok: false, detail: (error as Error).message.slice(0, 400) });
      return checks;
    }

    for (const image of await checkRequiredImages(this.deps.docker, this.deps.config)) {
      checks.push({
        name: `image:${image.reference}`,
        ok: image.present,
        detail: image.present ? (image.id ?? "") : "image is not present on this host",
      });
    }

    const quota = await this.workspaceQuotaReport();
    checks.push(quotaReadinessCheck(this.deps.config.quotaMode, quota));

    try {
      await this.destinations.resolve();
      checks.push({ name: "egress-policy", ok: true, detail: "block list resolved" });
    } catch (error) {
      checks.push({
        name: "egress-policy",
        ok: false,
        detail: (error as Error).message.slice(0, 400),
      });
    }

    return checks;
  }

  async workspaceQuotaReport(): Promise<WorkspaceQuotaReport> {
    this.quotaEnforcement ??= await probeQuotaEnforcement(
      this.deps.docker,
      this.deps.config,
      this.deps.logger,
    );
    return this.quotaEnforcement;
  }

  // ------------------------------------------------------------------ startup

  /**
   * Rebuilds state from Docker and makes it safe to serve requests.
   *
   * Any sandbox found running belongs to a broker that is no longer here, which
   * means a command may still be executing inside it. Restarting is what
   * guarantees those orphans are gone before new work is accepted.
   */
  async initialize(): Promise<ReconcileReport> {
    await ensureEgressNetwork(this.deps.docker, this.deps.config);
    this.registry.releaseAll();
    this.policyReady.clear();

    return reconcile(this.deps.docker, this.deps.config, this.deps.logger, {
      restartAndSecure: async (target) => {
        const container = this.deps.docker.getContainer(target.containerId);
        await container.restart({ t: 5 });
        const view = await this.viewOf(container);
        await this.applyPolicy(view.sandbox, container);
      },
    });
  }

  // ----------------------------------------------------------------- lifecycle

  async create(request: CreateSandboxRequest): Promise<{ sandbox: Sandbox; created: boolean }> {
    const existing = await this.findByIdempotencyKey(request.idempotencyKey);
    if (existing) {
      assertSameConfiguration(existing.sandbox, request);
      return { sandbox: existing.sandbox, created: false };
    }

    const id = randomUUID();
    const createdAt = new Date().toISOString();

    await this.deps.docker.createVolume({
      Name: workspaceVolumeName(id),
      Driver: this.deps.config.volumeDriver,
      DriverOpts: { ...this.deps.config.volumeOpts },
      Labels: {
        [LABEL.managedBy]: "sandbox-broker",
        [LABEL.namespace]: this.deps.config.ownerNamespace,
        [LABEL.role]: "workspace",
        [LABEL.sandboxId]: id,
      },
    });

    let container: Container;
    try {
      container = await this.deps.docker.createContainer(
        buildSandboxCreateOptions({ id, createdAt, config: this.deps.config, request }),
      );
    } catch (error) {
      await this.removeVolume(id);
      throw error;
    }

    try {
      await container.start();
      const view = await this.viewOf(container);
      await this.applyPolicy(view.sandbox, container);
      return { sandbox: (await this.viewOf(container)).sandbox, created: true };
    } catch (error) {
      // Never leave a sandbox running without a verified policy.
      await container.remove({ force: true }).catch(() => undefined);
      await this.removeVolume(id);
      throw error;
    }
  }

  async list(): Promise<Sandbox[]> {
    return (await this.listViews()).map((view) => view.sandbox);
  }

  async get(id: string): Promise<Sandbox> {
    return (await this.requireView(id)).sandbox;
  }

  async start(id: string): Promise<Sandbox> {
    const view = await this.requireView(id);
    const container = this.deps.docker.getContainer(view.containerId);
    if (!view.running) await container.start();
    // A restart destroyed the old namespace, so the policy is gone with it.
    this.policyReady.delete(id);
    await this.applyPolicy(view.sandbox, container);
    return (await this.viewOf(container)).sandbox;
  }

  async stop(id: string): Promise<Sandbox> {
    const view = await this.requireView(id);
    const container = this.deps.docker.getContainer(view.containerId);
    if (view.running) await container.stop({ t: 10 }).catch(() => undefined);
    this.policyReady.delete(id);
    return (await this.viewOf(container)).sandbox;
  }

  async remove(id: string): Promise<Sandbox> {
    const view = await this.requireView(id);
    const container = this.deps.docker.getContainer(view.containerId);
    await container.remove({ force: true, v: false }).catch(() => undefined);
    // The workspace outlives stop() but not an explicit delete.
    await this.removeVolume(id);
    this.policyReady.delete(id);
    return { ...view.sandbox, state: "deleted", updatedAt: new Date().toISOString() };
  }

  // ---------------------------------------------------------------------- exec

  /**
   * Validates state and claims the execution slot eagerly, so a stopped sandbox
   * or a concurrent execution fails with a status code before any of the
   * response has been committed. The returned iterable must be consumed.
   */
  async exec(
    id: string,
    request: ExecRequest,
    signal: AbortSignal,
  ): Promise<AsyncIterable<ExecEvent>> {
    const view = await this.requireView(id);
    if (view.sandbox.state !== "started") {
      throw new BrokerError(
        "sandbox_error",
        `Sandbox is ${view.sandbox.state}; start it before running commands.`,
      );
    }

    const container = this.deps.docker.getContainer(view.containerId);
    const reservation = reserveExecution(this.registry, id);

    const abort = new AbortController();
    signal.addEventListener("abort", () => abort.abort(), { once: true });

    const watchdog = new QuotaWatchdog(container, view.sandbox.limits, (usedBytes) => {
      this.deps.logger.warn("workspace quota breached during execution", {
        sandboxId: id,
        usedBytes,
        limitBytes: quotaBytes(view.sandbox.limits),
      });
      abort.abort();
    });

    const execDeps = {
      config: this.deps.config,
      logger: this.deps.logger,
      registry: this.registry,
      recoverSandbox: async (sandboxId: string) => {
        await this.recover(sandboxId);
      },
    };

    async function* iterate(): AsyncGenerator<ExecEvent> {
      watchdog.start();
      try {
        yield* runExec(execDeps, {
          sandboxId: id,
          container,
          request,
          signal: abort.signal,
          reservation,
        });
      } finally {
        watchdog.stop();
        reservation.release();
      }
    }
    return iterate();
  }

  /** Restart + re-apply policy. Used after a timeout, cancellation or crash. */
  private async recover(id: string): Promise<void> {
    const view = await this.requireView(id);
    const container = this.deps.docker.getContainer(view.containerId);
    this.policyReady.delete(id);
    await container.restart({ t: 5 });
    await this.applyPolicy(view.sandbox, container);
  }

  // --------------------------------------------------------------------- files

  async readFile(id: string, path: string): Promise<Readable> {
    const view = await this.requireRunning(id);
    return readWorkspaceFile(this.deps.docker.getContainer(view.containerId), path);
  }

  async writeFile(id: string, path: string, body: Readable): Promise<void> {
    const view = await this.requireRunning(id);
    await writeWorkspaceFile(this.deps.docker.getContainer(view.containerId), path, body, {
      limits: view.sandbox.limits,
      maxBytes: this.deps.config.maxUploadBytes,
    });
  }

  async deleteFile(id: string, path: string, recursive: boolean): Promise<void> {
    const view = await this.requireRunning(id);
    await deleteWorkspacePath(this.deps.docker.getContainer(view.containerId), path, recursive);
  }

  // ------------------------------------------------------------------ internals

  private async applyPolicy(sandbox: Sandbox, container: Container): Promise<void> {
    const info = await container.inspect();
    await ensureNetworkPolicy(this.firewallDeps, {
      sandboxId: sandbox.id,
      containerId: info.Id,
      networkMode: sandbox.networkMode,
      destinations: this.destinations,
    });
    this.policyReady.add(sandbox.id);
  }

  private async listViews(): Promise<SandboxView[]> {
    const summaries = await this.deps.docker.listContainers({
      all: true,
      filters: ownershipFilters(this.deps.config.ownerNamespace, "sandbox"),
    });

    const views: SandboxView[] = [];
    for (const summary of summaries) {
      try {
        const view = await this.viewOf(this.deps.docker.getContainer(summary.Id));
        views.push(view);
      } catch {
        // Disappeared between listing and inspecting; nothing to report.
      }
    }
    return views;
  }

  private async viewOf(container: Container): Promise<SandboxView> {
    const info = await container.inspect();
    const labels = parseSandboxLabels(info.Config?.Labels ?? {});
    if (!labels) throw new BrokerError("not_found", "Container is not a broker sandbox.");
    // deny-all needs nothing installed, so it is policy-ready as soon as it
    // runs. unrestricted is only ready once the helper has verified the rules
    // in this specific namespace.
    const view = toSandbox(info, {
      policyReady: requiresFirewall(labels.networkMode) ? this.policyReady.has(labels.id) : true,
    });
    if (!view) throw new BrokerError("not_found", "Container is not a broker sandbox.");
    return view;
  }

  private async requireView(id: string): Promise<SandboxView> {
    const summaries = await this.deps.docker.listContainers({
      all: true,
      filters: {
        label: [
          ...ownershipFilters(this.deps.config.ownerNamespace, "sandbox").label,
          `${LABEL.sandboxId}=${id}`,
        ],
      },
    });
    const summary = summaries[0];
    if (!summary) throw new BrokerError("not_found", "No broker-owned sandbox with this id.");
    return this.viewOf(this.deps.docker.getContainer(summary.Id));
  }

  private async requireRunning(id: string): Promise<SandboxView> {
    const view = await this.requireView(id);
    if (!view.running) {
      throw new BrokerError("sandbox_error", `Sandbox is ${view.sandbox.state}; start it first.`);
    }
    return view;
  }

  private async findByIdempotencyKey(key: string): Promise<SandboxView | null> {
    const summaries = await this.deps.docker.listContainers({
      all: true,
      filters: {
        label: [
          ...ownershipFilters(this.deps.config.ownerNamespace, "sandbox").label,
          `${LABEL.idempotencyKeyHash}=${hashRef(key)}`,
        ],
      },
    });
    const summary = summaries[0];
    if (!summary) return null;
    return this.viewOf(this.deps.docker.getContainer(summary.Id)).catch(() => null);
  }

  private async removeVolume(id: string): Promise<void> {
    await this.deps.docker
      .getVolume(workspaceVolumeName(id))
      .remove({ force: true })
      .catch(() => undefined);
  }

  /** Exposed for diagnostics and tests. */
  containerNameFor(id: string): string {
    return sandboxContainerName(id);
  }
}

/**
 * An idempotency key may only be replayed with an identical configuration.
 * Silently returning a sandbox with different limits or a different network
 * mode would be a policy downgrade.
 */
function assertSameConfiguration(existing: Sandbox, request: CreateSandboxRequest): void {
  const differs =
    existing.networkMode !== request.networkMode ||
    existing.limits.cpuCores !== request.limits.cpuCores ||
    existing.limits.memoryMiB !== request.limits.memoryMiB ||
    existing.limits.pids !== request.limits.pids ||
    existing.limits.workspaceMiB !== request.limits.workspaceMiB ||
    existing.ownerRefHash !== hashRef(request.ownerRef);

  if (differs) {
    throw new BrokerError(
      "conflict",
      "This idempotency key already refers to a sandbox with a different configuration.",
      { sandboxId: existing.id },
    );
  }
}
