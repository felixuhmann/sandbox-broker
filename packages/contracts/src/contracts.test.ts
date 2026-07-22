import { describe, expect, it } from "vitest";

import {
  BROKER_API_VERSION,
  CreateSandboxRequest,
  ExecRequest,
  ExecEvent,
  FilePathQuery,
  NetworkMode,
  SandboxLimits,
  Sandbox,
  routes,
} from "./index.js";

const validLimits = {
  cpuCores: 2,
  memoryMiB: 2048,
  pids: 512,
  workspaceMiB: 2048,
};

const validCreate = {
  idempotencyKey: "session-abc",
  ownerRef: "open-agents:conversation:42",
  networkMode: "unrestricted",
  limits: validLimits,
};

describe("NetworkMode", () => {
  it("accepts exactly the two v1 modes", () => {
    expect(NetworkMode.parse("deny-all")).toBe("deny-all");
    expect(NetworkMode.parse("unrestricted")).toBe("unrestricted");
  });

  it("rejects cidr allowlist modes so policies fail closed", () => {
    expect(NetworkMode.safeParse("cidr-allowlist").success).toBe(false);
    expect(NetworkMode.safeParse("allow-list").success).toBe(false);
    expect(NetworkMode.safeParse("").success).toBe(false);
  });
});

describe("SandboxLimits", () => {
  it("accepts limits inside the supported envelope", () => {
    expect(SandboxLimits.parse(validLimits)).toEqual(validLimits);
  });

  it.each([
    ["cpuCores", 0],
    ["cpuCores", 9],
    ["cpuCores", -1],
    ["memoryMiB", 127],
    ["memoryMiB", 32_769],
    ["memoryMiB", 512.5],
    ["pids", 15],
    ["pids", 4097],
    ["workspaceMiB", 63],
    ["workspaceMiB", 32_769],
  ])("rejects %s = %s", (key, value) => {
    expect(SandboxLimits.safeParse({ ...validLimits, [key]: value }).success).toBe(false);
  });

  it("rejects unknown limit fields", () => {
    expect(
      SandboxLimits.safeParse({ ...validLimits, diskMiB: 1024 }).success,
    ).toBe(false);
  });
});

describe("CreateSandboxRequest", () => {
  it("accepts a well-formed request", () => {
    expect(CreateSandboxRequest.parse(validCreate)).toEqual(validCreate);
  });

  it("requires every field", () => {
    for (const key of Object.keys(validCreate)) {
      const partial: Record<string, unknown> = { ...validCreate };
      delete partial[key];
      expect(CreateSandboxRequest.safeParse(partial).success).toBe(false);
    }
  });

  it.each([
    ["image", "alpine:latest"],
    ["binds", ["/etc:/etc"]],
    ["capAdd", ["NET_ADMIN"]],
    ["devices", ["/dev/kvm"]],
    ["privileged", true],
    ["user", "0:0"],
    ["hostConfig", { Privileged: true }],
    ["allowedCidrs", ["10.0.0.0/8"]],
  ])("rejects unknown option %s", (key, value) => {
    const result = CreateSandboxRequest.safeParse({ ...validCreate, [key]: value });
    expect(result.success).toBe(false);
  });

  it("rejects empty and oversized identifiers", () => {
    expect(CreateSandboxRequest.safeParse({ ...validCreate, idempotencyKey: "" }).success).toBe(
      false,
    );
    expect(
      CreateSandboxRequest.safeParse({ ...validCreate, idempotencyKey: "x".repeat(201) }).success,
    ).toBe(false);
    expect(CreateSandboxRequest.safeParse({ ...validCreate, ownerRef: "" }).success).toBe(false);
    expect(
      CreateSandboxRequest.safeParse({ ...validCreate, ownerRef: "x".repeat(201) }).success,
    ).toBe(false);
  });
});

