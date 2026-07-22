import type { Context } from "hono";

import { BrokerError } from "../errors.js";

/** Reads and parses a JSON body, turning malformed input into a 400. */
export async function parseJsonBody(c: Context): Promise<unknown> {
  const raw = await c.req.text();
  if (raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new BrokerError("invalid_request", "Request body is not valid JSON.");
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates the sandbox id before it reaches Docker. Ids are broker-generated
 * UUIDs, so anything else cannot name a broker-owned resource.
 */
export function sandboxIdParam(c: Context): string {
  const id = c.req.param("id") ?? "";
  if (!UUID.test(id)) {
    throw new BrokerError("not_found", "No broker-owned sandbox with this id.");
  }
  return id.toLowerCase();
}
