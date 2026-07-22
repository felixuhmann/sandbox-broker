import { createHash } from "node:crypto";

import type { CreateSandboxRequest } from "@sandbox-broker/contracts";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../config.js";
import { buildSandboxCreateOptions, sandboxContainerName, workspaceVolumeName } from "./createSandbox.js";
import { LABEL, buildSandboxLabels, isBrokerOwned, parseSandboxLabels } from "./labels.js";

const config = loadConfig({
  SANDBOX_BROKER_TOKEN: "t".repeat(32),
  SANDBOX_BROKER_SANDBOX_IMAGE: "sandbox-broker/sandbox:test",
  SANDBOX_BROKER_EGRESS_NETWORK: "sandbox-broker-egress",
});

const request: CreateSandboxRequest = {
  idempotencyKey: "idem-1",
  ownerRef: "open-agents:conversation:42",
  networkMode: "unrestricted",
  limits: { cpuCores: 2, memoryMiB: 1024, pids: 256, workspaceMiB: 512 },
};

const id = "0d6d0b6a-6d0f-4a2c-9f0a-2f4a0c6d0b6a";
const createdAt = "2026-07-22T10:00:00.000Z";

function options(overrides: Partial<CreateSandboxRequest> = {}) {
  return buildSandboxCreateOptions({
    id,
    createdAt,
    config,
    request: { ...request, ...overrides },
  });
}

describe("sandbox HostConfig hardening", () => {
  const hostConfig = options().HostConfig!;

  it("is never privileged and never gains privileges", () => {
    expect(hostConfig.Privileged).toBe(false);
    expect(hostConfig.SecurityOpt).toEqual(["no-new-privileges:true"]);
    // Default seccomp and AppArmor profiles must stay in force.
    expect(JSON.stringify(hostConfig.SecurityOpt)).not.toContain("unconfined");
  });

  it("drops all capabilities and adds none", () => {
    expect(hostConfig.CapDrop).toEqual(["ALL"]);
    expect(hostConfig.CapAdd ?? []).toEqual([]);
  });

  it("uses a read-only root filesystem with noexec tmpfs scratch space", () => {
    expect(hostConfig.ReadonlyRootfs).toBe(true);
    expect(hostConfig.Tmpfs).toEqual({
      "/tmp": "rw,noexec,nosuid,nodev,size=128m",
      "/run/sandbox-broker": "rw,noexec,nosuid,nodev,size=16m",
    });
  });

  it("applies the requested resource limits", () => {
    expect(hostConfig.PidsLimit).toBe(256);
    expect(hostConfig.Memory).toBe(1024 * 1024 * 1024);
    // Equal Memory and MemorySwap means swap is disabled, not doubled.
    expect(hostConfig.MemorySwap).toBe(hostConfig.Memory);
    expect(hostConfig.NanoCpus).toBe(2 * 1_000_000_000);
  });

  it("publishes no ports at all", () => {
    expect(hostConfig.PortBindings).toEqual({});
    expect(hostConfig.PublishAllPorts).toBe(false);
    expect(options().ExposedPorts ?? {}).toEqual({});
  });

  it("mounts only the broker-created workspace volume and no host paths", () => {
    expect(hostConfig.Binds ?? []).toEqual([]);
    expect(hostConfig.Mounts).toEqual([
      {
        Type: "volume",
        Source: workspaceVolumeName(id),
        Target: "/workspace",
        ReadOnly: false,
      },
    ]);
    expect(JSON.stringify(hostConfig)).not.toContain("docker.sock");
  });

  it("shares no host namespaces and exposes no devices", () => {
    expect(hostConfig.PidMode ?? "").toBe("");
    expect(hostConfig.IpcMode).toBe("private");
    expect(hostConfig.UTSMode ?? "").toBe("");
    expect(hostConfig.UsernsMode ?? "").toBe("");
    expect(hostConfig.Devices ?? []).toEqual([]);
    expect(hostConfig.DeviceCgroupRules ?? []).toEqual([]);
    expect(hostConfig.CgroupnsMode).toBe("private");
  });

  it("disables IPv6 in the sandbox network namespace", () => {
    expect(hostConfig.Sysctls).toMatchObject({
      "net.ipv6.conf.all.disable_ipv6": "1",
      "net.ipv6.conf.default.disable_ipv6": "1",
    });
  });

  it("never restarts by itself and is never auto-removed", () => {
    expect(hostConfig.RestartPolicy).toEqual({ Name: "no", MaximumRetryCount: 0 });
    expect(hostConfig.AutoRemove).toBe(false);
  });

  it("maps deny-all to the none network and unrestricted to the broker bridge", () => {
    expect(options({ networkMode: "deny-all" }).HostConfig!.NetworkMode).toBe("none");
    expect(options({ networkMode: "unrestricted" }).HostConfig!.NetworkMode).toBe(
      "sandbox-broker-egress",
    );
  });
});

