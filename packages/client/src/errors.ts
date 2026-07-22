import type { ErrorCode } from "@sandbox-broker/contracts";

/** Base class for everything this client throws, so callers can catch once. */
export class SandboxBrokerError extends Error {
  /** Contract `operationId` the failure belongs to, e.g. `createSandbox`. */
  readonly operationId: string;

  constructor(operationId: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.operationId = operationId;
  }
}

/**
 * The request never left the client: it failed contract validation locally.
 * Catching this is how a caller distinguishes its own bug from a broker fault.
 */
export class BrokerRequestError extends SandboxBrokerError {
  readonly issues: unknown;

  constructor(operationId: string, message: string, issues?: unknown) {
    super(operationId, message);
    this.issues = issues;
  }
}

/** The broker answered with a contract error envelope (or a non-2xx status). */
export class BrokerApiError extends SandboxBrokerError {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(
    operationId: string,
    input: { status: number; code: ErrorCode; message: string; details?: unknown },
  ) {
    super(operationId, input.message);
    this.status = input.status;
    this.code = input.code;
    this.details = input.details;
  }
}

/**
 * The broker answered 2xx with a body that does not match the committed
 * contract — a version skew or a proxy rewriting responses. Never treated as
 * success, because the typed return value would be a lie.
 */
export class BrokerResponseError extends SandboxBrokerError {
  readonly status: number;
  readonly issues: unknown;

  constructor(operationId: string, message: string, input: { status: number; issues?: unknown }) {
    super(operationId, message);
    this.status = input.status;
    this.issues = input.issues;
  }
}

export type BrokerStreamErrorReason =
  | "malformed_json"
  | "invalid_frame"
  | "sequence"
  | "execution_id"
  | "missing_terminal"
  | "after_terminal"
  | "line_too_long";

/**
 * The NDJSON exec stream broke its own protocol. Every reason means output was
 * lost, reordered or forged, so the execution result must not be trusted.
 */
export class BrokerStreamError extends SandboxBrokerError {
  readonly reason: BrokerStreamErrorReason;
  readonly issues: unknown;

  constructor(
    operationId: string,
    reason: BrokerStreamErrorReason,
    message: string,
    issues?: unknown,
  ) {
    super(operationId, message);
    this.reason = reason;
    this.issues = issues;
  }
}

/** The execution itself ended with a terminal `error` frame. */
export class BrokerExecError extends SandboxBrokerError {
  readonly code: string;
  readonly executionId: string;

  constructor(operationId: string, input: { code: string; message: string; executionId: string }) {
    super(operationId, input.message);
    this.code = input.code;
    this.executionId = input.executionId;
  }
}
