import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildSandboxCreateOptions, sandboxContainerName, workspaceVolumeName } from "./createSandbox.js";
import { ensureEgressNetwork } from "./client.js";
import {
  cleanupNamespace,
  createRequest,
  docker,
  dockerAvailable,
  testConfig,
} from "./dockerTestHarness.js";
import { isBrokerOwned, LABEL } from "./labels.js";

const client = docker();
const config = testConfig();
let available = false;

beforeAll(async () => {
  available = await dockerAvailable(client);
  if (!available) throw new Error("Docker daemon is required for the integration suite.");
  await cleanupNamespace(client);
  await ensureEgressNetwork(client, config);
}, 120_000);

afterAll(async () => {
  if (available) await cleanupNamespace(client);
}, 120_000);

async function createStarted(networkMode: "deny-all" | "unrestricted" = "deny-all") {
  const id = randomUUID();
  const request = createRequest({ networkMode });
  const options = buildSandboxCreateOptions({
    id,
    createdAt: new Date().toISOString(),
    config,
    request,
  });
  await client.createVolume({
    Name: workspaceVolumeName(id),
    Labels: {
      "sandbox-broker.managed-by": "sandbox-broker",
      "sandbox-broker.namespace": config.ownerNamespace,
      "sandbox-broker.sandbox-id": id,
    },
  });
  const container = await client.createContainer(options);
  await container.start();
  return { id, container, request };
}

