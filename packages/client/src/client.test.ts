import { routes } from "@sandbox-broker/contracts";
import { describe, expect, it } from "vitest";

import { createSandboxBrokerClient, type SandboxBrokerClient } from "./client.js";
import {
  BrokerApiError,
  BrokerExecError,
  BrokerRequestError,
  BrokerResponseError,
  BrokerStreamError,
} from "./errors.js";

const TOKEN = "test-token-test-token-test-token";
const SANDBOX_ID = "3f6c1f6a-1b52-4a5f-9a3e-1d2c3b4a5e6f";
const EXECUTION_ID = "11111111-2222-3333-4444-555555555555";

const limits = { cpuCores: 2, memoryMiB: 2048, pids: 512, workspaceMiB: 2048 };

const sandbox = {
  id: SANDBOX_ID,
  ownerRefHash: "a".repeat(64),
  networkMode: "unrestricted",
  limits,
  state: "started",
  createdAt: "2026-07-22T10:00:00.000Z",
  updatedAt: "2026-07-22T10:00:01.000Z",
  workspacePath: "/workspace",
};

const createRequest = {
  idempotencyKey: "session-abc",
  ownerRef: "open-agents:conversation:42",
  networkMode: "unrestricted",
  limits,
} as const;

type Call = { method: string; url: URL; headers: Headers; body: RequestInit["body"] };

type Responder = (call: Call) => Response | Promise<Response>;

