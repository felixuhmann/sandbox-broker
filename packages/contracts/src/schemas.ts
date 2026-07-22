import { posix as posixPath } from "node:path";

import { z } from "zod";

/** Pinned major version of the broker control API. */
export const BROKER_API_VERSION = "v1" as const;

/** Absolute path of the only writable, persistent directory in a sandbox. */
export const WORKSPACE_ROOT = "/workspace" as const;

/**
 * v1 supports exactly two modes. There is deliberately no CIDR/domain allowlist:
 * a caller holding a legacy allowlist must fail closed rather than be silently
 * widened to `unrestricted`.
 */
export const NetworkMode = z.enum(["deny-all", "unrestricted"]);
export type NetworkMode = z.infer<typeof NetworkMode>;

export const SandboxState = z.enum(["starting", "started", "stopped", "error", "deleted"]);
export type SandboxState = z.infer<typeof SandboxState>;

export const SandboxLimits = z
  .object({
    cpuCores: z.number().positive().max(8),
    memoryMiB: z.number().int().min(128).max(32_768),
    pids: z.number().int().min(16).max(4096),
    workspaceMiB: z.number().int().min(64).max(32_768),
  })
  .strict();
export type SandboxLimits = z.infer<typeof SandboxLimits>;

const Identifier = z.string().min(1).max(200);

export const CreateSandboxRequest = z
  .object({
    idempotencyKey: Identifier,
    ownerRef: Identifier,
    networkMode: NetworkMode,
    limits: SandboxLimits,
  })
  .strict();
export type CreateSandboxRequest = z.infer<typeof CreateSandboxRequest>;

export const Sandbox = z
  .object({
    id: z.string().uuid(),
    ownerRef: Identifier,
    networkMode: NetworkMode,
    limits: SandboxLimits,
    state: SandboxState,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    workspacePath: z.literal(WORKSPACE_ROOT),
    /** Set when `state === "error"`; never contains host paths or Docker ids. */
    message: z.string().max(2_000).optional(),
  })
  .strict();
export type Sandbox = z.infer<typeof Sandbox>;

export const SandboxList = z.object({ sandboxes: z.array(Sandbox) }).strict();
export type SandboxList = z.infer<typeof SandboxList>;

/**
 * Rejects anything that does not normalize to a path strictly beneath
 * {@link WORKSPACE_ROOT}. Applied in the contract so traversal never reaches
 * the Docker layer at all.
 */
export function normalizeWorkspacePath(input: string): string | null {
  if (input.length === 0 || input.includes("\0")) return null;
  if (!input.startsWith("/")) return null;
  // `normalize` keeps a trailing slash, which would leave an empty basename.
  const normalized = posixPath.normalize(input).replace(/\/+$/, "");
  if (normalized === WORKSPACE_ROOT) return null;
  if (!normalized.startsWith(`${WORKSPACE_ROOT}/`)) return null;
  // `normalize` collapses `..`; a surviving segment means the input escaped.
  if (normalized.split("/").includes("..")) return null;
  return normalized;
}

const WorkspacePath = z
  .string()
  .max(4_096)
  .refine((value) => normalizeWorkspacePath(value) !== null, {
    message: `path must be an absolute path beneath ${WORKSPACE_ROOT}`,
  });

/** Working directory may be the workspace root itself, unlike file paths. */
const WorkspaceDir = z
  .string()
  .max(4_096)
  .refine(
    (value) => value === WORKSPACE_ROOT || normalizeWorkspacePath(value) !== null,
    { message: `cwd must be ${WORKSPACE_ROOT} or a directory beneath it` },
  );

export const FilePathQuery = z.object({ path: WorkspacePath }).strict();
export type FilePathQuery = z.infer<typeof FilePathQuery>;

export const DeleteFileQuery = z
  .object({
    path: WorkspacePath,
    recursive: z
      .union([z.boolean(), z.enum(["true", "false"])])
      .transform((v) => v === true || v === "true")
      .optional()
      .default(false),
  })
  .strict();
export type DeleteFileQuery = z.input<typeof DeleteFileQuery>;

/** Hard server-side ceiling. A request may ask for less, never for more. */
export const MAX_EXEC_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_EXEC_TIMEOUT_MS = 5 * 60 * 1000;

