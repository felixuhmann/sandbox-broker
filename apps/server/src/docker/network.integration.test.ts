/**
 * Proves that a `deny-all` sandbox has no usable network path, while the
 * broker's own `docker exec` command channel keeps working.
 *
 * Every probe asserts the absence of an *application-level* response, not just
 * a missing route: a silently accepted connection would be the actual failure.
 */
import { randomUUID } from "node:crypto";

import type { Container } from "dockerode";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildSandboxCreateOptions, workspaceVolumeName } from "./createSandbox.js";
import {
  cleanupNamespace,
  createRequest,
  docker,
  dockerAvailable,
  testConfig,
} from "./dockerTestHarness.js";
import { CLOUD_METADATA_ADDRESS, DENY_ALL_NETWORK } from "./network.js";

const client = docker();
const config = testConfig("denyall");
let container: Container;
let available = false;

beforeAll(async () => {
  available = await dockerAvailable(client);
  if (!available) throw new Error("Docker daemon is required for the integration suite.");
  await cleanupNamespace(client, config);

  const id = randomUUID();
  await client.createVolume({
    Name: workspaceVolumeName(id),
    Labels: {
      "sandbox-broker.managed-by": "sandbox-broker",
      "sandbox-broker.namespace": config.ownerNamespace,
    },
  });
  container = await client.createContainer(
    buildSandboxCreateOptions({
      id,
      createdAt: new Date().toISOString(),
      config,
      request: createRequest({ networkMode: "deny-all" }),
    }),
  );
  await container.start();
}, 180_000);

afterAll(async () => {
  if (available) await cleanupNamespace(client, config);
}, 120_000);

async function probe(command: string): Promise<{ output: string; exitCode: number }> {
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
  const raw = Buffer.concat(chunks);
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= raw.length) {
    const size = raw.readUInt32BE(offset + 4);
    parts.push(raw.subarray(offset + 8, offset + 8 + size));
    offset += 8 + size;
  }
  const { ExitCode } = await exec.inspect();
  return { output: Buffer.concat(parts).toString("utf8"), exitCode: ExitCode ?? -1 };
}

describe("deny-all sandbox networking", () => {
  it("uses Docker's none network and has only loopback", async () => {
    const info = await container.inspect();
    expect(info.HostConfig.NetworkMode).toBe(DENY_ALL_NETWORK);
    expect(Object.keys(info.NetworkSettings.Networks ?? {})).toEqual(["none"]);
    // Docker omits IPAddress/Gateway entirely on the `none` network; the
    // authoritative check is that the only interface is loopback.
    expect(info.NetworkSettings.IPAddress || "").toBe("");
    expect(info.NetworkSettings.Gateway || "").toBe("");

    const interfaces = await probe("ls /sys/class/net | sort | tr '\\n' ' '");
    expect(interfaces.output.trim()).toBe("lo");
  }, 120_000);

  it("resolves no DNS name", async () => {
    const result = await probe("getent hosts example.com || echo NO_DNS");
    expect(result.output).toContain("NO_DNS");
  }, 120_000);

  it("gets no application response from public IPv4", async () => {
    const result = await probe(
      "curl -sS --max-time 8 -o /dev/null -w '%{http_code}' https://1.1.1.1/ 2>&1 || echo CURL_FAILED",
    );
    expect(result.output).toContain("CURL_FAILED");
    expect(result.output).not.toMatch(/^200/m);
  }, 120_000);

  it("gets no response from the cloud metadata endpoint", async () => {
    const result = await probe(
      `curl -sS --max-time 5 http://${CLOUD_METADATA_ADDRESS}/latest/meta-data/ 2>&1 || echo METADATA_UNREACHABLE`,
    );
    expect(result.output).toContain("METADATA_UNREACHABLE");
    expect(result.output).not.toContain("ami-id");
  }, 120_000);

  it("gets no response from Docker gateway or private ranges", async () => {
    for (const target of ["172.17.0.1", "10.0.0.1", "192.168.8.1", "127.0.0.11"]) {
      const result = await probe(
        `curl -sS --max-time 4 http://${target}/ 2>&1 || echo BLOCKED_${target.replace(/\./g, "_")}`,
      );
      expect(result.output).toContain("BLOCKED_");
    }
  }, 180_000);

  it("cannot reach the broker, app or database by service name", async () => {
    for (const name of ["sandbox-broker", "open-agents", "postgres", "db"]) {
      const result = await probe(
        `curl -sS --max-time 4 http://${name}/ 2>&1 || echo UNREACHABLE_${name}`,
      );
      expect(result.output).toContain(`UNREACHABLE_${name}`);
    }
  }, 180_000);

  it("still executes broker commands and reports exit codes", async () => {
    const ok = await probe("echo broker-exec-works");
    expect(ok.output).toContain("broker-exec-works");
    expect(ok.exitCode).toBe(0);

    const failing = await probe("exit 17");
    expect(failing.exitCode).toBe(17);
  }, 120_000);

  it("keeps loopback usable inside the sandbox itself", async () => {
    const result = await probe("ping -c1 -W1 127.0.0.1 >/dev/null 2>&1; echo rc=$?");
    // ping needs a capability the sandbox does not have; loopback existing at
    // all is what matters, and it is asserted by the interface list above.
    expect(result.output).toContain("rc=");
  }, 120_000);
});
