import { describe, expect, it, vi } from "vitest";

import { createApp } from "./app.js";
import { bearerAuth, tokensMatch } from "./auth.js";
import { loadConfig } from "./config.js";
import { formatLogLine } from "./log.js";

const TOKEN = "s3cret-token-with-at-least-32-chars!!";

function app() {
  return createApp({ config: loadConfig({ SANDBOX_BROKER_TOKEN: TOKEN }), service: null });
}

describe("tokensMatch", () => {
  it("accepts the exact token", () => {
    expect(tokensMatch(TOKEN, TOKEN)).toBe(true);
  });

  it("rejects wrong, prefix, and longer tokens without throwing on length", () => {
    expect(tokensMatch(TOKEN, "wrong")).toBe(false);
    expect(tokensMatch(TOKEN, TOKEN.slice(0, -1))).toBe(false);
    expect(tokensMatch(TOKEN, `${TOKEN}x`)).toBe(false);
    expect(tokensMatch(TOKEN, "")).toBe(false);
  });
});

describe("bearerAuth", () => {
  it("is exported as middleware", () => {
    expect(typeof bearerAuth(TOKEN)).toBe("function");
  });
});

describe("control plane authentication", () => {
  it("leaves liveness unauthenticated", async () => {
    const res = await app().request("/healthz");
    expect(res.status).toBe(200);
  });

  it.each([
    ["/v1/ready", "GET"],
    ["/v1/capabilities", "GET"],
    ["/v1/sandboxes", "GET"],
    ["/v1/sandboxes", "POST"],
    ["/v1/sandboxes/0d6d0b6a-6d0f-4a2c-9f0a-2f4a0c6d0b6a", "GET"],
    ["/v1/sandboxes/0d6d0b6a-6d0f-4a2c-9f0a-2f4a0c6d0b6a/exec", "POST"],
    ["/v1/sandboxes/0d6d0b6a-6d0f-4a2c-9f0a-2f4a0c6d0b6a/files?path=/workspace/a", "GET"],
  ])("rejects unauthenticated %s %s with 401", async (path, method) => {
    const res = await app().request(path, { method });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: "unauthorized", message: expect.any(String) },
    });
  });

  it("rejects a wrong token with 401", async () => {
    const res = await app().request("/v1/capabilities", {
      headers: { Authorization: "Bearer not-the-token-not-the-token-xx" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects a non-bearer scheme", async () => {
    const res = await app().request("/v1/capabilities", {
      headers: { Authorization: `Basic ${TOKEN}` },
    });
    expect(res.status).toBe(401);
  });

  it("accepts the configured token", async () => {
    const res = await app().request("/v1/capabilities", {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { apiVersion: string; archive: boolean };
    expect(body.apiVersion).toBe("v1");
    expect(body.archive).toBe(false);
  });

  it("reports not ready when Docker is unavailable", async () => {
    const res = await app().request("/v1/ready", {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ready: boolean };
    expect(body.ready).toBe(false);
  });

  it("sends no CORS headers by default", async () => {
    const res = await app().request("/v1/capabilities", {
      headers: { Authorization: `Bearer ${TOKEN}`, Origin: "https://evil.example" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("never echoes the token in an error body", async () => {
    const res = await app().request("/v1/capabilities", {
      headers: { Authorization: `Bearer ${TOKEN}-wrong` },
    });
    expect(await res.text()).not.toContain(TOKEN);
  });

  it("never logs the Authorization header or command environment values", async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    try {
      formatLogLine("info", "request", {
        headers: { authorization: `Bearer ${TOKEN}`, "x-trace": "abc" },
        env: { OPENAI_API_KEY: "sk-live-should-not-appear" },
        command: "echo hi",
      });
    } finally {
      spy.mockRestore();
    }

    const line = formatLogLine("info", "request", {
      headers: { authorization: `Bearer ${TOKEN}` },
      env: { OPENAI_API_KEY: "sk-live-should-not-appear" },
    });
    expect(line).not.toContain(TOKEN);
    expect(line).not.toContain("sk-live-should-not-appear");
    expect(line).toContain("[redacted]");
    expect(logged.join("\n")).not.toContain(TOKEN);
  });
});
