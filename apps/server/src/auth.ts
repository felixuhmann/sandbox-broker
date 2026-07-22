import { createHash, timingSafeEqual } from "node:crypto";

import type { MiddlewareHandler } from "hono";

import { errorResponse } from "./errors.js";

/**
 * Constant-time comparison. Both sides are hashed first so the comparison
 * operates on equal-length buffers and leaks neither the token nor its length.
 */
export function tokensMatch(expected: string, provided: string): boolean {
  if (provided.length === 0) return false;
  const a = createHash("sha256").update(expected, "utf8").digest();
  const b = createHash("sha256").update(provided, "utf8").digest();
  return timingSafeEqual(a, b);
}

const BEARER_PREFIX = /^Bearer (.+)$/;

/** Rejects every request without the exact configured bearer token. */
export function bearerAuth(expected: string): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header("authorization");
    const match = header ? BEARER_PREFIX.exec(header) : null;
    if (!match || !tokensMatch(expected, match[1]!.trim())) {
      return errorResponse(c, "unauthorized", "Missing or invalid bearer token.");
    }
    await next();
  };
}
