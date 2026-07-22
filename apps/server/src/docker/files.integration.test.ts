/**
 * Live workspace file behaviour: binary round trips, atomicity, traversal
 * refusal, persistence across restart and recreation, and quota enforcement.
 */
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import type { Container } from "dockerode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildSandboxCreateOptions, workspaceVolumeName } from "./createSandbox.js";
import {
  cleanupNamespace,
  createRequest,
  docker,
  dockerAvailable,
  testConfig,
} from "./dockerTestHarness.js";
import { execCapture } from "./execCapture.js";
import { deleteWorkspacePath, readWorkspaceFile, writeWorkspaceFile } from "./files.js";
import { measureWorkspaceUsage } from "./workspaceQuota.js";

const client = docker();
const config = testConfig("files");
const limits = { cpuCores: 1, memoryMiB: 512, pids: 256, workspaceMiB: 64 };
const writeOptions = { limits, maxBytes: config.maxUploadBytes };

let container: Container;
let sandboxId: string;
let available = false;

async function createSandboxContainer(id: string): Promise<Container> {
  const created = await client.createContainer(
    buildSandboxCreateOptions({
      id,
      createdAt: new Date().toISOString(),
      config,
      request: createRequest({ networkMode: "deny-all", limits }),
    }),
  );
  await created.start();
  return created;
}

beforeAll(async () => {
  available = await dockerAvailable(client);
  if (!available) throw new Error("Docker daemon is required for the integration suite.");
  await cleanupNamespace(client, config);

  sandboxId = randomUUID();
  await client.createVolume({
    Name: workspaceVolumeName(sandboxId),
    Labels: {
      "sandbox-broker.managed-by": "sandbox-broker",
      "sandbox-broker.namespace": config.ownerNamespace,
    },
  });
  container = await createSandboxContainer(sandboxId);
}, 180_000);

afterAll(async () => {
  if (available) await cleanupNamespace(client, config);
}, 120_000);

async function read(path: string): Promise<Buffer> {
  const stream = await readWorkspaceFile(container, path);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function write(path: string, contents: Buffer): Promise<void> {
  await writeWorkspaceFile(container, path, Readable.from(contents), writeOptions);
}

describe("workspace files against a real sandbox", () => {
  it("round-trips arbitrary binary content byte for byte", async () => {
    const payload = Buffer.alloc(64 * 1024);
    for (let i = 0; i < payload.length; i += 1) payload[i] = i % 256;
    // Bytes that break naive UTF-8 or line-based handling.
    payload.set([0x00, 0xff, 0x0d, 0x0a, 0x1a, 0x80, 0xc3, 0x28], 0);

    await write("/workspace/binary.bin", payload);
    const roundTripped = await read("/workspace/binary.bin");

    expect(roundTripped.length).toBe(payload.length);
    expect(roundTripped.equals(payload)).toBe(true);
  }, 120_000);

  it("creates nested directories on write", async () => {
    await write("/workspace/a/b/c/deep.txt", Buffer.from("nested"));
    expect((await read("/workspace/a/b/c/deep.txt")).toString()).toBe("nested");
  }, 120_000);

  it("writes atomically and leaves no temporary files behind", async () => {
    await write("/workspace/atomic.txt", Buffer.from("v1"));
    await write("/workspace/atomic.txt", Buffer.from("v2-longer"));
    expect((await read("/workspace/atomic.txt")).toString()).toBe("v2-longer");

    const leftovers = await execCapture(container, [
      "/bin/sh",
      "-c",
      "ls -a /workspace | grep -c 'sandbox-broker-tmp' || true",
    ]);
    expect(leftovers.stdout.trim()).toBe("0");
  }, 120_000);

  it("writes files owned by the sandbox user, not root", async () => {
    await write("/workspace/owned.txt", Buffer.from("x"));
    const stat = await execCapture(container, [
      "/bin/sh",
      "-c",
      "stat -c '%u:%g' /workspace/owned.txt",
    ]);
    expect(stat.stdout.trim()).toBe("10001:10001");
  }, 120_000);

  it("reports a missing file as not found", async () => {
    await expect(read("/workspace/does-not-exist.txt")).rejects.toMatchObject({
      code: "not_found",
    });
  }, 120_000);

  it("deletes files and directories, and reports missing paths", async () => {
    await write("/workspace/todelete.txt", Buffer.from("bye"));
    await deleteWorkspacePath(container, "/workspace/todelete.txt", false);
    await expect(read("/workspace/todelete.txt")).rejects.toMatchObject({ code: "not_found" });

    await write("/workspace/dir/inner.txt", Buffer.from("bye"));
    await deleteWorkspacePath(container, "/workspace/dir", true);
    await expect(read("/workspace/dir/inner.txt")).rejects.toMatchObject({ code: "not_found" });

    await expect(
      deleteWorkspacePath(container, "/workspace/never-existed", false),
    ).rejects.toMatchObject({ code: "not_found" });
  }, 120_000);

  it("refuses to touch anything outside the workspace", async () => {
    for (const path of [
      "/etc/passwd",
      "/workspace/../etc/passwd",
      "/var/run/docker.sock",
      "/proc/self/environ",
    ]) {
      await expect(read(path)).rejects.toMatchObject({ code: "invalid_request" });
      await expect(write(path, Buffer.from("x"))).rejects.toMatchObject({
        code: "invalid_request",
      });
      await expect(deleteWorkspacePath(container, path, true)).rejects.toMatchObject({
        code: "invalid_request",
      });
    }

    // The host's own /etc/passwd is still intact and unreadable from here.
    const attempt = await execCapture(container, [
      "/bin/sh",
      "-c",
      "cat /workspace/../etc/hostname 2>&1 | head -1",
    ]);
    expect(attempt.stdout).not.toContain("ubuntu-ai");
  }, 180_000);

  it("persists the workspace across a stop and start", async () => {
    await write("/workspace/persist.txt", Buffer.from("survives-restart"));
    await container.stop({ t: 5 });
    await container.start();
    expect((await read("/workspace/persist.txt")).toString()).toBe("survives-restart");
  }, 180_000);

  it("persists the workspace across container recreation", async () => {
    await write("/workspace/persist.txt", Buffer.from("survives-recreate"));
    await container.stop({ t: 5 });
    await container.remove({ force: true, v: false });

    // Same sandbox id, therefore the same named volume.
    container = await createSandboxContainer(sandboxId);
    expect((await read("/workspace/persist.txt")).toString()).toBe("survives-recreate");
  }, 240_000);

  it("measures workspace usage", async () => {
    const before = await measureWorkspaceUsage(container);
    expect(before).not.toBeNull();
    await write("/workspace/big.bin", Buffer.alloc(4 * 1024 * 1024, 7));
    const after = await measureWorkspaceUsage(container);
    expect(after!).toBeGreaterThan(before! + 3 * 1024 * 1024);
  }, 180_000);

  it("refuses a write that would cross the workspace quota", async () => {
    // The quota for this sandbox is 64 MiB.
    await expect(
      write("/workspace/toobig.bin", Buffer.alloc(80 * 1024 * 1024, 1)),
    ).rejects.toMatchObject({ code: "conflict" });

    const exists = await execCapture(container, [
      "/bin/sh",
      "-c",
      "test -e /workspace/toobig.bin && echo yes || echo no",
    ]);
    expect(exists.stdout.trim()).toBe("no");
  }, 240_000);

  it("rejects an upload larger than the configured maximum", async () => {
    await expect(
      writeWorkspaceFile(container, "/workspace/huge.bin", Readable.from(Buffer.alloc(4096)), {
        limits,
        maxBytes: 1024,
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  }, 120_000);
});
