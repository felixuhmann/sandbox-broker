import { ERROR_STATUS, type ErrorCode } from "@sandbox-broker/contracts";
import type { Context } from "hono";

/** Error carrying a contract error code, safe to surface to the caller. */
export class BrokerError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "BrokerError";
    this.code = code;
    this.details = details;
  }
}

export function errorResponse(
  c: Context,
  code: ErrorCode,
  message: string,
  details?: unknown,
): Response {
  const body =
    details === undefined
      ? { error: { code, message } }
      : { error: { code, message, details } };
  return c.json(body, ERROR_STATUS[code]);
}

export function errorBody(code: ErrorCode, message: string, details?: unknown) {
  return details === undefined
    ? { error: { code, message } }
    : { error: { code, message, details } };
}
