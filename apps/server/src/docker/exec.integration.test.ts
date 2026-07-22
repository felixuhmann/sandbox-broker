/**
 * Live exec behaviour: streaming, ordering, binary safety, timeout,
 * cancellation, and the guarantee that nothing survives either recovery path.
 */
import { randomUUID } from "node:crypto";

import { ExecEvent, type ExecRequest } from "@sandbox-broker/contracts";
import type { Container } from "dockerode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildSandboxCreateOptions, workspaceVolumeName } from "./createSandbox.js";
import {
  cleanupNamespace,
  createRequest,
  docker,
  dockerAvailable,
  testConfig,
  testLogger,
} from "./dockerTestHarness.js";
import { ExecutionRegistry, runExec, type ExecDeps } from "./exec.js";

const client = docker();
const config = testConfig("exec");
const registry = new ExecutionRegistry();

let container: Container;
let sandboxId: string;
let available = false;
let recoveries = 0;

const deps: ExecDeps = {
  config,
  logger: testLogger,
  registry,
  // Mirrors what the service does: restart the sandbox so no reparented
  // process can survive, then re-apply networking. deny-all needs no policy.
  recoverSandbox: async () => {
    recoveries += 1;
    await container.stop({ t: 2 }).catch(() => undefined);
    await container.start();
  },
};

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
  container = await client.createContainer(
    buildSandboxCreateOptions({
      id: sandboxId,
      createdAt: new Date().toISOString(),
      config,
      request: createRequest({ networkMode: "deny-all" }),
    }),
  );
  await container.start();
}, 180_000);

afterAll(async () => {
  if (available) await cleanupNamespace(client, config);
}, 120_000);

type Collected = {
  events: ExecEvent[];
  stdout: string;
  stderr: string;
  result: Extract<ExecEvent, { type: "result" }>;
};

async function collect(request: ExecRequest, signal?: AbortSignal): Promise<Collected> {
  const controller = new AbortController();
  const events: ExecEvent[] = [];
  for await (const event of runExec(deps, {
    sandboxId,
    container,
    request,
    signal: signal ?? controller.signal,
  })) {
    // Every frame must satisfy the published contract, not just look right.
    expect(ExecEvent.safeParse(event).success).toBe(true);
    events.push(event);
  }

  const decode = (type: "stdout" | "stderr") =>
    events
      .filter((event) => event.type === type)
      .map((event) => Buffer.from((event as { dataBase64: string }).dataBase64, "base64"))
      .reduce((acc, buf) => Buffer.concat([acc, buf]), Buffer.alloc(0))
      .toString("utf8");

  const last = events.at(-1);
  if (last?.type !== "result") throw new Error(`stream did not end with a result: ${last?.type}`);
  return { events, stdout: decode("stdout"), stderr: decode("stderr"), result: last };
}

