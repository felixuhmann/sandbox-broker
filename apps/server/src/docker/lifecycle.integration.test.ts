/**
 * End-to-end lifecycle through the real HTTP app against a real Docker daemon:
 * create, idempotency, list scoping, start/stop/delete, exec, files, and
 * reconciliation after a simulated broker crash.
 */
import { createHash } from "node:crypto";

import type { Sandbox } from "@sandbox-broker/contracts";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import { workspaceVolumeName } from "./createSandbox.js";
import {
  cleanupNamespace,
  createRequest,
  docker,
  dockerAvailable,
  testConfig,
  testLogger,
} from "./dockerTestHarness.js";
import { DockerSandboxService } from "./lifecycle.js";
import { listOwnedSandboxes } from "./reconcile.js";

const client = docker();
const config = testConfig("lifecycle");
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

afterAll(async () => {
  if (available) await cleanupNamespace(client, config);
}, 180_000);

async function create(overrides: Parameters<typeof createRequest>[0] = {}) {
  const body = createRequest({ networkMode: "deny-all", ...overrides });
  const res = await app.request("/v1/sandboxes", {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { res, body, sandbox: (await res.json()) as Sandbox };
}

describe("sandbox lifecycle through the HTTP API", () => {
  it("creates a started sandbox and reports normalized state", async () => {
    const { res, body, sandbox } = await create();

    expect(res.status).toBe(201);
    expect(sandbox.state).toBe("started");
    expect(sandbox.networkMode).toBe("deny-all");
    expect(sandbox.workspacePath).toBe("/workspace");
    expect(sandbox.ownerRefHash).toBe(createHash("sha256").update(body.ownerRef).digest("hex"));
    // No Docker internals leak into the response.
    expect(JSON.stringify(sandbox)).not.toContain("containerId");
    expect(JSON.stringify(sandbox)).not.toContain(config.sandboxImage);
  }, 300_000);

  it("is idempotent for an identical request and conflicts on a changed one", async () => {
    const first = await create();
    expect(first.res.status).toBe(201);

    const replay = await app.request("/v1/sandboxes", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify(first.body),
    });
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as Sandbox).id).toBe(first.sandbox.id);

    const conflicting = await app.request("/v1/sandboxes", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ ...first.body, networkMode: "unrestricted" }),
    });
    expect(conflicting.status).toBe(409);
    expect((await conflicting.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "conflict" },
    });
  }, 300_000);

  it("rejects a request carrying an unsupported option", async () => {
    const res = await app.request("/v1/sandboxes", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ ...createRequest(), image: "alpine:latest", privileged: true }),
    });
    expect(res.status).toBe(400);
  }, 60_000);

  it("lists only sandboxes in this broker's ownership namespace", async () => {
    const { sandbox } = await create();

    const res = await app.request("/v1/sandboxes", { headers: AUTH });
    const { sandboxes } = (await res.json()) as { sandboxes: Sandbox[] };
    expect(sandboxes.some((entry) => entry.id === sandbox.id)).toBe(true);

    // Nothing outside the namespace, even though the host runs other containers.
    const owned = await listOwnedSandboxes(client, config);
    const all = await client.listContainers({ all: true });
    expect(all.length).toBeGreaterThan(owned.length);
    for (const target of owned) {
      const info = await client.getContainer(target.containerId).inspect();
      expect(info.Config.Labels?.["sandbox-broker.namespace"]).toBe(config.ownerNamespace);
    }
  }, 300_000);

  it("returns 404 for an unknown or malformed id", async () => {
    expect(
      (await app.request("/v1/sandboxes/0d6d0b6a-6d0f-4a2c-9f0a-2f4a0c6d0b6a", { headers: AUTH }))
        .status,
    ).toBe(404);
    expect((await app.request("/v1/sandboxes/not-a-uuid", { headers: AUTH })).status).toBe(404);
  }, 60_000);

  it("stops preserving the workspace, then starts again", async () => {
    const { sandbox } = await create();

    await app.request(`/v1/sandboxes/${sandbox.id}/files?path=/workspace/keep.txt`, {
      method: "PUT",
      headers: AUTH,
      body: "kept-across-stop",
    });

    const stopped = await app.request(`/v1/sandboxes/${sandbox.id}/stop`, {
      method: "POST",
      headers: AUTH,
    });
    expect(((await stopped.json()) as Sandbox).state).toBe("stopped");

    // The workspace volume still exists while the sandbox is merely stopped.
    await expect(client.getVolume(workspaceVolumeName(sandbox.id)).inspect()).resolves.toBeTruthy();

    const started = await app.request(`/v1/sandboxes/${sandbox.id}/start`, {
      method: "POST",
      headers: AUTH,
    });
    expect(((await started.json()) as Sandbox).state).toBe("started");

    const file = await app.request(
      `/v1/sandboxes/${sandbox.id}/files?path=/workspace/keep.txt`,
      { headers: AUTH },
    );
    expect(await file.text()).toBe("kept-across-stop");
  }, 300_000);

  it("deletes the container and the workspace only on explicit request", async () => {
    const { sandbox } = await create();

    const deleted = await app.request(`/v1/sandboxes/${sandbox.id}`, {
      method: "DELETE",
      headers: AUTH,
    });
    expect(((await deleted.json()) as Sandbox).state).toBe("deleted");

    expect((await app.request(`/v1/sandboxes/${sandbox.id}`, { headers: AUTH })).status).toBe(404);
    await expect(client.getVolume(workspaceVolumeName(sandbox.id)).inspect()).rejects.toThrow();
  }, 300_000);

  it("streams NDJSON exec frames over HTTP", async () => {
    const { sandbox } = await create();

    const res = await app.request(`/v1/sandboxes/${sandbox.id}/exec`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ command: "echo streamed-over-http; exit 7" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");

    const lines = (await res.text()).trim().split("\n").filter(Boolean);
    const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const stdout = events
      .filter((event) => event["type"] === "stdout")
      .map((event) => Buffer.from(String(event["dataBase64"]), "base64").toString())
      .join("");

    expect(stdout).toContain("streamed-over-http");
    expect(events.at(-1)).toMatchObject({ type: "result", exitCode: 7 });
  }, 300_000);

  it("refuses exec on a stopped sandbox", async () => {
    const { sandbox } = await create();
    await app.request(`/v1/sandboxes/${sandbox.id}/stop`, { method: "POST", headers: AUTH });

    const res = await app.request(`/v1/sandboxes/${sandbox.id}/exec`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ command: "echo nope" }),
    });
    expect(res.status).toBe(409);
  }, 300_000);

  it("round-trips a binary file over HTTP", async () => {
    const { sandbox } = await create();
    const payload = Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x80, 0xc3, 0x28]);

    const put = await app.request(
      `/v1/sandboxes/${sandbox.id}/files?path=/workspace/bin/data.bin`,
      { method: "PUT", headers: AUTH, body: payload },
    );
    expect(put.status).toBe(204);

    const get = await app.request(
      `/v1/sandboxes/${sandbox.id}/files?path=/workspace/bin/data.bin`,
      { headers: AUTH },
    );
    expect(get.headers.get("content-type")).toBe("application/octet-stream");
    expect(Buffer.from(await get.arrayBuffer()).equals(payload)).toBe(true);

    const del = await app.request(
      `/v1/sandboxes/${sandbox.id}/files?path=/workspace/bin/data.bin`,
      { method: "DELETE", headers: AUTH },
    );
    expect(del.status).toBe(204);
  }, 300_000);

  it("rejects a traversal path over HTTP", async () => {
    const { sandbox } = await create();
    for (const path of ["/etc/passwd", "/workspace/../etc/passwd"]) {
      const res = await app.request(
        `/v1/sandboxes/${sandbox.id}/files?path=${encodeURIComponent(path)}`,
        { headers: AUTH },
      );
      expect(res.status).toBe(400);
    }
  }, 300_000);

  it("brings an unrestricted sandbox up only once its policy is verified", async () => {
    const { res, sandbox } = await create({ networkMode: "unrestricted" });
    expect(res.status).toBe(201);
    // `started` is only reported after the helper verified the rules.
    expect(sandbox.state).toBe("started");

    const exec = await app.request(`/v1/sandboxes/${sandbox.id}/exec`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        command: "curl -sS --max-time 4 http://169.254.169.254/ 2>&1; echo RC=$?",
      }),
    });
    const text = await exec.text();
    const stdout = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((event) => event["type"] === "stdout")
      .map((event) => Buffer.from(String(event["dataBase64"]), "base64").toString())
      .join("");
    expect(stdout).toMatch(/RC=[1-9]/);
  }, 300_000);

  it("rebuilds state from Docker and restarts orphans after a broker crash", async () => {
    const { sandbox } = await create();

    // A command left running by a broker that then disappeared.
    const before = await client.listContainers({
      all: true,
      filters: { label: [`sandbox-broker.sandbox-id=${sandbox.id}`] },
    });
    const containerId = before[0]!.Id;
    const container = client.getContainer(containerId);
    await container.exec({ Cmd: ["/bin/bash", "-c", "sleep 600 &"], AttachStdout: false });

    const startedAtBefore = (await container.inspect()).State.StartedAt;

    // A brand-new service instance: no in-memory state whatsoever.
    const restarted = new DockerSandboxService({ docker: client, config, logger: testLogger });
    const report = await restarted.initialize();

    expect(report.sandboxes).toBeGreaterThan(0);
    expect(report.restarted).toBeGreaterThan(0);
    expect(report.failed).toBe(0);

    const startedAtAfter = (await container.inspect()).State.StartedAt;
    expect(startedAtAfter).not.toBe(startedAtBefore);

    // And the rebuilt view can serve requests immediately.
    const rebuiltApp = createApp({ config, service: restarted, logger: testLogger });
    const res = await rebuiltApp.request(`/v1/sandboxes/${sandbox.id}`, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Sandbox).state).toBe("started");
  }, 300_000);

  it("removes stale firewall helpers and never touches foreign containers", async () => {
    const foreign = await client.createContainer({
      Image: config.sandboxImage,
      Cmd: ["sleep", "60"],
      Entrypoint: [],
      Labels: { "com.example.unrelated": "true" },
      HostConfig: { NetworkMode: "none", AutoRemove: false },
    });
    await foreign.start();

    try {
      await service.initialize();
      // Untouched: still running, still there.
      expect((await foreign.inspect()).State.Running).toBe(true);

      const helpers = await client.listContainers({
        all: true,
        filters: {
          label: [
            `sandbox-broker.namespace=${config.ownerNamespace}`,
            "sandbox-broker.role=firewall-helper",
          ],
        },
      });
      expect(helpers).toHaveLength(0);
    } finally {
      await foreign.remove({ force: true }).catch(() => undefined);
    }
  }, 300_000);

  it("reports readiness and capabilities honestly", async () => {
    const capabilities = await (
      await app.request("/v1/capabilities", { headers: AUTH })
    ).json();
    expect(capabilities).toMatchObject({
      apiVersion: "v1",
      archive: false,
      recover: false,
      networkModes: ["deny-all", "unrestricted"],
    });
    // Default watchdog mode must not claim a hard quota.
    expect((capabilities as { workspaceQuota: { enforced: boolean } }).workspaceQuota.enforced).toBe(
      false,
    );

    const ready = await app.request("/v1/ready", { headers: AUTH });
    const body = (await ready.json()) as { ready: boolean; checks: { name: string; ok: boolean }[] };
    expect(ready.status).toBe(200);
    expect(body.ready).toBe(true);
    expect(body.checks.find((check) => check.name === "docker")?.ok).toBe(true);
    expect(body.checks.find((check) => check.name === "kernel-confinement")?.ok).toBe(true);
  }, 300_000);
});
