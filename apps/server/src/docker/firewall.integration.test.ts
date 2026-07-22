/**
 * Live proof of the `unrestricted` network policy.
 *
 * The sandbox must reach the public internet and nothing else: not the host,
 * not the operator's private network, not cloud metadata, not the broker's own
 * control endpoints, and not IPv6. Every claim is checked against a real
 * daemon with real packets — including a packet capture that must stay empty.
 */
import { randomUUID } from "node:crypto";

import type { Container } from "dockerode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ensureEgressNetwork } from "./client.js";
import { buildSandboxCreateOptions, workspaceVolumeName } from "./createSandbox.js";
import {
  cleanupNamespace,
  createRequest,
  docker,
  dockerAvailable,
  testConfig,
  testLogger,
} from "./dockerTestHarness.js";
import { applyAndVerifyPolicy, BlockedDestinations } from "./firewall.js";
import { runHelper } from "./firewallHelper.js";
import { collapseCidrs, probeHostAddresses } from "./hostAddresses.js";
import { CLOUD_METADATA_ADDRESS, MANDATORY_BLOCKED_CIDRS } from "./network.js";

const client = docker();
const config = testConfig("firewall");
const deps = { docker: client, config, logger: testLogger };

let container: Container;
let sandboxId: string;
let blockedCidrs: string[] = [];
let hostAddresses: string[] = [];
let available = false;
let internetReachable = false;

beforeAll(async () => {
  available = await dockerAvailable(client);
  if (!available) throw new Error("Docker daemon is required for the integration suite.");
  await cleanupNamespace(client, config);
  await ensureEgressNetwork(client, config);

  hostAddresses = await probeHostAddresses(client, config);
  blockedCidrs = await new BlockedDestinations(deps).resolve();

  sandboxId = randomUUID();
  await client.createVolume({
    Name: workspaceVolumeName(sandboxId),
    Labels: {
      "sandbox-broker.managed-by": "sandbox-broker",
      "sandbox-broker.namespace": config.ownerNamespace,
    },
  });
  container = await client.createContainer(
    buildSandboxCreateOptions({
      id: sandboxId,
      createdAt: new Date().toISOString(),
      config,
      request: createRequest({ networkMode: "unrestricted" }),
    }),
  );
  await container.start();

  const info = await container.inspect();
  await applyAndVerifyPolicy(deps, { sandboxId, containerId: info.Id, blockedCidrs });

  // Distinguish "policy blocked it" from "this machine has no internet".
  internetReachable = await hostHasInternet();
}, 300_000);

afterAll(async () => {
  if (available) await cleanupNamespace(client, config);
}, 120_000);

async function hostHasInternet(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    const res = await fetch("https://1.1.1.1/", { signal: controller.signal });
    clearTimeout(timer);
    return res.status > 0;
  } catch {
    return false;
  }
}

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

