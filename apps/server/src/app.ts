import { Hono } from "hono";

export type AppDeps = {
  /** Bearer token every control-plane route requires. */
  token: string;
  /** Docker-backed service layer; `null` keeps the app usable in unit tests. */
  docker: unknown;
};

export function createApp(_deps: AppDeps): Hono {
  const app = new Hono();

  // Liveness only. Never authenticated, never exposes Docker internals.
  app.get("/healthz", (c) => c.json({ status: "ok" }));

  return app;
}
