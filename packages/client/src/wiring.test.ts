/**
 * Client ↔ server wiring.
 *
 * The other unit tests mock `fetch`, which proves the client behaves as
 * documented but not that it talks to the routes the server actually
 * registers. Here the real Hono app answers, with only the Docker layer
 * stubbed, so a path, method, status or query-parameter drift between the two
 * halves fails a test instead of a deployment.
 */
import { createApp, type AppDeps } from "@sandbox-broker/server";
import { WORKSPACE_ROOT, type ExecEvent } from "@sandbox-broker/contracts";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { createSandboxBrokerClient } from "./client.js";

const TOKEN = "wiring-token-wiring-token-wiring-token";
const SANDBOX_ID = "11111111-2222-4333-8444-555555555555";

type Service = NonNullable<AppDeps["service"]>;

const sandbox = {
  id: SANDBOX_ID,
  ownerRefHash: "b".repeat(64),
  networkMode: "unrestricted" as const,
  limits: { cpuCores: 2, memoryMiB: 2048, pids: 512, workspaceMiB: 2048 },
  state: "started" as const,
  createdAt: "2026-07-22T10:00:00.000Z",
  updatedAt: "2026-07-22T10:00:01.000Z",
  workspacePath: WORKSPACE_ROOT,
};

function stubService(files: Map<string, Buffer>): Service {
  const execEvents: ExecEvent[] = [
    {
      type: "stdout",
      executionId: "exec-1",
      seq: 1,
      dataBase64: Buffer.from("hello\n").toString("base64"),
    },
    {
      type: "result",
      executionId: "exec-1",
      seq: 2,
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      durationMs: 5,
    },
  ];

  return {
    readyChecks: async () => [{ name: "docker", ok: true }],
    workspaceQuotaReport: async () => ({ mode: "watchdog", enforced: true, detail: "sampled" }),
    create: async () => ({ sandbox, created: true }),
    list: async () => [sandbox],
    get: async () => sandbox,
    start: async () => sandbox,
    stop: async () => ({ ...sandbox, state: "stopped" as const }),
    remove: async () => ({ ...sandbox, state: "deleted" as const }),
    exec: async () => (async function* () { yield* execEvents; })(),
    readFile: async (_id: string, path: string) => {
      const bytes = files.get(path);
      if (!bytes) throw new Error(`missing ${path}`);
      return Readable.from(bytes);
    },
    writeFile: async (_id: string, path: string, body: Readable) => {
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk as Buffer));
      files.set(path, Buffer.concat(chunks));
    },
    deleteFile: async (_id: string, path: string) => {
      files.delete(path);
    },
  };
}

/** Keeps the expected-failure test from printing the server's error log. */
const silentLogger: AppDeps["logger"] = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function connect(options: { files?: Map<string, Buffer>; token?: string } = {}) {
  const app = createApp({
    config: {
      token: TOKEN,
      brokerVersion: "0.1.0-test",
      quotaMode: "watchdog",
      maxExecTimeoutMs: 1_800_000,
    } as AppDeps["config"],
    service: stubService(options.files ?? new Map()),
    logger: silentLogger,
  });

  return createSandboxBrokerClient({
    baseUrl: "http://broker.test",
    token: options.token ?? TOKEN,
    fetch: async (input, init) => app.request(input, init),
  });
}

describe("client against the real broker app", () => {
  it("drives the whole sandbox lifecycle over the registered routes", async () => {
    const broker = connect();

    expect(await broker.health()).toEqual({ status: "ok" });
    expect((await broker.ready()).ready).toBe(true);
    expect((await broker.capabilities()).apiVersion).toBe("v1");

    const created = await broker.createSandbox({
      idempotencyKey: "wiring",
      ownerRef: "wiring-test",
      networkMode: "unrestricted",
      limits: sandbox.limits,
    });
    expect(created).toEqual({ sandbox, created: true });

    expect(await broker.listSandboxes()).toEqual([sandbox]);
    expect((await broker.getSandbox(SANDBOX_ID)).id).toBe(SANDBOX_ID);
    expect((await broker.startSandbox(SANDBOX_ID)).state).toBe("started");
    expect((await broker.stopSandbox(SANDBOX_ID)).state).toBe("stopped");
    expect((await broker.deleteSandbox(SANDBOX_ID)).state).toBe("deleted");
  });

  it("round-trips binary workspace content", async () => {
    const broker = connect();
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 10, 13]);

    await broker.writeFile(SANDBOX_ID, "/workspace/blob.bin", bytes);
    expect(Array.from(await broker.readFile(SANDBOX_ID, "/workspace/blob.bin"))).toEqual(
      Array.from(bytes),
    );

    await broker.deleteFile(SANDBOX_ID, "/workspace/blob.bin");
    await expect(broker.readFile(SANDBOX_ID, "/workspace/blob.bin")).rejects.toMatchObject({
      status: 500,
    });
  });

  it("parses the server's NDJSON exec stream", async () => {
    const broker = connect();

    const outcome = await broker.execCollect(SANDBOX_ID, { command: "echo hello" });

    expect(new TextDecoder().decode(outcome.stdout)).toBe("hello\n");
    expect(outcome.result.exitCode).toBe(0);
  });

  it("rejects a wrong token with the contract error envelope", async () => {
    const broker = connect({ token: "wrong-token-wrong-token-wrong-token" });

    await expect(broker.listSandboxes()).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
    });
  });
});
