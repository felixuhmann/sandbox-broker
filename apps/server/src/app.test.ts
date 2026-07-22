import { describe, expect, it } from "vitest";

import { createApp, type SandboxService } from "./app.js";
import { loadConfig } from "./config.js";
import { BrokerError } from "./errors.js";

const TOKEN = "smoke-token-smoke-token-smoke-token";

describe("broker app smoke", () => {
  it("serves an unauthenticated liveness probe", async () => {
    const app = createApp({
      config: loadConfig({ SANDBOX_BROKER_TOKEN: "smoke-token-smoke-token-smoke-token" }),
      service: null,
    });

    const res = await app.request("/healthz");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("answers unknown routes with the contract error envelope", async () => {
    const app = createApp({
      config: loadConfig({ SANDBOX_BROKER_TOKEN: "smoke-token-smoke-token-smoke-token" }),
      service: null,
    });

    const res = await app.request("/nope");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "not_found", message: expect.any(String) },
    });
  });

  it("surfaces an at-capacity create as a structured 429", async () => {
    const service = {
      create: () => {
        throw new BrokerError("rate_limited", "Sandbox capacity reached: 2 of 2 in use.", {
          maxSandboxes: 2,
          inUse: 2,
        });
      },
    } as unknown as SandboxService;
    const app = createApp({ config: loadConfig({ SANDBOX_BROKER_TOKEN: TOKEN }), service });

    const res = await app.request("/v1/sandboxes", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: "idem-1",
        ownerRef: "owner-1",
        networkMode: "deny-all",
        limits: { cpuCores: 1, memoryMiB: 512, pids: 256, workspaceMiB: 256 },
      }),
    });

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: {
        code: "rate_limited",
        message: expect.any(String),
        details: { maxSandboxes: 2, inUse: 2 },
      },
    });
  });
});
