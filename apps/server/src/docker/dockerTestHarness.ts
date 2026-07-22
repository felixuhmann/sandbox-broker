/**
 * Shared helpers for the real-Docker integration suites.
 *
 * Excluded from the published build; it exists so every integration file uses
 * the same isolated namespace and the same guaranteed cleanup.
 */
import { randomUUID } from "node:crypto";

import type { CreateSandboxRequest } from "@sandbox-broker/contracts";

import { loadConfig, type BrokerConfig } from "../config.js";
import { createLogger } from "../log.js";
import { createDockerClient, type DockerClient } from "./client.js";

export const TEST_NAMESPACE = "itest";

export function testConfig(overrides: Record<string, string> = {}): BrokerConfig {
  return loadConfig({
    SANDBOX_BROKER_TOKEN: "integration-token-integration-token",
    SANDBOX_BROKER_NAMESPACE: TEST_NAMESPACE,
    SANDBOX_BROKER_SANDBOX_IMAGE: process.env["SANDBOX_BROKER_SANDBOX_IMAGE"] ?? "sandbox-broker/sandbox:dev",
    SANDBOX_BROKER_FIREWALL_IMAGE:
      process.env["SANDBOX_BROKER_FIREWALL_IMAGE"] ?? "sandbox-broker/firewall:dev",
    SANDBOX_BROKER_EGRESS_NETWORK: "sandbox-broker-itest-egress",
    ...overrides,
  });
}

export const testLogger = createLogger(
  (process.env["SANDBOX_BROKER_TEST_LOG"] as "debug" | "info" | "warn" | "error") ?? "warn",
);

export async function dockerAvailable(docker: DockerClient): Promise<boolean> {
  try {
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}

export function docker(): DockerClient {
  return createDockerClient();
}

export function createRequest(
  overrides: Partial<CreateSandboxRequest> = {},
): CreateSandboxRequest {
  return {
    idempotencyKey: `itest-${randomUUID()}`,
    ownerRef: `itest:${randomUUID()}`,
    networkMode: "deny-all",
    limits: { cpuCores: 1, memoryMiB: 512, pids: 256, workspaceMiB: 256 },
    ...overrides,
  };
}

/** Removes every container, volume and network the integration namespace owns. */
export async function cleanupNamespace(client: DockerClient): Promise<void> {
  const filters = { label: [`sandbox-broker.namespace=${TEST_NAMESPACE}`] };

  const containers = await client.listContainers({ all: true, filters });
  await Promise.all(
    containers.map(async (summary) => {
      try {
        await client.getContainer(summary.Id).remove({ force: true, v: false });
      } catch {
        /* already gone */
      }
    }),
  );

  const volumes = await client.listVolumes({ filters });
  await Promise.all(
    (volumes.Volumes ?? []).map(async (volume) => {
      try {
        await client.getVolume(volume.Name).remove({ force: true });
      } catch {
        /* already gone */
      }
    }),
  );
}
