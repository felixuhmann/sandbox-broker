import { describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

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
});