function harness(responder: Responder): { client: SandboxBrokerClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = createSandboxBrokerClient({
    baseUrl: "http://broker:8080",
    token: TOKEN,
    fetch: (input, init) => {
      const call: Call = {
        method: init?.method ?? "GET",
        url: new URL(String(input)),
        headers: new Headers(init?.headers),
        body: init?.body,
      };
      calls.push(call);
      return Promise.resolve(responder(call));
    },
  });
  return { client, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function ndjsonResponse(frames: unknown[], status = 200): Response {
  const text = frames.map((frame) => `${JSON.stringify(frame)}\n`).join("");
  return new Response(new TextEncoder().encode(text), {
    status,
    headers: { "Content-Type": "application/x-ndjson" },
  });
}

const execFrames = [
  { type: "stdout", executionId: EXECUTION_ID, seq: 1, dataBase64: btoa("out-1") },
  { type: "stderr", executionId: EXECUTION_ID, seq: 2, dataBase64: btoa("err-1") },
  { type: "stdout", executionId: EXECUTION_ID, seq: 3, dataBase64: btoa("out-2") },
  {
    type: "result",
    executionId: EXECUTION_ID,
    seq: 4,
    exitCode: 3,
    timedOut: false,
    cancelled: false,
    durationMs: 42,
  },
];

describe("service endpoints", () => {
  it("probes liveness without sending the bearer token", async () => {
    const { client, calls } = harness(() => json({ status: "ok" }));

    expect(await client.health()).toEqual({ status: "ok" });
    expect(calls[0]?.url.pathname).toBe("/healthz");
    expect(calls[0]?.headers.get("authorization")).toBeNull();
  });

  it("authenticates readiness and returns the 503 body rather than throwing", async () => {
    const body = {
      ready: false,
      apiVersion: "v1",
      brokerVersion: "0.1.0",
      checks: [{ name: "docker", ok: false, detail: "unreachable" }],
    };
    const { client, calls } = harness(() => json(body, 503));

    expect(await client.ready()).toEqual(body);
    expect(calls[0]?.url.pathname).toBe("/v1/ready");
    expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("returns capabilities validated against the contract", async () => {
    const body = {
      apiVersion: "v1",
      brokerVersion: "0.1.0",
      networkModes: ["deny-all", "unrestricted"],
      archive: false,
      recover: false,
      limits: { cpuCores: 8, memoryMiB: 32_768, pids: 4096, workspaceMiB: 32_768 },
      workspaceQuota: { mode: "watchdog", enforced: true, detail: "sampled" },
      maxExecTimeoutMs: 1_800_000,
    };
    const { client } = harness(() => json(body));

    expect(await client.capabilities()).toEqual(body);
  });

  it("rejects a server speaking a different API version", async () => {
    const { client } = harness(() =>
      json({
        apiVersion: "v2",
        brokerVersion: "0.2.0",
        networkModes: ["deny-all"],
        archive: false,
        recover: false,
        limits,
        workspaceQuota: { mode: "hard", enforced: true, detail: "" },
        maxExecTimeoutMs: 1_000,
      }),
    );

    await expect(client.capabilities()).rejects.toBeInstanceOf(BrokerResponseError);
  });
});

describe("sandbox lifecycle", () => {
  it("creates a sandbox and reports whether it was newly created", async () => {
    const { client, calls } = harness(() => json(sandbox, 201));

    const created = await client.createSandbox(createRequest);

    expect(created).toEqual({ sandbox, created: true });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.pathname).toBe("/v1/sandboxes");
    expect(calls[0]?.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(calls[0]?.body))).toEqual(createRequest);
  });

  it("reports an idempotent replay as not created", async () => {
    const { client } = harness(() => json(sandbox, 200));
    expect(await client.createSandbox(createRequest)).toEqual({ sandbox, created: false });
  });

  it("lists only the sandboxes the broker returned", async () => {
    const { client, calls } = harness(() => json({ sandboxes: [sandbox] }));

    expect(await client.listSandboxes()).toEqual([sandbox]);
    expect(calls[0]?.url.pathname).toBe("/v1/sandboxes");
  });

  it("routes get/start/stop/delete to the contract paths", async () => {
    const { client, calls } = harness(() => json(sandbox));

    await client.getSandbox(SANDBOX_ID);
    await client.startSandbox(SANDBOX_ID);
    await client.stopSandbox(SANDBOX_ID);
    await client.deleteSandbox(SANDBOX_ID);

    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      `GET /v1/sandboxes/${SANDBOX_ID}`,
      `POST /v1/sandboxes/${SANDBOX_ID}/start`,
      `POST /v1/sandboxes/${SANDBOX_ID}/stop`,
      `DELETE /v1/sandboxes/${SANDBOX_ID}`,
    ]);
  });

  it("percent-encodes path parameters", async () => {
    const { client, calls } = harness(() => json(sandbox));

    await client.getSandbox("../etc/passwd").catch(() => undefined);

    expect(calls[0]?.url.pathname).toBe("/v1/sandboxes/..%2Fetc%2Fpasswd");
  });

  it("keeps a base URL path prefix and tolerates a trailing slash", async () => {
    const calls: string[] = [];
    const client = createSandboxBrokerClient({
      baseUrl: "http://broker:8080/broker/",
      token: TOKEN,
      fetch: (input) => {
        calls.push(String(input));
        return Promise.resolve(json({ sandboxes: [] }));
      },
    });

    await client.listSandboxes();

    expect(calls[0]).toBe("http://broker:8080/broker/v1/sandboxes");
  });

  it("rejects a response that does not match the contract", async () => {
    const { client } = harness(() => json({ ...sandbox, state: "paused" }));

    const error = await client.getSandbox(SANDBOX_ID).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BrokerResponseError);
    expect((error as BrokerResponseError).operationId).toBe("getSandbox");
  });
});

describe("error handling", () => {
  it("surfaces the contract error envelope", async () => {
    const { client } = harness(() =>
      json(
        {
          error: {
            code: "conflict",
            message: "Idempotency key reused with a different configuration.",
            details: { idempotencyKey: "session-abc" },
          },
        },
        409,
      ),
    );

    const error = await client.createSandbox(createRequest).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BrokerApiError);
    expect(error).toMatchObject({
      status: 409,
      code: "conflict",
      operationId: "createSandbox",
      details: { idempotencyKey: "session-abc" },
    });
    expect((error as BrokerApiError).message).toContain("Idempotency key reused");
  });

  it("maps 401 and 404 even when the body is not a contract envelope", async () => {
    const { client: unauthorized } = harness(() => new Response("nope", { status: 401 }));
    await expect(unauthorized.listSandboxes()).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
    });

    const { client: missing } = harness(() => new Response("<html>404</html>", { status: 404 }));
    await expect(missing.getSandbox(SANDBOX_ID)).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
  });

  it("maps an unexpected status to the internal error code", async () => {
    const { client } = harness(() => new Response("boom", { status: 502 }));

    await expect(client.listSandboxes()).rejects.toMatchObject({
      status: 502,
      code: "internal",
    });
  });

  it("never puts the bearer token in an error message", async () => {
    const { client } = harness(() => new Response("nope", { status: 401 }));

    const error = await client.listSandboxes().catch((caught: unknown) => caught);

    expect(String((error as Error).message)).not.toContain(TOKEN);
    expect(JSON.stringify(error)).not.toContain(TOKEN);
  });
});

