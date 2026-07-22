import { normalizeWorkspacePath } from "@sandbox-broker/contracts";
import { describe, expect, it } from "vitest";

import { BrokerError } from "../errors.js";
import { resolveWorkspaceTarget, tempSiblingName } from "./files.js";
import { parseDuBytes, quotaBytes, wouldExceedQuota } from "./workspaceQuota.js";

describe("resolveWorkspaceTarget", () => {
  it("splits a valid path into directory and basename", () => {
    expect(resolveWorkspaceTarget("/workspace/a/b.txt")).toEqual({
      path: "/workspace/a/b.txt",
      dir: "/workspace/a",
      base: "b.txt",
    });
  });

  it("accepts a file directly in the workspace root", () => {
    expect(resolveWorkspaceTarget("/workspace/top.txt")).toEqual({
      path: "/workspace/top.txt",
      dir: "/workspace",
      base: "top.txt",
    });
  });

  it("collapses redundant separators before validating", () => {
    expect(resolveWorkspaceTarget("/workspace//a///b.txt").path).toBe("/workspace/a/b.txt");
  });

  it.each([
    "/etc/passwd",
    "/workspace/../etc/passwd",
    "/workspace/a/../../etc/passwd",
    "../escape",
    "workspace/relative",
    "/workspace",
    "/workspace/",
    "",
    "/workspace/nul\0byte",
    "/var/run/docker.sock",
    "//etc/passwd",
  ])("refuses %j", (path) => {
    expect(() => resolveWorkspaceTarget(path)).toThrow(BrokerError);
  });

  it("refuses paths that only look like the workspace", () => {
    expect(() => resolveWorkspaceTarget("/workspace-evil/x")).toThrow(BrokerError);
    expect(() => resolveWorkspaceTarget("/workspaces/x")).toThrow(BrokerError);
  });

  it("agrees with the contract-level validator", () => {
    for (const path of ["/workspace/ok", "/etc/passwd", "/workspace/../x"]) {
      const contractAllows = normalizeWorkspacePath(path) !== null;
      let serviceAllows = true;
      try {
        resolveWorkspaceTarget(path);
      } catch {
        serviceAllows = false;
      }
      expect(serviceAllows).toBe(contractAllows);
    }
  });
});

describe("tempSiblingName", () => {
  it("stays in the same directory so the rename is atomic", () => {
    const name = tempSiblingName("b.txt");
    expect(name).not.toContain("/");
    expect(name.startsWith(".sandbox-broker-tmp-")).toBe(true);
  });

  it("is unique per call", () => {
    expect(tempSiblingName("b.txt")).not.toBe(tempSiblingName("b.txt"));
  });
});

describe("parseDuBytes", () => {
  it("reads the byte count from du output", () => {
    expect(parseDuBytes("4096\t/workspace\n")).toBe(4096);
    expect(parseDuBytes("0\t/workspace")).toBe(0);
  });

  it("returns null for unusable output instead of guessing zero", () => {
    expect(parseDuBytes("")).toBeNull();
    expect(parseDuBytes("du: cannot access")).toBeNull();
    expect(parseDuBytes("notanumber\t/workspace")).toBeNull();
  });
});

describe("quota arithmetic", () => {
  it("converts the limit to bytes", () => {
    expect(quotaBytes({ workspaceMiB: 256 })).toBe(256 * 1024 * 1024);
  });

  it("rejects a write that would cross the limit", () => {
    const limits = { workspaceMiB: 1 };
    expect(wouldExceedQuota({ limits, usedBytes: 0, incomingBytes: 1024 })).toBe(false);
    expect(wouldExceedQuota({ limits, usedBytes: 1024 * 1024, incomingBytes: 1 })).toBe(true);
    expect(wouldExceedQuota({ limits, usedBytes: 1024 * 1024 - 10, incomingBytes: 100 })).toBe(
      true,
    );
  });

  it("treats an unknown current usage as a breach rather than as zero", () => {
    expect(wouldExceedQuota({ limits: { workspaceMiB: 1 }, usedBytes: null, incomingBytes: 1 })).toBe(
      true,
    );
  });
});