describe("hardened sandbox creation against a real Docker daemon", () => {
  it("applies every hardening invariant that docker inspect can see", async () => {
    const { id, container } = await createStarted();
    const info = await container.inspect();

    expect(info.State.Running).toBe(true);
    expect(info.Name).toBe(`/${sandboxContainerName(id)}`);

    // Privileges
    expect(info.HostConfig.Privileged).toBe(false);
    expect(info.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(info.HostConfig.CapAdd ?? []).toEqual([]);
    expect(info.HostConfig.SecurityOpt).toContain("no-new-privileges:true");
    expect(JSON.stringify(info.HostConfig.SecurityOpt ?? [])).not.toContain("unconfined");
    expect(info.AppArmorProfile === "unconfined").toBe(false);

    // Filesystem
    expect(info.HostConfig.ReadonlyRootfs).toBe(true);
    expect(info.HostConfig.Binds ?? []).toEqual([]);
    expect(info.Mounts).toHaveLength(1);
    expect(info.Mounts[0]).toMatchObject({
      Type: "volume",
      Name: workspaceVolumeName(id),
      Destination: "/workspace",
      RW: true,
    });

    // Identity
    expect(info.Config.User).toBe("10001:10001");

    // Resources
    expect(info.HostConfig.PidsLimit).toBe(256);
    expect(info.HostConfig.Memory).toBe(512 * 1024 * 1024);
    expect(info.HostConfig.MemorySwap).toBe(512 * 1024 * 1024);
    expect(info.HostConfig.NanoCpus).toBe(1_000_000_000);

    // Namespaces and devices
    expect(info.HostConfig.PidMode ?? "").toBe("");
    expect(info.HostConfig.NetworkMode).not.toBe("host");
    expect(info.HostConfig.UsernsMode ?? "").toBe("");
    expect(info.HostConfig.Devices ?? []).toEqual([]);

    // No ports, anywhere.
    expect(info.HostConfig.PortBindings ?? {}).toEqual({});
    expect(info.HostConfig.PublishAllPorts).toBe(false);
    expect(info.NetworkSettings.Ports ?? {}).toEqual({});

    const dockerPort = execFileSync("docker", ["port", info.Id], { encoding: "utf8" });
    expect(dockerPort.trim()).toBe("");
  }, 120_000);

  it("labels the container as broker-owned without storing secrets", async () => {
    const { id, container, request } = await createStarted();
    const info = await container.inspect();
    const labels = info.Config.Labels ?? {};

    expect(isBrokerOwned(labels, config.ownerNamespace)).toBe(true);
    expect(labels[LABEL.sandboxId]).toBe(id);
    expect(labels[LABEL.role]).toBe("sandbox");
    expect(labels[LABEL.policyVersion]).toBe("1");

    const serialized = JSON.stringify(labels);
    expect(serialized).not.toContain(request.ownerRef);
    expect(serialized).not.toContain(request.idempotencyKey);
    expect(serialized).not.toContain(config.token);
  }, 120_000);

  it("gives the sandbox no Docker socket, no host mounts and no secrets", async () => {
    const { container } = await createStarted();

    const socket = await runInContainer(container, "test -S /var/run/docker.sock && echo yes || echo no");
    expect(socket.trim()).toBe("no");

    const env = await runInContainer(container, "env");
    expect(env).not.toContain(config.token);
    expect(env).not.toMatch(/TOKEN=|SECRET=|PASSWORD=|_KEY=/);

    // The host filesystem is not reachable: / is the image, and it is read-only.
    const write = await runInContainer(container, "touch /etc/should-fail 2>&1 || true");
    expect(write).toMatch(/Read-only file system|Permission denied/);

    const workspaceWrite = await runInContainer(
      container,
      "touch /workspace/ok && echo written",
    );
    expect(workspaceWrite.trim()).toBe("written");
  }, 120_000);

  it("runs as a non-root user that cannot regain privileges", async () => {
    const { container } = await createStarted();

    expect((await runInContainer(container, "id -u")).trim()).toBe("10001");

    const suid = await runInContainer(container, "su root -c id 2>&1 || true");
    expect(suid).not.toMatch(/uid=0\(root\)/);

    // CapEff must be empty for the sandbox process.
    const caps = await runInContainer(container, "grep CapEff /proc/self/status");
    expect(caps.trim()).toMatch(/CapEff:\s+0+$/);
  }, 120_000);

  it("keeps /tmp writable but non-executable", async () => {
    const { container } = await createStarted();

    const result = await runInContainer(
      container,
      "printf '#!/bin/sh\\necho ran\\n' > /tmp/x && chmod +x /tmp/x && (/tmp/x 2>&1 || true)",
    );
    expect(result).not.toContain("ran");
    expect(result).toMatch(/Permission denied|not permitted/);
  }, 120_000);

  it("enforces the PID limit", async () => {
    const { container } = await createStarted();

    // Well above PidsLimit=256, so the cgroup must start refusing forks.
    // Children are detached from the exec stream so the test does not wait
    // for them, and are reaped by tini once they exit.
    const output = await runInContainer(
      container,
      "spawned=0; failed=0; i=0; " +
        "while [ $i -lt 400 ]; do " +
        "  if sleep 20 </dev/null >/dev/null 2>&1 & then spawned=$((spawned+1)); else failed=$((failed+1)); fi; " +
        "  i=$((i+1)); " +
        "done 2>/tmp/forkerr; " +
        "echo \"spawned=$spawned\"; grep -c . /tmp/forkerr | sed 's/^/errors=/'",
    );

    const spawned = Number(/spawned=(\d+)/.exec(output)?.[1] ?? "0");
    const errors = Number(/errors=(\d+)/.exec(output)?.[1] ?? "0");
    // The shell reports "fork: retry: Resource temporarily unavailable" once
    // the cgroup limit bites; either the counter or the error stream proves it.
    expect(errors + (400 - spawned)).toBeGreaterThan(0);
  }, 180_000);

  it("exposes the PID limit as the container's own cgroup limit", async () => {
    const { container } = await createStarted();
    // cgroupns=private means the container sees its own cgroup, not the host's.
    const pidsMax = await runInContainer(
      container,
      "cat /sys/fs/cgroup/pids.max 2>/dev/null || cat /sys/fs/cgroup/pids/pids.max",
    );
    expect(pidsMax.trim()).toBe("256");
  }, 120_000);

  it("disables IPv6 inside the sandbox namespace", async () => {
    const { container } = await createStarted("unrestricted");
    const disabled = await runInContainer(
      container,
      "cat /proc/sys/net/ipv6/conf/all/disable_ipv6 2>/dev/null || echo missing",
    );
    expect(disabled.trim()).toMatch(/^(1|missing)$/);
  }, 120_000);
});

/** Runs a command with `docker exec` and returns the demultiplexed output. */
async function runInContainer(
  container: { exec: (options: object) => Promise<{ start: (o: object) => Promise<NodeJS.ReadableStream> }> },
  command: string,
): Promise<string> {
  const exec = await container.exec({
    Cmd: ["/bin/bash", "-lc", command],
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  // Strip the 8-byte multiplexing headers.
  const raw = Buffer.concat(chunks);
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= raw.length) {
    const size = raw.readUInt32BE(offset + 4);
    parts.push(raw.subarray(offset + 8, offset + 8 + size));
    offset += 8 + size;
  }
  return Buffer.concat(parts).toString("utf8");
}
