import { ExecRequest } from "@sandbox-broker/contracts";
import type { Hono } from "hono";
import { stream } from "hono/streaming";

import type { SandboxService } from "../app.js";
import { BrokerError, errorResponse } from "../errors.js";
import type { Logger } from "../log.js";
import { parseJsonBody, sandboxIdParam } from "./shared.js";

const encoder = new TextEncoder();

/**
 * NDJSON exec endpoint.
 *
 * The response is a stream of contract `ExecEvent` frames, one per line. When
 * the client goes away the request's AbortSignal fires, which cancels the
 * execution and triggers sandbox recovery.
 */
export function registerExecRoute(
  app: Hono,
  getService: () => SandboxService | null,
  logger: Logger,
): void {
  app.post("/v1/sandboxes/:id/exec", async (c) => {
    const service = getService();
    if (!service) return errorResponse(c, "not_ready", "Docker is not available.");

    const id = sandboxIdParam(c);
    const parsed = ExecRequest.safeParse(await parseJsonBody(c));
    if (!parsed.success) {
      return errorResponse(c, "invalid_request", "Invalid exec request.", parsed.error.flatten());
    }

    // Resolve the sandbox before opening the stream so a missing sandbox is an
    // ordinary 404 rather than an error frame inside a 200 response.
    await service.get(id);

    const controller = new AbortController();
    c.req.raw.signal.addEventListener("abort", () => controller.abort(), { once: true });

    c.header("Content-Type", "application/x-ndjson");
    c.header("Cache-Control", "no-store");

    return stream(
      c,
      async (writer) => {
        for await (const event of service.exec(id, parsed.data, controller.signal)) {
          await writer.write(encoder.encode(`${JSON.stringify(event)}\n`));
        }
      },
      async (error, writer) => {
        // The status line is already sent, so a failure has to be reported as
        // a terminal `error` frame instead of an HTTP status.
        controller.abort();
        const known = error instanceof BrokerError;
        logger.error("exec stream failed", { sandboxId: id, error });
        await writer.write(
          encoder.encode(
            `${JSON.stringify({
              type: "error",
              executionId: "unknown",
              seq: 1,
              code: known ? error.code : "internal",
              message: known ? error.message : "Execution failed.",
            })}\n`,
          ),
        );
      },
    );
  });
}
