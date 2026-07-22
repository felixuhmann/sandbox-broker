import type { BrokerConfig } from "../config.js";
import { BrokerError } from "../errors.js";
import type { DockerClient } from "./client.js";
import { isBrokerOwned, labelRole, ownershipFilters } from "./labels.js";

/**
 * How many sandboxes this broker namespace currently owns.
 *
 * "Owned" is decided by labels and re-checked in code, so another broker's
 * sandboxes, another namespace's sandboxes, firewall helpers and unrelated
 * host workloads never count against this deployment's capacity. A stopped
 * sandbox still counts: it holds a container and a workspace volume until it
 * is explicitly deleted.
 */
export async function countOwnedSandboxes(
  docker: DockerClient,
  config: BrokerConfig,
): Promise<number> {
  const summaries = await docker.listContainers({
    all: true,
    filters: ownershipFilters(config.ownerNamespace, "sandbox"),
  });

  let owned = 0;
  for (const summary of summaries) {
    const labels = summary.Labels ?? {};
    if (!isBrokerOwned(labels, config.ownerNamespace)) continue;
    if (labelRole(labels) !== "sandbox") continue;
    owned += 1;
  }
  return owned;
}

/** A reserved sandbox slot. Releasing it is idempotent. */
export type SandboxSlot = { release(): void };

/**
 * Admission control for sandbox creation.
 *
 * Docker's own count is authoritative but lags: a container is only listed
 * once it has been created, and creation happens well after the decision to
 * create it. Racing requests would therefore all read the same pre-create
 * count and all be admitted. The gate closes that window by serializing the
 * count-and-decide step and holding a reservation for each admitted request
 * until its container exists — so `Docker count + reservations` is what every
 * decision is made against, and the cap holds however requests interleave.
 *
 * This is a per-process gate. It bounds one broker; two brokers sharing a
 * namespace would each enforce their own cap, which is why a namespace is
 * owned by exactly one broker.
 */
export class SandboxAdmissionGate {
  /** Serializes count-and-decide; admissions never overlap. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Admitted creates whose container Docker cannot see yet. */
  private reserved = 0;

  constructor(
    readonly maxSandboxes: number,
    private readonly countExisting: () => Promise<number>,
  ) {}

  /**
   * Reserves a slot, or throws {@link BrokerError} `rate_limited` (429) when
   * the namespace is at capacity. Throwing here — before any volume or
   * container is created — is what keeps a rejected request free of side
   * effects. The caller must release the slot once the container exists, and
   * on every failure path.
   */
  async admit(): Promise<SandboxSlot> {
    return this.serialize(async () => {
      const inUse = (await this.countExisting()) + this.reserved;
      if (inUse >= this.maxSandboxes) {
        throw new BrokerError(
          "rate_limited",
          `Sandbox capacity reached: ${inUse} of ${this.maxSandboxes} sandboxes are in use. ` +
            "Delete a sandbox or raise SANDBOX_BROKER_MAX_SANDBOXES.",
          { maxSandboxes: this.maxSandboxes, inUse },
        );
      }

      this.reserved += 1;
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          this.reserved -= 1;
        },
      };
    });
  }

  /** Current utilisation, for readiness reporting. Consumes no slot. */
  async usage(): Promise<{ inUse: number; maxSandboxes: number }> {
    return {
      inUse: (await this.countExisting()) + this.reserved,
      maxSandboxes: this.maxSandboxes,
    };
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    // A rejected predecessor must not poison the queue, so both settlements
    // chain into the next task.
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
