import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { QuotaMode, DEFAULT_EXEC_TIMEOUT_MS, MAX_EXEC_TIMEOUT_MS } from "@sandbox-broker/contracts";

export type Env = Record<string, string | undefined>;

export type ResolvedToken = {
  token: string;
  /** True when this process created the token file. */
  generated: boolean;
  source: "env" | "file";
};

/** Minimum credential length; also the size of a generated token before encoding. */
const MIN_TOKEN_LENGTH = 32;
const GENERATED_TOKEN_BYTES = 32;

/**
 * Resolves the control-plane bearer token. Fails closed: there is no anonymous
 * mode, and a token file is only created when generation is explicitly enabled.
 */
export function resolveToken(env: Env): ResolvedToken {
  const inline = env["SANDBOX_BROKER_TOKEN"]?.trim();
  const file = env["SANDBOX_BROKER_TOKEN_FILE"]?.trim();
  const generate = env["SANDBOX_BROKER_GENERATE_TOKEN"]?.trim() === "true";

  if (inline) {
    assertTokenLength(inline);
    return { token: inline, generated: false, source: "env" };
  }

  if (!file) {
    if (generate) {
      throw new Error(
        "SANDBOX_BROKER_GENERATE_TOKEN=true requires SANDBOX_BROKER_TOKEN_FILE to be set.",
      );
    }
    throw new Error(
      "No control-plane credential configured. Set SANDBOX_BROKER_TOKEN or SANDBOX_BROKER_TOKEN_FILE.",
    );
  }

  let existing: string | null = null;
  try {
    existing = readFileSync(file, "utf8").trim();
  } catch {
    existing = null;
  }

  if (existing) {
    assertTokenLength(existing);
    return { token: existing, generated: false, source: "file" };
  }

  if (!generate) {
    throw new Error(
      `SANDBOX_BROKER_TOKEN_FILE (${file}) does not exist or is empty. ` +
        "Provision it, or set SANDBOX_BROKER_GENERATE_TOKEN=true to create it on first start.",
    );
  }

  const token = randomBytes(GENERATED_TOKEN_BYTES).toString("base64url");
  writeSecretFileAtomically(file, `${token}\n`);
  return { token, generated: true, source: "file" };
}

function assertTokenLength(token: string): void {
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `Control-plane token must be at least ${MIN_TOKEN_LENGTH} characters; got ${token.length}.`,
    );
  }
}

