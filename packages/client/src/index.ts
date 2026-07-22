/**
 * Typed client for the sandbox-broker v1 control API.
 *
 * Every request and response is validated against `@sandbox-broker/contracts`,
 * the same Zod definitions that generate the committed `openapi/openapi.json`,
 * so there is no second, drifting copy of the wire types here.
 *
 * ```ts
 * const broker = createSandboxBrokerClient({ baseUrl, token });
 * const { sandbox } = await broker.createSandbox({ ... });
 * for await (const event of await broker.exec(sandbox.id, { command: "ls" })) {
 *   // stdout / stderr / result frames, validated and in order
 * }
 * ```
 */
export {
  createSandboxBrokerClient,
  SandboxBrokerClient,
  type DeleteFileOptions,
  type ExecOutcome,
  type ExecResult,
  type FetchLike,
  type FileUpload,
  type RequestOptions,
  type SandboxBrokerClientOptions,
} from "./client.js";

export {
  BrokerApiError,
  BrokerExecError,
  BrokerRequestError,
  BrokerResponseError,
  BrokerStreamError,
  SandboxBrokerError,
  type BrokerStreamErrorReason,
} from "./errors.js";

export { parseExecStream, type ByteSource, type ParseExecStreamOptions } from "./stream.js";

/**
 * The contract itself. Callers get the schemas and types without adding a
 * second dependency, and can validate their own payloads with the same rules
 * the broker applies.
 */
export {
  BROKER_API_VERSION,
  CapabilitiesResponse,
  CreateSandboxRequest,
  DEFAULT_EXEC_TIMEOUT_MS,
  DeleteFileQuery,
  ERROR_STATUS,
  ErrorCode,
  ErrorResponse,
  EXEC_CANCELLED_EXIT_CODE,
  EXEC_TIMEOUT_EXIT_CODE,
  ExecEvent,
  ExecRequest,
  ExecResultEvent,
  FilePathQuery,
  HealthResponse,
  MAX_EXEC_TIMEOUT_MS,
  NetworkMode,
  normalizeWorkspacePath,
  QuotaMode,
  ReadyResponse,
  Sandbox,
  SandboxLimits,
  SandboxList,
  SandboxState,
  WORKSPACE_ROOT,
} from "@sandbox-broker/contracts";
