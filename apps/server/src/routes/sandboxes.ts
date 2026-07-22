import { CreateSandboxRequest } from "@sandbox-broker/contracts";
import type { Hono } from "hono";

import type { SandboxService } from "../app.js";
import { errorResponse } from "../errors.js";
import { parseJsonBody, sandboxIdParam } from "./shared.js";

export function registerSandboxRoutes(app: Hono, getService: () => SandboxService | null): void {
  app.post("/v1/sandboxes", async (c) => {
    const service = getService();
    if (!service) return errorResponse(c, "not_ready", "Docker is not available.");

    const parsed = CreateSandboxRequest.safeParse(await parseJsonBody(c));
    if (!parsed.success) {
      // Unknown fields land here too: the schema is strict on purpose, so a
      // caller cannot smuggle an image, mount or capability past the contract.
      return errorResponse(
        c,
        "invalid_request",
        "Invalid create request.",
        parsed.error.flatten(),
      );
    }

    const { sandbox, created } = await service.create(parsed.data);
    return c.json(sandbox, created ? 201 : 200);
  });

  app.get("/v1/sandboxes", async (c) => {
    const service = getService();
    if (!service) return errorResponse(c, "not_ready", "Docker is not available.");
    return c.json({ sandboxes: await service.list() });
  });

  app.get("/v1/sandboxes/:id", async (c) => {
    const service = getService();
    if (!service) return errorResponse(c, "not_ready", "Docker is not available.");
    return c.json(await service.get(sandboxIdParam(c)));
  });

  app.post("/v1/sandboxes/:id/start", async (c) => {
    const service = getService();
    if (!service) return errorResponse(c, "not_ready", "Docker is not available.");
    return c.json(await service.start(sandboxIdParam(c)));
  });

  app.post("/v1/sandboxes/:id/stop", async (c) => {
    const service = getService();
    if (!service) return errorResponse(c, "not_ready", "Docker is not available.");
    return c.json(await service.stop(sandboxIdParam(c)));
  });

  app.delete("/v1/sandboxes/:id", async (c) => {
    const service = getService();
    if (!service) return errorResponse(c, "not_ready", "Docker is not available.");
    return c.json(await service.remove(sandboxIdParam(c)));
  });
}