/** Writes with mode 0600 through a temporary file so readers never see a partial token. */
function writeSecretFileAtomically(path: string, contents: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const temporary = join(dir, `.${randomBytes(8).toString("hex")}.tmp`);
  try {
    writeFileSync(temporary, contents, { mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      /* the temporary file may never have been created */
    }
    throw error;
  }
}

export type BrokerConfig = {
  readonly token: string;
  readonly tokenGenerated: boolean;
  readonly port: number;
  readonly host: string;
  readonly brokerVersion: string;
  readonly sandboxImage: string;
  readonly firewallImage: string;
  /** Broker-owned bridge used for `unrestricted` sandboxes. Never the app/database network. */
  readonly egressNetworkName: string;
  /** Ownership namespace stamped into labels; the broker only touches its own. */
  readonly ownerNamespace: string;
  readonly quotaMode: QuotaMode;
  /**
   * Hard ceiling on how many non-deleted sandboxes this namespace may own at
   * once. Per-sandbox limits bound one workload; this bounds their number, so
   * a caller cannot exhaust the host by asking for arbitrarily many of them.
   */
  readonly maxSandboxes: number;
  readonly hostReserveMiB: number;
  readonly defaultExecTimeoutMs: number;
  readonly maxExecTimeoutMs: number;
  /** Additional destinations sandboxes must not reach (broker, app, database). */
  readonly extraBlockedCidrs: readonly string[];
  /** Volume driver for workspaces. Only `local` is exercised by the test suite. */
  readonly volumeDriver: string;
  readonly volumeOpts: Readonly<Record<string, string>>;
  /** Hard ceiling on a single file upload. */
  readonly maxUploadBytes: number;
  readonly corsEnabled: false;
};

const DEFAULT_SANDBOX_IMAGE = "sandbox-broker/sandbox:dev";
const DEFAULT_FIREWALL_IMAGE = "sandbox-broker/firewall:dev";

export function loadConfig(env: Env = process.env): BrokerConfig {
  const { token, generated } = resolveToken(env);

  const quotaModeRaw = env["SANDBOX_BROKER_QUOTA_MODE"]?.trim() ?? "watchdog";
  const quotaMode = QuotaMode.safeParse(quotaModeRaw);
  if (!quotaMode.success) {
    throw new Error(
      `SANDBOX_BROKER_QUOTA_MODE must be "hard" or "watchdog"; got ${JSON.stringify(quotaModeRaw)}.`,
    );
  }

  const config: BrokerConfig = {
    token: "",
    tokenGenerated: generated,
    port: readInt(env, "SANDBOX_BROKER_PORT", 8080, 1, 65_535),
    host: env["SANDBOX_BROKER_HOST"]?.trim() || "0.0.0.0",
    brokerVersion: env["SANDBOX_BROKER_VERSION"]?.trim() || "0.1.0",
    sandboxImage: env["SANDBOX_BROKER_SANDBOX_IMAGE"]?.trim() || DEFAULT_SANDBOX_IMAGE,
    firewallImage: env["SANDBOX_BROKER_FIREWALL_IMAGE"]?.trim() || DEFAULT_FIREWALL_IMAGE,
    egressNetworkName: env["SANDBOX_BROKER_EGRESS_NETWORK"]?.trim() || "sandbox-broker-egress",
    ownerNamespace: env["SANDBOX_BROKER_NAMESPACE"]?.trim() || "default",
    quotaMode: quotaMode.data,
    // Deliberately finite and conservative: there is no "unlimited" value.
    maxSandboxes: readInt(env, "SANDBOX_BROKER_MAX_SANDBOXES", 16, 1, 1024),
    hostReserveMiB: readInt(env, "SANDBOX_BROKER_HOST_RESERVE_MIB", 2048, 0, 1_048_576),
    defaultExecTimeoutMs: readInt(
      env,
      "SANDBOX_BROKER_DEFAULT_EXEC_TIMEOUT_MS",
      DEFAULT_EXEC_TIMEOUT_MS,
      1_000,
      MAX_EXEC_TIMEOUT_MS,
    ),
    maxExecTimeoutMs: readInt(
      env,
      "SANDBOX_BROKER_MAX_EXEC_TIMEOUT_MS",
      MAX_EXEC_TIMEOUT_MS,
      1_000,
      MAX_EXEC_TIMEOUT_MS,
    ),
    extraBlockedCidrs: splitList(env["SANDBOX_BROKER_BLOCKED_CIDRS"]),
    volumeDriver: env["SANDBOX_BROKER_VOLUME_DRIVER"]?.trim() || "local",
    volumeOpts: parseKeyValues(env["SANDBOX_BROKER_VOLUME_OPTS"]),
    maxUploadBytes: readInt(
      env,
      "SANDBOX_BROKER_MAX_UPLOAD_BYTES",
      256 * 1024 * 1024,
      1024,
      4 * 1024 * 1024 * 1024,
    ),
    corsEnabled: false,
  };

  // The token stays reachable as a property but out of any structural dump
  // (JSON.stringify, console.log of the object, error serialization).
  Object.defineProperty(config, "token", {
    value: token,
    enumerable: false,
    writable: false,
    configurable: false,
  });

  return Object.freeze(config);
}

function readInt(env: Env, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}; got ${JSON.stringify(raw)}.`);
  }
  return value;
}

function splitList(raw: string | undefined): readonly string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Parses `key=value,key=value` into a record, ignoring malformed entries. */
function parseKeyValues(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of splitList(raw)) {
    const index = entry.indexOf("=");
    if (index <= 0) continue;
    out[entry.slice(0, index).trim()] = entry.slice(index + 1).trim();
  }
  return out;
}