describe("unrestricted sandbox networking", () => {
  it("attaches the broker-owned egress bridge, not the app or database network", async () => {
    const info = await container.inspect();
    expect(info.HostConfig.NetworkMode).toBe(config.egressNetworkName);
    expect(Object.keys(info.NetworkSettings.Networks ?? {})).toEqual([config.egressNetworkName]);
    expect(info.NetworkSettings.Ports ?? {}).toEqual({});
  }, 60_000);

  it("blocks every address the host actually answers on", () => {
    expect(hostAddresses.length).toBeGreaterThan(0);
    for (const address of hostAddresses) {
      // A detected address may be dropped from the list only because a wider
      // mandatory range already covers it (10.42.0.1/32 inside 10.0.0.0/8).
      expect(blockedCidrs.some((cidr) => cidrCovers(cidr, address))).toBe(true);
    }
  });

  it("would add a public host address that no mandatory range covers", () => {
    // This host has only private addresses, so the public-IP path cannot be
    // exercised live here. The detected addresses above prove the probe works;
    // this proves such an address survives collapsing instead of being lost.
    const publicAddresses = hostAddresses.filter(
      (address) => !MANDATORY_BLOCKED_CIDRS.some((cidr) => cidrCovers(cidr, address)),
    );
    for (const address of publicAddresses) {
      expect(blockedCidrs).toContain(address);
    }
    expect(collapseCidrs([...MANDATORY_BLOCKED_CIDRS, "93.184.216.34/32"])).toContain(
      "93.184.216.34/32",
    );
  });

  it("gives the sandbox no NET_ADMIN or NET_RAW", async () => {
    const info = await container.inspect();
    expect(info.HostConfig.CapAdd ?? []).toEqual([]);
    expect(info.HostConfig.CapDrop).toEqual(["ALL"]);

    const caps = await probe("grep CapEff /proc/self/status");
    expect(caps.output.trim()).toMatch(/CapEff:\s+0+$/);
  }, 60_000);

  it("removes the helper container after verification", async () => {
    const helpers = await client.listContainers({
      all: true,
      filters: {
        label: [
          `sandbox-broker.namespace=${config.ownerNamespace}`,
          "sandbox-broker.role=firewall-helper",
        ],
      },
    });
    expect(helpers).toHaveLength(0);
  }, 60_000);

  it("reaches public HTTPS and gets a real application response", async () => {
    if (!internetReachable) {
      throw new Error("This host has no public internet; the egress test cannot be trusted.");
    }
    const result = await probe(
      "curl -sS --max-time 20 -o /dev/null -w 'HTTP=%{http_code}' https://cloudflare-dns.com/dns-query?name=example.com 2>&1",
    );
    expect(result.output).toMatch(/HTTP=\d{3}/);
    expect(result.output).not.toMatch(/HTTP=000/);
  }, 120_000);

  it("reaches a public IPv4 address directly", async () => {
    if (!internetReachable) {
      throw new Error("This host has no public internet; the egress test cannot be trusted.");
    }
    const result = await probe(
      "curl -sS --max-time 20 -o /dev/null -w 'HTTP=%{http_code}' https://1.1.1.1/ 2>&1",
    );
    expect(result.output).toMatch(/HTTP=\d{3}/);
    expect(result.output).not.toMatch(/HTTP=000/);
  }, 120_000);

  it("resolves DNS through Docker's embedded resolver", async () => {
    const result = await probe("getent hosts example.com || echo NO_DNS");
    expect(result.output).not.toContain("NO_DNS");
  }, 60_000);

  it("cannot reach private RFC1918 ranges", async () => {
    for (const target of ["10.0.0.1", "172.17.0.1", "192.168.0.1", "192.168.8.1"]) {
      const result = await probe(
        `curl -sS --max-time 4 http://${target}/ 2>&1; echo RC=$?`,
      );
      expect(result.output).toMatch(/RC=[1-9]/);
    }
  }, 180_000);

  it("cannot reach the cloud metadata endpoint", async () => {
    const result = await probe(
      `curl -sS --max-time 4 http://${CLOUD_METADATA_ADDRESS}/latest/meta-data/ 2>&1; echo RC=$?`,
    );
    expect(result.output).toMatch(/RC=[1-9]/);
    expect(result.output).not.toContain("ami-id");
  }, 60_000);

  it("cannot reach the Docker gateway of its own bridge", async () => {
    const info = await container.inspect();
    const gateway = info.NetworkSettings.Networks?.[config.egressNetworkName]?.Gateway;
    expect(gateway).toBeTruthy();
    const result = await probe(`curl -sS --max-time 4 http://${gateway}/ 2>&1; echo RC=$?`);
    expect(result.output).toMatch(/RC=[1-9]/);
  }, 60_000);

  it("cannot reach any address the host answers on, including its public one", async () => {
    for (const cidr of hostAddresses) {
      const address = cidr.replace("/32", "");
      const result = await probe(`curl -sS --max-time 4 http://${address}/ 2>&1; echo RC=$?`);
      expect(result.output).toMatch(/RC=[1-9]/);
    }
  }, 300_000);

  it("cannot reach broker, application or database service names", async () => {
    for (const name of ["sandbox-broker", "open-agents", "postgres", "db", "localhost.localdomain"]) {
      const result = await probe(`curl -sS --max-time 4 http://${name}/ 2>&1; echo RC=$?`);
      expect(result.output).toMatch(/RC=[1-9]/);
    }
  }, 300_000);

  it("has no working IPv6", async () => {
    const disabled = await probe("cat /proc/sys/net/ipv6/conf/all/disable_ipv6");
    expect(disabled.output.trim()).toBe("1");

    const result = await probe(
      "curl -sS -6 --max-time 6 'http://[2606:4700:4700::1111]/' 2>&1; echo RC=$?",
    );
    expect(result.output).toMatch(/RC=[1-9]/);
  }, 120_000);

  it("emits no packets at all towards a blocked private target on UDP/443", async () => {
    const target = "10.11.12.13";
    const capture = runHelper(client, config, {
      sandboxId,
      mode: "capture",
      networkMode: `container:${(await container.inspect()).Id}`,
      capabilities: ["NET_ADMIN", "NET_RAW"],
      env: {
        SANDBOX_BROKER_CAPTURE_SECONDS: "10",
        SANDBOX_BROKER_CAPTURE_FILTER: `host ${target}`,
      },
      timeoutMs: 60_000,
    });

    // Give tcpdump a moment to attach before generating traffic.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    await probe(
      `for i in 1 2 3 4 5; do ` +
        `curl -sS --max-time 1 "https://${target}/" >/dev/null 2>&1 || true; ` +
        `(echo probe > /dev/udp/${target}/443) >/dev/null 2>&1 || true; ` +
        `done; echo sent`,
    );

    const result = await capture;
    expect(result.output).toMatch(/PACKETS=\d+/);
    expect(/PACKETS=(\d+)/.exec(result.output)?.[1]).toBe("0");
  }, 180_000);

  it("cannot flush or weaken its own nftables rules", async () => {
    const flush = await probe("nft flush ruleset 2>&1; echo RC=$?");
    // nft is not installed in the sandbox image and the sandbox has no
    // NET_ADMIN; both are required, and neither is available.
    expect(flush.output).toMatch(/RC=[1-9]/);
    expect(flush.output).toMatch(/command not found|not permitted|Operation not permitted/i);

    // The policy is still in force afterwards.
    const stillBlocked = await probe(
      `curl -sS --max-time 4 http://${CLOUD_METADATA_ADDRESS}/ 2>&1; echo RC=$?`,
    );
    expect(stillBlocked.output).toMatch(/RC=[1-9]/);
  }, 120_000);

  it("re-applies the policy after a stop/start destroys the namespace", async () => {
    await container.stop({ t: 5 });
    await container.start();
    const info = await container.inspect();

    // A fresh namespace starts with no policy at all.
    const beforeReapply = await runHelper(client, config, {
      sandboxId,
      mode: "verify",
      networkMode: `container:${info.Id}`,
      capabilities: ["NET_ADMIN"],
      env: { SANDBOX_BROKER_BLOCKED_CIDRS: blockedCidrs.join(",") },
    });
    expect(beforeReapply.exitCode).not.toBe(0);

    await applyAndVerifyPolicy(deps, { sandboxId, containerId: info.Id, blockedCidrs });

    const afterReapply = await probe(
      `curl -sS --max-time 4 http://${CLOUD_METADATA_ADDRESS}/ 2>&1; echo RC=$?`,
    );
    expect(afterReapply.output).toMatch(/RC=[1-9]/);
  }, 300_000);

  it("fails loudly rather than shipping an empty policy", async () => {
    await expect(
      applyAndVerifyPolicy(deps, {
        sandboxId,
        containerId: (await container.inspect()).Id,
        blockedCidrs: [],
      }),
    ).rejects.toThrow(/empty egress policy/i);
  }, 60_000);
});

/** True when `outer` fully contains `inner`. */
function cidrCovers(outer: string, inner: string): boolean {
  const range = (cidr: string) => {
    const [address, prefix] = cidr.split("/");
    const start = (address ?? "")
      .split(".")
      .reduce((acc, octet) => acc * 256 + Number(octet), 0);
    return { start, end: start + 2 ** (32 - Number(prefix)) - 1 };
  };
  const o = range(outer);
  const i = range(inner);
  return o.start <= i.start && i.end <= o.end;
}
