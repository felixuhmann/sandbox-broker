/**
 * Aggregate sandbox-count admission control against a real Docker daemon.
 *
 * The cap is only worth anything if it holds when creates arrive together, so
 * these tests race them at a deliberately low cap and then check the daemon
 * itself: exactly the cap of containers and workspace volumes may exist, and
 * a rejected request must leave nothing behind.
 */
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import {
  cleanupNamespace,
  createRequest,
  docker,
  dockerAvailable,
  testConfig,
  testLogger,
} from "./dockerTestHarness.js";
import { LABEL, MANAGED_BY } from "./labels.js";
import { DockerSandboxService } from "./lifecycle.js";

const CAP = 2;
const client = docker();
const config = testConfig("capacity", { SANDBOX_BROKER_MAX_SANDBOXES: String(CAP) });
const AUTH = { Authorization: `Bearer ${config.token}` };

let service: DockerSandboxService;
let app: Hono;
let available = false;

beforeAll(async () => {
  available = await dockerAvailable(client);
  if (!available) throw new Error("Docker daemon is required for the integration suite.");
  await cleanupNamespace(client, config);

  service = new DockerSandboxService({ docker: client, config, logger: testLogger });
  await service.initialize();
  app = createApp({ config, service, logger: testLogger });
}, 300_000);

beforeEach(async () => {
  if (available) await cleanupNamespace(client, config);
}, 300_000);

afterAll(async () => {
  if (available) await cleanupNamespace(client, config);
}, 180_000);

type CreateResult = { status: number; code?: string; details?: unknown };

async function create(): Promise<CreateResult> {
  const res = await app.request("/v1/sandboxes", {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify(createRequest({ networkMode: "deny-all" })),
  });
  if (res.status < 400) return { status: res.status };
  const body = (await res.json()) as { error: { code: string; details?: unknown } };
  return { status: res.status, code: body.error.code, details: body.error.details };
}

/** Everything the daemon currently holds for this broker's namespace. */
async function ownedResources() {
  const filters = { label: [`${LABEL.namespace}=${config.ownerNamespace}`] };
  const containers = await client.listContainers({ all: true, filters });
  const volumes = await client.listVolumes({ filters });
  return {
    containers: containers.length,
    sandboxes: containers.filter((c) => (c.Labels ?? {})[LABEL.role] === "sandbox").length,
    volumes: (volumes.Volumes ?? []).length,
  };
}

describe("aggregate sandbox capacity against a real Docker daemon", () => {
  it("admits exactly the cap when creates race, and creates nothing for the rest", async () => {
    const attempts = CAP * 3;
    const results = await Promise.all(Array.from({ length: attempts }, () => create()));

    const created = results.filter((r) => r.status === 201);
    const rejected = results.filter((r) => r.status !== 201);

    expect(created).toHaveLength(CAP);
    expect(rejected).toHaveLength(attempts - CAP);
    for (const result of rejected) {
      expect(result.status).toBe(429);
      expect(result.code).toBe("rate_limited");
      expect(result.details).toMatchObject({ maxSandboxes: CAP });
    }

    // The daemon is the witness: no half-built sandbox, no orphaned workspace
    // volume from a request that was turned away.
    expect(await ownedResources()).toEqual({
      containers: CAP,
      sandboxes: CAP,
      volumes: CAP,
    });
  }, 300_000);

  it("counts stopped sandboxes and frees a slot only on delete", async () => {
    const first = await create();
    expect(first.status).toBe(201);
    const filled = await create();
    expect(filled.status).toBe(201);

    expect((await create()).status).toBe(429);

    // Stopping releases CPU and memory but keeps the container and workspace,
    // so it must not release a slot.
    const [sandbox] = await service.list();
    await app.request(`/v1/sandboxes/${sandbox!.id}/stop`, { method: "POST", headers: AUTH });
    expect((await create()).status).toBe(429);

    const deleted = await app.request(`/v1/sandboxes/${sandbox!.id}`, {
      method: "DELETE",
      headers: AUTH,
    });
    expect(deleted.status).toBe(200);

    expect((await create()).status).toBe(201);
    expect((await create()).status).toBe(429);
    expect(await ownedResources()).toEqual({ containers: CAP, sandboxes: CAP, volumes: CAP });
  }, 300_000);

  it("ignores foreign containers and other namespaces when counting", async () => {
    const decoyLabels: Record<string, string>[] = [
      // Another broker namespace on the same host.
      {
        [LABEL.managedBy]: MANAGED_BY,
        [LABEL.namespace]: `${config.ownerNamespace}-other`,
        [LABEL.role]: "sandbox",
      },
      // Something else entirely.
      { "com.example.unrelated": "true" },
    ];
    const created = await Promise.all(
      decoyLabels.map((Labels) =>
        client.createContainer({
          Image: config.sandboxImage,
          Cmd: ["sleep", "120"],
          Entrypoint: [],
          Labels,
          HostConfig: { NetworkMode: "none", AutoRemove: false },
        }),
      ),
    );

    try {
      // Capacity is unaffected by containers this broker does not own.
      for (let i = 0; i < CAP; i += 1) expect((await create()).status).toBe(201);
      expect((await create()).status).toBe(429);

      for (const decoy of created) {
        expect((await decoy.inspect()).State.Status).toBeTruthy();
      }
    } finally {
      for (const decoy of created) {
        await decoy.remove({ force: true }).catch(() => undefined);
      }
    }
  }, 300_000);

  it("reports the configured cap through readiness", async () => {
    expect((await create()).status).toBe(201);

    const res = await app.request("/v1/ready", { headers: AUTH });
    const body = (await res.json()) as { ready: boolean; checks: { name: string; ok: boolean; detail?: string }[] };
    const capacity = body.checks.find((check) => check.name === "sandbox-capacity");

    expect(capacity?.ok).toBe(true);
    expect(capacity?.detail).toBe(`1/${CAP} sandboxes in use`);
    // A broker at capacity is still healthy and must stay ready.
    expect((await create()).status).toBe(201);
    expect((await create()).status).toBe(429);
    const atCapacity = await app.request("/v1/ready", { headers: AUTH });
    expect(atCapacity.status).toBe(200);
    expect(((await atCapacity.json()) as { ready: boolean }).ready).toBe(true);
  }, 300_000);
});
