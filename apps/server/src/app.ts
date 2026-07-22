import {
  BROKER_API_VERSION,
  type CapabilitiesResponse,
  type ExecEvent,
  type ExecRequest,
  type CreateSandboxRequest,
  type ReadyResponse,
  type Sandbox,
} from "@sandbox-broker/contracts";
import { Hono } from "hono";
import type { Readable } from "node:stream";

import { bearerAuth } from "./auth.js";
import type { BrokerConfig } from "./config.js";
import { BrokerError, errorResponse } from "./errors.js";
import { createLogger, type Logger } from "./log.js";
import { registerExecRoute } from "./routes/exec.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerSandboxRoutes } from "./routes/sandboxes.js";

export type ReadyCheck = ReadyResponse["checks"][number];

export type WorkspaceQuotaReport = CapabilitiesResponse["workspaceQuota"];

/**
 * Everything the HTTP layer needs from the Docker layer. Keeping it an
 * interface lets the routes be tested without a Docker daemon.
 */
export interface SandboxService {
  readyChecks(): Promise<ReadyCheck[]>;
  workspaceQuotaReport(): Promise<WorkspaceQuotaReport>;
  create(request: CreateSandboxRequest): Promise<{ sandbox: Sandbox; created: boolean }>;
  list(): Promise<Sandbox[]>;
  get(id: string): Promise<Sandbox>;
  start(id: string): Promise<Sandbox>;
  stop(id: string): Promise<Sandbox>;
  remove(id: string): Promise<Sandbox>;
  /** Rejects before streaming when the sandbox is not runnable or is busy. */
  exec(
    id: string,
    request: ExecRequest,
    signal: AbortSignal,
  ): Promise<AsyncIterable<ExecEvent>>;
  readFile(id: string, path: string): Promise<Readable>;
  writeFile(id: string, path: string, body: Readable): Promise<void>;
  deleteFile(id: string, path: string, recursive: boolean): Promise<void>;
}

export type AppDeps = {
  config: BrokerConfig;
  /** `null` means Docker is unavailable; authenticated routes then fail with 503. */
  service: SandboxService | null;
  logger?: Logger;
};

const MAX_LIMITS = {
  cpuCores: 8,
  memoryMiB: 32_768,
  pids: 4096,
  workspaceMiB: 32_768,
} as const;

export function createApp(deps: AppDeps): Hono {
  const { config, service } = deps;
  const logger = deps.logger ?? createLogger();
  const app = new Hono();

  // Liveness only. Unauthenticated by design; exposes no Docker internals.
  app.get("/healthz", (c) => c.json({ status: "ok" }));

  // Everything below the /v1 prefix requires the bearer token, including paths
  // that have no handler, so probing the API surface tells an attacker nothing.
  app.use("/v1/*", bearerAuth(config.token));

  app.get("/v1/ready", async (c) => {
    const checks: ReadyCheck[] = service
      ? await service.readyChecks()
      : [{ name: "docker", ok: false, detail: "Docker client is not initialized." }];
    const body: ReadyResponse = {
      ready: checks.every((check) => check.ok),
      apiVersion: BROKER_API_VERSION,
      brokerVersion: config.brokerVersion,
      checks,
    };
    return c.json(body, body.ready ? 200 : 503);
  });

  app.get("/v1/capabilities", async (c) => {
    const workspaceQuota: WorkspaceQuotaReport = service
      ? await service.workspaceQuotaReport()
      : {
          mode: config.quotaMode,
          enforced: false,
          detail: "Docker client is not initialized; enforcement unverified.",
        };
    const body: CapabilitiesResponse = {
      apiVersion: BROKER_API_VERSION,
      brokerVersion: config.brokerVersion,
      networkModes: ["deny-all", "unrestricted"],
      // Not implemented in v1; advertised as false rather than omitted.
      archive: false,
      recover: false,
      limits: MAX_LIMITS,
      workspaceQuota,
      maxExecTimeoutMs: config.maxExecTimeoutMs,
    };
    return c.json(body);
  });

  const getService = () => service;
  registerSandboxRoutes(app, getService);
  registerExecRoute(app, getService, logger);
  registerFileRoutes(app, getService);

  app.onError((error, c) => {
    if (error instanceof BrokerError) {
      return errorResponse(c, error.code, error.message, error.details);
    }
    logger.error("unhandled request failure", { path: c.req.path, error });
    return errorResponse(c, "internal", "Internal broker error.");
  });

  app.notFound((c) => errorResponse(c, "not_found", "No such route."));

  return app;
}
