import {
  DEFAULT_EXEC_TIMEOUT_MS,
  EXEC_CANCELLED_EXIT_CODE,
  EXEC_TIMEOUT_EXIT_CODE,
  ExecEvent,
  MAX_EXEC_TIMEOUT_MS,
} from "@sandbox-broker/contracts";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../config.js";
import { BrokerError } from "../errors.js";
import {
  buildExecCommand,
  createFrameParser,
  ExecutionRegistry,
  resolveExecTimeout,
  terminalExitCode,
} from "./exec.js";

const config = loadConfig({ SANDBOX_BROKER_TOKEN: "e".repeat(32) });

function frame(stream: 0 | 1 | 2, payload: string): Buffer {
  const data = Buffer.from(payload, "utf8");
  const header = Buffer.alloc(8);
  header.writeUInt8(stream, 0);
  header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, data]);
}

describe("createFrameParser", () => {
  it("demultiplexes stdout and stderr", () => {
    const parse = createFrameParser();
    const out = parse(Buffer.concat([frame(1, "hello"), frame(2, "oops")]));
    expect(out).toEqual([
      { stream: "stdout", data: Buffer.from("hello") },
      { stream: "stderr", data: Buffer.from("oops") },
    ]);
  });

  it("reassembles a frame whose header is split across chunks", () => {
    const parse = createFrameParser();
    const whole = frame(1, "split-header");
    expect(parse(whole.subarray(0, 3))).toEqual([]);
    expect(parse(whole.subarray(3, 8))).toEqual([]);
    expect(parse(whole.subarray(8))).toEqual([
      { stream: "stdout", data: Buffer.from("split-header") },
    ]);
  });

  it("reassembles a payload split across many chunks", () => {
    const parse = createFrameParser();
    const whole = frame(1, "abcdefghij");
    expect(parse(whole.subarray(0, 12))).toEqual([]);
    expect(parse(whole.subarray(12, 15))).toEqual([]);
    expect(parse(whole.subarray(15))).toEqual([
      { stream: "stdout", data: Buffer.from("abcdefghij") },
    ]);
  });

  it("preserves arbitrary binary bytes", () => {
    const parse = createFrameParser();
    const payload = Buffer.from([0x00, 0xff, 0x0a, 0x1b, 0x80, 0xc3, 0x28]);
    const header = Buffer.alloc(8);
    header.writeUInt8(1, 0);
    header.writeUInt32BE(payload.length, 4);
    const out = parse(Buffer.concat([header, payload]));
    expect(out[0]!.data.equals(payload)).toBe(true);
  });

  it("ignores empty frames rather than emitting empty events", () => {
    const parse = createFrameParser();
    expect(parse(frame(1, ""))).toEqual([]);
  });
});

describe("buildExecCommand", () => {
  it("passes the command as an argument, never interpolated into the wrapper", () => {
    const evil = '"; rm -rf / #';
    const cmd = buildExecCommand({ executionId: "exec-1", cwd: "/workspace", command: evil });
    expect(cmd[0]).toBe("/bin/bash");
    expect(cmd[1]).toBe("-c");
    // The wrapper script itself must not contain the caller's text.
    expect(cmd[2]).not.toContain(evil);
    expect(cmd).toContain(evil);
  });

  it("records the process id under the tmpfs so a leaked tree can be found", () => {
    const cmd = buildExecCommand({ executionId: "exec-1", cwd: "/workspace", command: "true" });
    expect(cmd[2]).toContain("/run/sandbox-broker/");
    expect(cmd[2]).toContain("$$");
  });

  it("runs in the requested workspace directory", () => {
    const cmd = buildExecCommand({
      executionId: "exec-1",
      cwd: "/workspace/sub",
      command: "pwd",
    });
    expect(cmd).toContain("/workspace/sub");
  });
});

describe("resolveExecTimeout", () => {
  it("always applies a timeout, even when the caller omits one", () => {
    expect(resolveExecTimeout(undefined, config)).toBe(DEFAULT_EXEC_TIMEOUT_MS);
  });

  it("honours a shorter caller timeout", () => {
    expect(resolveExecTimeout(5_000, config)).toBe(5_000);
  });

  it("caps a caller timeout at the server maximum", () => {
    expect(resolveExecTimeout(MAX_EXEC_TIMEOUT_MS * 10, config)).toBe(config.maxExecTimeoutMs);
  });
});

describe("terminalExitCode", () => {
  it("reports 124 for a timeout and 130 for a cancellation", () => {
    expect(terminalExitCode({ timedOut: true, cancelled: false, raw: 0 })).toBe(
      EXEC_TIMEOUT_EXIT_CODE,
    );
    expect(terminalExitCode({ timedOut: false, cancelled: true, raw: 0 })).toBe(
      EXEC_CANCELLED_EXIT_CODE,
    );
  });

  it("passes a normal exit code through and clamps nonsense", () => {
    expect(terminalExitCode({ timedOut: false, cancelled: false, raw: 17 })).toBe(17);
    expect(terminalExitCode({ timedOut: false, cancelled: false, raw: -1 })).toBe(255);
    expect(terminalExitCode({ timedOut: false, cancelled: false, raw: null })).toBe(255);
  });

  it("reports the timeout code when a run both timed out and was cancelled", () => {
    expect(terminalExitCode({ timedOut: true, cancelled: true, raw: 0 })).toBe(
      EXEC_TIMEOUT_EXIT_CODE,
    );
  });
});

describe("ExecutionRegistry", () => {
  it("allows one execution per sandbox and rejects a second with a conflict", () => {
    const registry = new ExecutionRegistry();
    const release = registry.acquire("sbx-1", "exec-1");

    expect(() => registry.acquire("sbx-1", "exec-2")).toThrow(BrokerError);
    try {
      registry.acquire("sbx-1", "exec-2");
    } catch (error) {
      expect((error as BrokerError).code).toBe("conflict");
    }

    // A different sandbox is unaffected.
    expect(() => registry.acquire("sbx-2", "exec-3")).not.toThrow();

    release();
    expect(() => registry.acquire("sbx-1", "exec-4")).not.toThrow();
  });

  it("reports the running execution id", () => {
    const registry = new ExecutionRegistry();
    registry.acquire("sbx-1", "exec-1");
    expect(registry.current("sbx-1")).toBe("exec-1");
    expect(registry.current("sbx-2")).toBeNull();
  });

  it("releases idempotently", () => {
    const registry = new ExecutionRegistry();
    const release = registry.acquire("sbx-1", "exec-1");
    release();
    release();
    expect(registry.current("sbx-1")).toBeNull();
  });
});

describe("exec event frames", () => {
  it("match the published contract", () => {
    const events = [
      { type: "stdout", executionId: "e", seq: 1, dataBase64: "aGk=" },
      { type: "stderr", executionId: "e", seq: 2, dataBase64: "aGk=" },
      {
        type: "result",
        executionId: "e",
        seq: 3,
        exitCode: 124,
        timedOut: true,
        cancelled: false,
        durationMs: 5,
      },
    ];
    for (const event of events) {
      expect(ExecEvent.safeParse(event).success).toBe(true);
    }
  });
});