describe("ExecRequest", () => {
  it("accepts a command with an optional bounded timeout", () => {
    const parsed = ExecRequest.parse({ command: "echo hi", timeoutMs: 5_000 });
    expect(parsed.command).toBe("echo hi");
    expect(parsed.timeoutMs).toBe(5_000);
  });

  it("rejects an empty command", () => {
    expect(ExecRequest.safeParse({ command: "" }).success).toBe(false);
  });

  it("rejects host escape hatches", () => {
    expect(ExecRequest.safeParse({ command: "id", user: "root" }).success).toBe(false);
    expect(ExecRequest.safeParse({ command: "id", privileged: true }).success).toBe(false);
  });

  it("keeps the working directory inside the workspace", () => {
    expect(ExecRequest.safeParse({ command: "ls", cwd: "/workspace/sub" }).success).toBe(true);
    expect(ExecRequest.safeParse({ command: "ls", cwd: "/etc" }).success).toBe(false);
    expect(ExecRequest.safeParse({ command: "ls", cwd: "relative" }).success).toBe(false);
  });
});

describe("ExecEvent", () => {
  it("parses stream and terminal frames", () => {
    expect(
      ExecEvent.parse({
        type: "stdout",
        executionId: "e1",
        seq: 1,
        dataBase64: Buffer.from("hi").toString("base64"),
      }).type,
    ).toBe("stdout");

    const result = ExecEvent.parse({
      type: "result",
      executionId: "e1",
      seq: 2,
      exitCode: 124,
      timedOut: true,
      cancelled: false,
      durationMs: 10,
    });
    expect(result).toMatchObject({ type: "result", exitCode: 124, timedOut: true });
  });

  it("rejects a terminal frame without an exit code", () => {
    expect(
      ExecEvent.safeParse({
        type: "result",
        executionId: "e1",
        seq: 2,
        timedOut: false,
        cancelled: false,
        durationMs: 1,
      }).success,
    ).toBe(false);
  });
});

describe("FilePathQuery", () => {
  it("accepts absolute workspace paths", () => {
    expect(FilePathQuery.parse({ path: "/workspace/a/b.txt" }).path).toBe("/workspace/a/b.txt");
  });

  it("rejects traversal and out-of-workspace paths", () => {
    for (const path of ["/etc/passwd", "/workspace/../etc/passwd", "../x", "", "/workspace/a\0b"]) {
      expect(FilePathQuery.safeParse({ path }).success).toBe(false);
    }
  });
});

describe("Sandbox", () => {
  it("exposes normalized state and never leaks host details", () => {
    const sandbox = Sandbox.parse({
      id: "0d6d0b6a-6d0f-4a2c-9f0a-2f4a0c6d0b6a",
      ownerRef: "open-agents:conversation:42",
      networkMode: "deny-all",
      limits: validLimits,
      state: "started",
      createdAt: "2026-07-22T10:00:00.000Z",
      updatedAt: "2026-07-22T10:00:01.000Z",
      workspacePath: "/workspace",
    });
    expect(sandbox.state).toBe("started");
    expect(Sandbox.safeParse({ ...sandbox, state: "paused" }).success).toBe(false);
    expect(Sandbox.safeParse({ ...sandbox, containerId: "abc" }).success).toBe(false);
  });
});

describe("routes", () => {
  it("declares every v1 endpoint with an auth decision", () => {
    const declared = routes.map((r) => `${r.method} ${r.path}`).sort();
    expect(declared).toEqual(
      [
        "DELETE /v1/sandboxes/{id}",
        "DELETE /v1/sandboxes/{id}/files",
        "GET /healthz",
        "GET /v1/capabilities",
        "GET /v1/ready",
        "GET /v1/sandboxes",
        "GET /v1/sandboxes/{id}",
        "GET /v1/sandboxes/{id}/files",
        "POST /v1/sandboxes",
        "POST /v1/sandboxes/{id}/exec",
        "POST /v1/sandboxes/{id}/start",
        "POST /v1/sandboxes/{id}/stop",
        "PUT /v1/sandboxes/{id}/files",
      ].sort(),
    );
  });

  it("authenticates everything except liveness", () => {
    for (const route of routes) {
      expect(route.auth).toBe(route.path !== "/healthz");
    }
  });

  it("documents the error envelope for every authenticated route", () => {
    for (const route of routes.filter((r) => r.auth)) {
      expect(Object.keys(route.responses)).toContain("401");
    }
  });

  it("pins the API version", () => {
    expect(BROKER_API_VERSION).toBe("v1");
  });
});