export const ExecRequest = z
  .object({
    /** Executed with `sh -lc` as the sandbox's unprivileged user. */
    command: z.string().min(1).max(200_000),
    cwd: WorkspaceDir.optional(),
    /**
     * Extra environment for this command only. Values are secret-bearing by
     * assumption and are never logged.
     */
    env: z
      .record(
        z.string().min(1).max(256).regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
        z.string().max(32_768),
      )
      .refine((value) => Object.keys(value).length <= 128, {
        message: "at most 128 environment variables",
      })
      .optional(),
    timeoutMs: z.number().int().min(1_000).max(MAX_EXEC_TIMEOUT_MS).optional(),
  })
  .strict();
export type ExecRequest = z.infer<typeof ExecRequest>;

const ExecFrameBase = {
  executionId: z.string().min(1).max(200),
  /** Monotonically increasing, starting at 1, per execution. */
  seq: z.number().int().min(1),
};

export const ExecStdoutEvent = z
  .object({ type: z.literal("stdout"), ...ExecFrameBase, dataBase64: z.string() })
  .strict();
export const ExecStderrEvent = z
  .object({ type: z.literal("stderr"), ...ExecFrameBase, dataBase64: z.string() })
  .strict();
export const ExecResultEvent = z
  .object({
    type: z.literal("result"),
    ...ExecFrameBase,
    /** 124 on timeout, 130 on cancellation, otherwise the process exit code. */
    exitCode: z.number().int().min(0).max(255),
    timedOut: z.boolean(),
    cancelled: z.boolean(),
    durationMs: z.number().int().min(0),
  })
  .strict();
export const ExecErrorEvent = z
  .object({
    type: z.literal("error"),
    ...ExecFrameBase,
    code: z.string().min(1).max(64),
    message: z.string().max(2_000),
  })
  .strict();

export const ExecEvent = z.discriminatedUnion("type", [
  ExecStdoutEvent,
  ExecStderrEvent,
  ExecResultEvent,
  ExecErrorEvent,
]);
export type ExecEvent = z.infer<typeof ExecEvent>;

export const EXEC_TIMEOUT_EXIT_CODE = 124;
export const EXEC_CANCELLED_EXIT_CODE = 130;

export const HealthResponse = z.object({ status: z.literal("ok") }).strict();

export const ReadyResponse = z
  .object({
    ready: z.boolean(),
    apiVersion: z.literal(BROKER_API_VERSION),
    brokerVersion: z.string(),
    checks: z.array(
      z
        .object({
          name: z.string(),
          ok: z.boolean(),
          detail: z.string().max(500).optional(),
        })
        .strict(),
    ),
  })
  .strict();
export type ReadyResponse = z.infer<typeof ReadyResponse>;

/**
 * `hard` means the host can enforce a byte ceiling on the workspace volume.
 * `watchdog` means the broker only samples usage and stops execution on breach.
 * See docs/workspace-quota.md.
 */
export const QuotaMode = z.enum(["hard", "watchdog"]);
export type QuotaMode = z.infer<typeof QuotaMode>;

export const CapabilitiesResponse = z
  .object({
    apiVersion: z.literal(BROKER_API_VERSION),
    brokerVersion: z.string(),
    networkModes: z.array(NetworkMode),
    /** Not implemented in v1 and deliberately not advertised as available. */
    archive: z.literal(false),
    recover: z.literal(false),
    limits: SandboxLimits,
    workspaceQuota: z
      .object({ mode: QuotaMode, enforced: z.boolean(), detail: z.string().max(500) })
      .strict(),
    maxExecTimeoutMs: z.number().int().positive(),
  })
  .strict();
export type CapabilitiesResponse = z.infer<typeof CapabilitiesResponse>;

export const ErrorCode = z.enum([
  "invalid_request",
  "unauthorized",
  "not_found",
  "conflict",
  "unsupported_policy",
  "rate_limited",
  "not_ready",
  "sandbox_error",
  "internal",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorResponse = z
  .object({
    error: z
      .object({
        code: ErrorCode,
        message: z.string().max(2_000),
        details: z.unknown().optional(),
      })
      .strict(),
  })
  .strict();
export type ErrorResponse = z.infer<typeof ErrorResponse>;

/** Canonical HTTP status for each error code. */
export const ERROR_STATUS: Record<ErrorCode, 400 | 401 | 404 | 409 | 422 | 429 | 503 | 500> = {
  invalid_request: 400,
  unauthorized: 401,
  not_found: 404,
  conflict: 409,
  unsupported_policy: 422,
  rate_limited: 429,
  not_ready: 503,
  sandbox_error: 409,
  internal: 500,
};
