import { DeleteFileQuery, FilePathQuery } from "@sandbox-broker/contracts";
import type { Hono } from "hono";
import { Readable } from "node:stream";

import type { SandboxService } from "../app.js";
import { errorResponse } from "../errors.js";
import { sandboxIdParam } from "./shared.js";

export function registerFileRoutes(app: Hono, getService: () => SandboxService | null): void {
  app.get("/v1/sandboxes/:id/files", async (c) => {
    const service = getService();
    if (!service) return errorResponse(c, "not_ready", "Docker is not available.");

    const id = sandboxIdParam(c);
    const query = FilePathQuery.safeParse({ path: c.req.query("path") ?? "" });
    if (!query.success) {
      return errorResponse(c, "invalid_request", "Invalid file path.", query.error.flatten());
    }

    const stream = await service.readFile(id, query.data.path);
    c.header("Content-Type", "application/octet-stream");
    c.header("Cache-Control", "no-store");
    return c.body(Readable.toWeb(stream) as ReadableStream);
  });

  app.put("/v1/sandboxes/:id/files", async (c) => {
    const service = getService();
    if (!service) return errorResponse(c, "not_ready", "Docker is not available.");

    const id = sandboxIdParam(c);
    const query = FilePathQuery.safeParse({ path: c.req.query("path") ?? "" });
    if (!query.success) {
      return errorResponse(c, "invalid_request", "Invalid file path.", query.error.flatten());
    }

    const body = c.req.raw.body;
    const source = body
      ? (Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]) as Readable)
      : Readable.from(Buffer.alloc(0));

    await service.writeFile(id, query.data.path, source);
    return c.body(null, 204);
  });

  app.delete("/v1/sandboxes/:id/files", async (c) => {
    const service = getService();
    if (!service) return errorResponse(c, "not_ready", "Docker is not available.");

    const id = sandboxIdParam(c);
    const query = DeleteFileQuery.safeParse({
      path: c.req.query("path") ?? "",
      ...(c.req.query("recursive") === undefined ? {} : { recursive: c.req.query("recursive") }),
    });
    if (!query.success) {
      return errorResponse(c, "invalid_request", "Invalid file path.", query.error.flatten());
    }

    await service.deleteFile(id, query.data.path, query.data.recursive);
    return c.body(null, 204);
  });
}
