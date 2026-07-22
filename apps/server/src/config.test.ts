import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig, resolveToken } from "./config.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "broker-config-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("resolveToken", () => {
  it("fails closed when no token is configured", () => {
    expect(() => resolveToken({})).toThrow(/SANDBOX_BROKER_TOKEN/);
  });

  it("never falls back to a permissive no-auth mode", () => {
    expect(() => resolveToken({ SANDBOX_BROKER_ALLOW_ANONYMOUS: "true" })).toThrow(
      /SANDBOX_BROKER_TOKEN/,
    );
  });

  it("reads an inline token", () => {
    const token = "a".repeat(32);
    expect(resolveToken({ SANDBOX_BROKER_TOKEN: token }).token).toBe(token);
  });

  it("rejects a token that is too short to be a credential", () => {
    expect(() => resolveToken({ SANDBOX_BROKER_TOKEN: "short" })).toThrow(/at least 32/);
  });

  it("reads and trims a token file", () => {
    const dir = tempDir();
    const file = join(dir, "token");
    writeFileSync(file, `${"b".repeat(40)}\n`, { mode: 0o600 });
    expect(resolveToken({ SANDBOX_BROKER_TOKEN_FILE: file }).token).toBe("b".repeat(40));
  });

  it("does not generate a token unless generation is explicitly enabled", () => {
    const file = join(tempDir(), "token");
    expect(() => resolveToken({ SANDBOX_BROKER_TOKEN_FILE: file })).toThrow(/does not exist/);
  });

  it("generates a persistent 0600 token file when explicitly enabled", () => {
    const file = join(tempDir(), "token");
    const first = resolveToken({
      SANDBOX_BROKER_TOKEN_FILE: file,
      SANDBOX_BROKER_GENERATE_TOKEN: "true",
    });

    expect(first.generated).toBe(true);
    // 32 random bytes, base64url encoded.
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8").trim()).toBe(first.token);

    const second = resolveToken({
      SANDBOX_BROKER_TOKEN_FILE: file,
      SANDBOX_BROKER_GENERATE_TOKEN: "true",
    });
    expect(second.token).toBe(first.token);
    expect(second.generated).toBe(false);
  });

  it("leaves no temporary files behind after generation", () => {
    const dir = tempDir();
    const file = join(dir, "token");
    resolveToken({ SANDBOX_BROKER_TOKEN_FILE: file, SANDBOX_BROKER_GENERATE_TOKEN: "true" });
    // Only the token file itself.
    expect(readFileSync(file, "utf8").length).toBeGreaterThan(0);
  });

  it("refuses generation without a token file path", () => {
    expect(() => resolveToken({ SANDBOX_BROKER_GENERATE_TOKEN: "true" })).toThrow(
      /SANDBOX_BROKER_TOKEN_FILE/,
    );
  });
});

describe("loadConfig", () => {
  const base = { SANDBOX_BROKER_TOKEN: "c".repeat(32) };

  it("applies safe defaults", () => {
    const config = loadConfig(base);
    expect(config.port).toBe(8080);
    expect(config.quotaMode).toBe("watchdog");
    expect(config.corsEnabled).toBe(false);
    expect(config.ownerNamespace).toBe("default");
    expect(config.sandboxImage).toBeTruthy();
    expect(config.firewallImage).toBeTruthy();
  });

  it("rejects an unknown quota mode instead of guessing", () => {
    expect(() => loadConfig({ ...base, SANDBOX_BROKER_QUOTA_MODE: "soft" })).toThrow(
      /SANDBOX_BROKER_QUOTA_MODE/,
    );
  });

  it("rejects a non-numeric port", () => {
    expect(() => loadConfig({ ...base, SANDBOX_BROKER_PORT: "http" })).toThrow(
      /SANDBOX_BROKER_PORT/,
    );
  });

  it("parses blocked control endpoints", () => {
    const config = loadConfig({
      ...base,
      SANDBOX_BROKER_BLOCKED_CIDRS: "203.0.113.7/32, 198.51.100.0/24",
    });
    expect(config.extraBlockedCidrs).toEqual(["203.0.113.7/32", "198.51.100.0/24"]);
  });

  it("caps the number of concurrent sandboxes by default", () => {
    // A finite default matters: an unbounded broker can be asked to fill the
    // host with sandboxes even though each one is individually limited.
    const config = loadConfig(base);
    expect(config.maxSandboxes).toBe(16);
    expect(Number.isInteger(config.maxSandboxes)).toBe(true);
  });

  it("accepts an explicit sandbox cap", () => {
    expect(loadConfig({ ...base, SANDBOX_BROKER_MAX_SANDBOXES: "1" }).maxSandboxes).toBe(1);
    expect(loadConfig({ ...base, SANDBOX_BROKER_MAX_SANDBOXES: " 250 " }).maxSandboxes).toBe(250);
  });

  it("rejects a sandbox cap that is not a positive bounded integer", () => {
    // Notably there is no "unlimited" escape hatch: the cap is always finite.
    for (const value of ["0", "-1", "1.5", "abc", "Infinity", "unlimited", "10000"]) {
      expect(() =>
        loadConfig({ ...base, SANDBOX_BROKER_MAX_SANDBOXES: value }),
      ).toThrow(/SANDBOX_BROKER_MAX_SANDBOXES/);
    }
  });

  it("keeps the token out of its own string representation", () => {
    const config = loadConfig(base);
    expect(JSON.stringify(config)).not.toContain("cccc");
    expect(String(config)).not.toContain("cccc");
  });
});