describe("sandbox container configuration", () => {
  it("uses the pinned broker image, which no request can influence", () => {
    expect(options().Image).toBe("sandbox-broker/sandbox:test");
    const spread = buildSandboxCreateOptions({
      id,
      createdAt,
      config,
      // A caller-controlled field must not reach the Docker layer even if it
      // somehow bypassed the contract.
      request: { ...request, image: "alpine:latest" } as CreateSandboxRequest,
    });
    expect(spread.Image).toBe("sandbox-broker/sandbox:test");
  });

  it("runs as a fixed non-root user in the workspace", () => {
    const created = options();
    expect(created.User).toBe("10001:10001");
    expect(created.WorkingDir).toBe("/workspace");
  });

  it("starts an inert PID 1 that executes nothing untrusted", () => {
    const created = options();
    expect(created.Entrypoint).toEqual(["/usr/bin/tini", "--", "/usr/local/bin/sandbox-entrypoint"]);
    expect(created.Cmd ?? []).toEqual([]);
    expect(created.OpenStdin).toBe(false);
    expect(created.Tty).toBe(false);
  });

  it("passes no secrets through the environment", () => {
    const env = options().Env ?? [];
    expect(env.some((entry) => /TOKEN|SECRET|KEY|PASSWORD/i.test(entry))).toBe(false);
    expect(env).toContain("HOME=/workspace");
  });

  it("names the container and volume deterministically from the sandbox id", () => {
    expect(options().name).toBe(sandboxContainerName(id));
    expect(sandboxContainerName(id)).toContain(id);
    expect(workspaceVolumeName(id)).toContain(id);
  });
});

describe("labels", () => {
  const labels = buildSandboxLabels({ id, createdAt, config, request });

  it("marks ownership, version, network mode and policy version", () => {
    expect(labels[LABEL.managedBy]).toBe("sandbox-broker");
    expect(labels[LABEL.namespace]).toBe("default");
    expect(labels[LABEL.sandboxId]).toBe(id);
    expect(labels[LABEL.networkMode]).toBe("unrestricted");
    expect(labels[LABEL.policyVersion]).toBe("1");
    expect(labels[LABEL.brokerVersion]).toBe(config.brokerVersion);
    expect(labels[LABEL.role]).toBe("sandbox");
    expect(labels[LABEL.createdAt]).toBe(createdAt);
  });

  it("stores only hashes of caller-supplied references", () => {
    const ownerHash = createHash("sha256").update(request.ownerRef).digest("hex");
    const idemHash = createHash("sha256").update(request.idempotencyKey).digest("hex");
    expect(labels[LABEL.ownerRefHash]).toBe(ownerHash);
    expect(labels[LABEL.idempotencyKeyHash]).toBe(idemHash);
    const serialized = JSON.stringify(labels);
    expect(serialized).not.toContain(request.ownerRef);
    expect(serialized).not.toContain(request.idempotencyKey);
    expect(serialized).not.toContain(config.token);
  });

  it("round-trips the limits needed to rebuild state after a broker restart", () => {
    const parsed = parseSandboxLabels(labels);
    expect(parsed).not.toBeNull();
    expect(parsed!.limits).toEqual(request.limits);
    expect(parsed!.networkMode).toBe("unrestricted");
    expect(parsed!.id).toBe(id);
  });

  it("recognizes only containers this broker namespace owns", () => {
    expect(isBrokerOwned(labels, "default")).toBe(true);
    expect(isBrokerOwned(labels, "other")).toBe(false);
    expect(isBrokerOwned({}, "default")).toBe(false);
    expect(isBrokerOwned({ "com.example.app": "1" }, "default")).toBe(false);
    expect(
      isBrokerOwned({ ...labels, [LABEL.managedBy]: "something-else" }, "default"),
    ).toBe(false);
  });

  it("returns null for labels that do not describe a sandbox", () => {
    expect(parseSandboxLabels({})).toBeNull();
    expect(parseSandboxLabels({ ...labels, [LABEL.limits]: "not json" })).toBeNull();
  });
});
