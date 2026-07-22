import { ERROR_STATUS } from "@sandbox-broker/contracts";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../config.js";
import { BrokerError } from "../errors.js";
import { countOwnedSandboxes, SandboxAdmissionGate } from "./capacity.js";
import { LABEL, MANAGED_BY } from "./labels.js";

const config = loadConfig({
  SANDBOX_BROKER_TOKEN: "t".repeat(32),
  SANDBOX_BROKER_NAMESPACE: "unit",
});

type Summary = { Id: string; Labels: Record<string, string> };

function ownedLabels(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    [LABEL.managedBy]: MANAGED_BY,
    [LABEL.namespace]: "unit",
    [LABEL.role]: "sandbox",
    ...overrides,
  };
}

/** Minimal Docker stand-in that records the filters it was asked for. */
function fakeDocker(summaries: Summary[]) {
  const calls: unknown[] = [];
  return {
    calls,
    client: {
      listContainers: async (options: { all?: boolean; filters?: unknown }) => {
        calls.push(options);
        return summaries;
      },
    } as never,
  };
}

describe("countOwnedSandboxes", () => {
  it("asks Docker only for this namespace's sandboxes, including stopped ones", async () => {
    const docker = fakeDocker([]);
    await countOwnedSandboxes(docker.client, config);

    expect(docker.calls).toEqual([
      {
        all: true,
        filters: {
          label: [
            `${LABEL.managedBy}=${MANAGED_BY}`,
            `${LABEL.namespace}=unit`,
            `${LABEL.role}=sandbox`,
          ],
        },
      },
    ]);
  });

  it("counts every non-deleted sandbox this broker owns", async () => {
    const docker = fakeDocker([
      { Id: "a", Labels: ownedLabels() },
      { Id: "b", Labels: ownedLabels() },
    ]);
    expect(await countOwnedSandboxes(docker.client, config)).toBe(2);
  });

  it("never counts foreign, other-namespace or non-sandbox containers", async () => {
    // The label filter is re-checked in code so a daemon-side filter mistake
    // cannot inflate the count with workloads the broker does not own.
    const docker = fakeDocker([
      { Id: "owned", Labels: ownedLabels() },
      { Id: "foreign", Labels: { "com.example.unrelated": "true" } },
      { Id: "other-broker", Labels: ownedLabels({ [LABEL.managedBy]: "someone-else" }) },
      { Id: "other-namespace", Labels: ownedLabels({ [LABEL.namespace]: "production" }) },
      { Id: "helper", Labels: ownedLabels({ [LABEL.role]: "firewall-helper" }) },
    ]);
    expect(await countOwnedSandboxes(docker.client, config)).toBe(1);
  });
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

/**
 * A gate wired to a counter that only sees a sandbox once its slot has been
 * released — exactly like Docker, which lists a container only after it has
 * been created.
 */
function world(maxSandboxes: number, existing = 0) {
  let created = existing;
  let counts = 0;
  const gate = new SandboxAdmissionGate(maxSandboxes, async () => {
    counts += 1;
    await tick();
    return created;
  });

  async function create(): Promise<"created" | "rejected"> {
    let slot;
    try {
      slot = await gate.admit();
    } catch (error) {
      expect((error as BrokerError).code).toBe("rate_limited");
      return "rejected";
    }
    try {
      await tick();
      created += 1;
    } finally {
      slot.release();
    }
    return "created";
  }

  return {
    gate,
    create,
    get created() {
      return created;
    },
    get counts() {
      return counts;
    },
  };
}

describe("SandboxAdmissionGate", () => {
  it("admits creates up to the configured cap", async () => {
    const w = world(3);
    expect(await w.create()).toBe("created");
    expect(await w.create()).toBe("created");
    expect(await w.create()).toBe("created");
    expect(await w.create()).toBe("rejected");
    expect(w.created).toBe(3);
  });

  it("rejects with a structured 429-mapped error", async () => {
    const gate = new SandboxAdmissionGate(1, async () => 1);
    const error = await gate.admit().catch((e: unknown) => e as BrokerError);

    expect(error).toBeInstanceOf(BrokerError);
    expect((error as BrokerError).code).toBe("rate_limited");
    expect(ERROR_STATUS[(error as BrokerError).code]).toBe(429);
    expect((error as BrokerError).details).toEqual({ maxSandboxes: 1, inUse: 1 });
  });

  it("lets exactly the cap through when creates race", async () => {
    // Every racing request reads the same "nothing exists yet" count, so only
    // an in-process reservation can keep them from all being admitted.
    const w = world(3);
    const results = await Promise.all(Array.from({ length: 12 }, () => w.create()));

    expect(results.filter((r) => r === "created")).toHaveLength(3);
    expect(results.filter((r) => r === "rejected")).toHaveLength(9);
    expect(w.created).toBe(3);
  });

  it("counts sandboxes that already exist in Docker", async () => {
    const w = world(3, 2);
    const results = await Promise.all(Array.from({ length: 5 }, () => w.create()));

    expect(results.filter((r) => r === "created")).toHaveLength(1);
    expect(w.created).toBe(3);
  });

  it("does not double-count a reservation that Docker has started reporting", async () => {
    // A released slot is one Docker now counts itself; counting it twice would
    // reject creates while the host still has room.
    const w = world(3);
    await w.create();
    await w.create();
    expect(await w.create()).toBe("created");
  });

  it("returns the slot when the create fails", async () => {
    const gate = new SandboxAdmissionGate(1, async () => 0);
    const slot = await gate.admit();
    slot.release();

    await expect(gate.admit()).resolves.toBeTruthy();
  });

  it("releases a slot only once", async () => {
    const gate = new SandboxAdmissionGate(1, async () => 0);
    const slot = await gate.admit();
    slot.release();
    slot.release();

    await gate.admit();
    await expect(gate.admit()).rejects.toThrow(/capacity/i);
  });

  it("reports usage without consuming a slot", async () => {
    const gate = new SandboxAdmissionGate(4, async () => 2);
    await gate.admit();

    expect(await gate.usage()).toEqual({ inUse: 3, maxSandboxes: 4 });
  });
});
