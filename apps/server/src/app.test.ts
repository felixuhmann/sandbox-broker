import { describe, expect, it } from "vitest";

import { createApp } from "./app.js";

describe("broker app smoke", () => {
  it("serves an unauthenticated liveness probe", async () => {
    const app = createApp({
      token: "smoke-token-smoke-token-smoke-token",
      docker: null,
    });

    const res = await app.request("/healthz");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