describe("streaming exec against a real sandbox", () => {
  it("streams stdout and stderr with strictly increasing sequence numbers", async () => {
    const result = await collect({
      command: "echo to-stdout; echo to-stderr >&2; echo more-stdout",
    });

    expect(result.stdout).toContain("to-stdout");
    expect(result.stdout).toContain("more-stdout");
    expect(result.stderr).toContain("to-stderr");
    expect(result.result.exitCode).toBe(0);

    const seqs = result.events.map((event) => event.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs[0]).toBe(1);
    // Exactly one terminal frame, and it is last.
    expect(result.events.filter((event) => event.type === "result")).toHaveLength(1);
  }, 120_000);

  it("reports a non-zero exit code", async () => {
    const result = await collect({ command: "echo nope >&2; exit 42" });
    expect(result.result.exitCode).toBe(42);
    expect(result.result.timedOut).toBe(false);
    expect(result.result.cancelled).toBe(false);
  }, 120_000);

  it("carries arbitrary binary bytes without corruption", async () => {
    const result = await collect({
      command: "printf '\\x00\\xff\\x80\\xc3\\x28\\n' > /workspace/bin.dat; cat /workspace/bin.dat",
    });
    const bytes = result.events
      .filter((event) => event.type === "stdout")
      .map((event) => Buffer.from((event as { dataBase64: string }).dataBase64, "base64"))
      .reduce((acc, buf) => Buffer.concat([acc, buf]), Buffer.alloc(0));
    expect([...bytes]).toEqual([0x00, 0xff, 0x80, 0xc3, 0x28, 0x0a]);
  }, 120_000);

  it("runs in the requested workspace directory", async () => {
    await collect({ command: "mkdir -p /workspace/nested" });
    const result = await collect({ command: "pwd", cwd: "/workspace/nested" });
    expect(result.stdout.trim()).toBe("/workspace/nested");
  }, 120_000);

  it("passes per-command environment without leaking it into the next command", async () => {
    const withEnv = await collect({ command: "echo $MY_TOKEN", env: { MY_TOKEN: "value-123" } });
    expect(withEnv.stdout.trim()).toBe("value-123");

    const without = await collect({ command: "echo [${MY_TOKEN:-unset}]" });
    expect(without.stdout.trim()).toBe("[unset]");
  }, 120_000);

  it("rejects a second concurrent execution with a conflict", async () => {
    const controller = new AbortController();
    const slow = collect({ command: "sleep 5; echo done" }, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 750));

    await expect(
      collect({ command: "echo second" }, new AbortController().signal),
    ).rejects.toMatchObject({ code: "conflict" });

    controller.abort();
    await slow;
  }, 180_000);

  it("times out with exit code 124 and leaves the sandbox usable", async () => {
    const before = recoveries;
    const result = await collect({ command: "sleep 120", timeoutMs: 3_000 });

    expect(result.result.timedOut).toBe(true);
    expect(result.result.cancelled).toBe(false);
    expect(result.result.exitCode).toBe(124);
    expect(recoveries).toBe(before + 1);

    const next = await collect({ command: "echo alive-after-timeout" });
    expect(next.stdout).toContain("alive-after-timeout");
    expect(next.result.exitCode).toBe(0);
  }, 180_000);

  it("cancels on client disconnect with exit code 130 and leaves the sandbox usable", async () => {
    const controller = new AbortController();
    const before = recoveries;
    setTimeout(() => controller.abort(), 1_500);

    const result = await collect({ command: "sleep 120" }, controller.signal);
    expect(result.result.cancelled).toBe(true);
    expect(result.result.timedOut).toBe(false);
    expect(result.result.exitCode).toBe(130);
    expect(recoveries).toBe(before + 1);

    const next = await collect({ command: "echo alive-after-cancel" });
    expect(next.stdout).toContain("alive-after-cancel");
  }, 180_000);

  it("leaves no process alive after a command tries to escape its process tree", async () => {
    // Double-forked, detached, reparented to PID 1: exactly the shape that
    // survives a naive process-group kill.
    await collect({
      command:
        "nohup setsid bash -c 'while true; do echo tick >> /workspace/leakmarker.log; sleep 1; done' " +
        ">/dev/null 2>&1 < /dev/null & disown; echo spawned",
    });

    // The bracket keeps the probe's own command line from matching itself:
    // `pgrep -f` sees the whole cmdline, including the shell running it.
    // `pgrep -c` exits non-zero on a zero count while still printing it, so
    // the count is captured rather than chained with `||`.
    const probeLeak = "count=$(pgrep -fc 'leakmark[e]r' || true); echo \"count=${count:-0}\"";
    const leakCount = async () => {
      const out = await collect({ command: probeLeak });
      return Number(/count=(\d+)/.exec(out.stdout)?.[1] ?? "-1");
    };

    expect(await leakCount()).toBeGreaterThan(0);
    // It genuinely survives an ordinary command completing.
    expect(await leakCount()).toBeGreaterThan(0);

    // Any timeout triggers the same recovery path used for a leak.
    await collect({ command: "sleep 120", timeoutMs: 2_000 });

    expect(await leakCount()).toBe(0);
  }, 240_000);

  it("preserves /workspace across the recovery restart", async () => {
    await collect({ command: "echo persisted > /workspace/keep.txt" });
    await collect({ command: "sleep 120", timeoutMs: 2_000 });
    const result = await collect({ command: "cat /workspace/keep.txt" });
    expect(result.stdout.trim()).toBe("persisted");
  }, 240_000);

  it("caps a caller timeout at the server maximum", async () => {
    const registryFree = new ExecutionRegistry();
    const cappedDeps: ExecDeps = {
      ...deps,
      registry: registryFree,
      config: testConfig("exec", { SANDBOX_BROKER_MAX_EXEC_TIMEOUT_MS: "2000" }),
    };
    const events: ExecEvent[] = [];
    for await (const event of runExec(cappedDeps, {
      sandboxId,
      container,
      request: { command: "sleep 60", timeoutMs: 600_000 },
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }
    const last = events.at(-1) as Extract<ExecEvent, { type: "result" }>;
    expect(last.timedOut).toBe(true);
    expect(last.durationMs).toBeLessThan(20_000);
  }, 120_000);

  it("releases the sandbox lock after success, failure and timeout alike", async () => {
    expect(registry.current(sandboxId)).toBeNull();

    await collect({ command: "exit 3" });
    expect(registry.current(sandboxId)).toBeNull();

    await collect({ command: "sleep 60", timeoutMs: 2_000 });
    expect(registry.current(sandboxId)).toBeNull();

    const result = await collect({ command: "echo lock-free" });
    expect(result.stdout).toContain("lock-free");
    expect(registry.current(sandboxId)).toBeNull();
  }, 180_000);
});
