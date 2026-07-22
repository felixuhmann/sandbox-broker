import { serve } from "@hono/node-server";

import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDockerClient } from "./docker/client.js";
import { DockerSandboxService } from "./docker/lifecycle.js";
import { createLogger, type LogLevel } from "./log.js";

async function main(): Promise<void> {
  const logger = createLogger((process.env["SANDBOX_BROKER_LOG_LEVEL"] as LogLevel) ?? "info");

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    // Configuration errors are fatal and must not be retried into a
    // permissive fallback.
    logger.error("broker configuration is invalid", { error });
    process.exitCode = 78; // EX_CONFIG
    return;
  }

  if (config.tokenGenerated) {
    logger.info("generated a new control-plane token file", { mode: "0600" });
  }

  const docker = createDockerClient();
  const service = new DockerSandboxService({ docker, config, logger });

  // Reconcile before the listener opens: a sandbox left running by a previous
  // broker may still be executing a command, and its network policy is gone.
  try {
    await service.initialize();
  } catch (error) {
    logger.error("startup reconciliation failed", { error });
    process.exitCode = 1;
    return;
  }

  const app = createApp({ config, service, logger });

  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    logger.info("sandbox-broker listening", {
      port: info.port,
      namespace: config.ownerNamespace,
      quotaMode: config.quotaMode,
      brokerVersion: config.brokerVersion,
    });
  });

  const shutdown = (signal: string) => {
    logger.info("shutting down", { signal });
    server.close(() => process.exit(0));
    // Sandboxes deliberately keep running: their workspaces and state are
    // reconstructed from Docker on the next start.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

void main();