describe("workspace files", () => {
  const binary = new Uint8Array([0x00, 0x01, 0xff, 0xfe, 0x0a, 0x7f, 0x80]);

  it("downloads raw bytes unchanged", async () => {
    const { client, calls } = harness(
      () =>
        new Response(binary, {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        }),
    );

    const bytes = await client.readFile(SANDBOX_ID, "/workspace/nested dir/blob.bin");

    expect(Array.from(bytes)).toEqual(Array.from(binary));
    expect(calls[0]?.url.pathname).toBe(`/v1/sandboxes/${SANDBOX_ID}/files`);
    expect(calls[0]?.url.searchParams.get("path")).toBe("/workspace/nested dir/blob.bin");
  });

  it("uploads raw bytes and resolves on 204", async () => {
    const { client, calls } = harness(() => new Response(null, { status: 204 }));

    await expect(
      client.writeFile(SANDBOX_ID, "/workspace/blob.bin", binary),
    ).resolves.toBeUndefined();

    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.headers.get("content-type")).toBe("application/octet-stream");
    expect(Array.from(calls[0]?.body as Uint8Array)).toEqual(Array.from(binary));
  });

  it("round-trips bytes through a write followed by a read", async () => {
    const stored = new Map<string, Uint8Array>();
    const client = createSandboxBrokerClient({
      baseUrl: "http://broker:8080",
      token: TOKEN,
      fetch: (input, init) => {
        const url = new URL(String(input));
        const path = url.searchParams.get("path") ?? "";
        if (init?.method === "PUT") {
          stored.set(path, new Uint8Array(init.body as Uint8Array));
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        const bytes = stored.get(path);
        if (!bytes) return Promise.resolve(json({ error: { code: "not_found", message: "x" } }, 404));
        return Promise.resolve(new Response(bytes, { status: 200 }));
      },
    });

    await client.writeFile(SANDBOX_ID, "/workspace/blob.bin", binary);
    const read = await client.readFile(SANDBOX_ID, "/workspace/blob.bin");

    expect(Array.from(read)).toEqual(Array.from(binary));
    await expect(client.readFile(SANDBOX_ID, "/workspace/missing.bin")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("deletes a path and passes the recursive flag only when set", async () => {
    const { client, calls } = harness(() => new Response(null, { status: 204 }));

    await client.deleteFile(SANDBOX_ID, "/workspace/dir", { recursive: true });
    await client.deleteFile(SANDBOX_ID, "/workspace/file.txt");

    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url.searchParams.get("recursive")).toBe("true");
    expect(calls[1]?.url.searchParams.get("recursive")).toBeNull();
  });

  it("rejects a path outside the workspace before issuing a request", async () => {
    const { client, calls } = harness(() => new Response(null, { status: 204 }));

    await expect(client.readFile(SANDBOX_ID, "/etc/passwd")).rejects.toBeInstanceOf(
      BrokerRequestError,
    );
    await expect(
      client.writeFile(SANDBOX_ID, "/workspace/../etc", binary),
    ).rejects.toBeInstanceOf(BrokerRequestError);
    expect(calls).toHaveLength(0);
  });
});

describe("streamed exec", () => {
  it("posts the exec request and yields validated frames", async () => {
    const { client, calls } = harness(() => ndjsonResponse(execFrames));

    const events = [];
    for await (const event of await client.exec(SANDBOX_ID, { command: "echo hi" })) {
      events.push(event);
    }

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.pathname).toBe(`/v1/sandboxes/${SANDBOX_ID}/exec`);
    expect(calls[0]?.headers.get("accept")).toBe("application/x-ndjson");
    expect(JSON.parse(String(calls[0]?.body))).toEqual({ command: "echo hi" });
    expect(events.map((event) => event.type)).toEqual(["stdout", "stderr", "stdout", "result"]);
  });

  it("fails before streaming when the sandbox is busy", async () => {
    const { client } = harness(() =>
      json({ error: { code: "conflict", message: "An execution is already running." } }, 409),
    );

    await expect(client.exec(SANDBOX_ID, { command: "echo hi" })).rejects.toMatchObject({
      status: 409,
      code: "conflict",
    });
  });

  it("rejects an exec request that violates the contract before sending it", async () => {
    const { client, calls } = harness(() => ndjsonResponse(execFrames));

    await expect(client.exec(SANDBOX_ID, { command: "" })).rejects.toBeInstanceOf(
      BrokerRequestError,
    );
    expect(calls).toHaveLength(0);
  });

  it("propagates stream corruption as a stream error", async () => {
    const { client } = harness(
      () =>
        new Response(new TextEncoder().encode(`${JSON.stringify(execFrames[0])}\n{"broken"\n`), {
          status: 200,
        }),
    );

    const iterate = async () => {
      for await (const _event of await client.exec(SANDBOX_ID, { command: "x" })) {
        // drain
      }
    };

    await expect(iterate()).rejects.toBeInstanceOf(BrokerStreamError);
  });

  it("collects stdout and stderr and returns the terminal result", async () => {
    const { client } = harness(() => ndjsonResponse(execFrames));

    const outcome = await client.execCollect(SANDBOX_ID, { command: "echo hi" });

    expect(new TextDecoder().decode(outcome.stdout)).toBe("out-1out-2");
    expect(new TextDecoder().decode(outcome.stderr)).toBe("err-1");
    expect(outcome.result).toMatchObject({ exitCode: 3, timedOut: false, cancelled: false });
  });

  it("throws when the execution ends with an error frame", async () => {
    const { client } = harness(() =>
      ndjsonResponse([
        { type: "error", executionId: EXECUTION_ID, seq: 1, code: "internal", message: "boom" },
      ]),
    );

    const error = await client
      .execCollect(SANDBOX_ID, { command: "x" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BrokerExecError);
    expect(error).toMatchObject({ code: "internal" });
  });

  it("passes the caller's AbortSignal to fetch and stops iteration when it fires", async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | null = null;

    const client = createSandboxBrokerClient({
      baseUrl: "http://broker:8080",
      token: TOKEN,
      fetch: (_input, init) => {
        seenSignal = init?.signal ?? null;
        const body = new ReadableStream<Uint8Array>({
          start(streamController) {
            streamController.enqueue(
              new TextEncoder().encode(`${JSON.stringify(execFrames[0])}\n`),
            );
          },
          pull() {
            return new Promise<void>(() => {});
          },
        });
        return Promise.resolve(new Response(body, { status: 200 }));
      },
    });

    const events = await client.exec(SANDBOX_ID, { command: "sleep 60" }, {
      signal: controller.signal,
    });
    const iterator = events[Symbol.asyncIterator]();
    await iterator.next();
    const pending = iterator.next();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(seenSignal).toBe(controller.signal);
  });
});

describe("contract coverage", () => {
  it("implements every operation in the committed contract", () => {
    const implemented = new Set([
      "getHealth",
      "getReady",
      "getCapabilities",
      "createSandbox",
      "listSandboxes",
      "getSandbox",
      "startSandbox",
      "stopSandbox",
      "deleteSandbox",
      "execCommand",
      "readFile",
      "writeFile",
      "deleteFile",
    ]);

    expect(routes.map((route) => route.operationId).sort()).toEqual([...implemented].sort());
  });
});
