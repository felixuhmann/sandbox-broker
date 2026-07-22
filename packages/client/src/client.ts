import {
  CapabilitiesResponse,
  CreateSandboxRequest,
  DeleteFileQuery,
  ERROR_STATUS,
  ErrorResponse,
  ExecRequest,
  FilePathQuery,
  HealthResponse,
  ReadyResponse,
  routes,
  Sandbox,
  SandboxList,
  type ErrorCode,
  type ExecEvent,
  type ExecResultEvent,
  type RouteDefinition,
} from "@sandbox-broker/contracts";
import type { z } from "zod";

import {
  BrokerApiError,
  BrokerExecError,
  BrokerRequestError,
  BrokerResponseError,
} from "./errors.js";
import { parseExecStream } from "./stream.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type SandboxBrokerClientOptions = {
  /** Base URL of the broker, e.g. `http://sandbox-broker:8080`. */
  baseUrl: string;
  /** Bearer token. Sent only on routes the contract marks as authenticated. */
  token: string;
  /** Injectable for tests and for callers with their own agent/proxy setup. */
  fetch?: FetchLike;
};

export type RequestOptions = {
  signal?: AbortSignal;
};

export type DeleteFileOptions = RequestOptions & {
  recursive?: boolean;
};

/** Body accepted by {@link SandboxBrokerClient.writeFile}. */
export type FileUpload = Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>;

/** The terminal `result` frame of an execution. */
export type ExecResult = z.infer<typeof ExecResultEvent>;

export type ExecOutcome = {
  stdout: Uint8Array;
  stderr: Uint8Array;
  result: ExecResult;
};

/**
 * Route table keyed by contract `operationId`.
 *
 * Method and path template come from `@sandbox-broker/contracts`, which is also
 * what generates `openapi/openapi.json`. A route that moves in the contract
 * moves here with it instead of drifting inside a hand-maintained string.
 */
const ROUTES: ReadonlyMap<string, RouteDefinition> = new Map(
  routes.map((route) => [route.operationId, route]),
);

function route(operationId: string): RouteDefinition {
  const found = ROUTES.get(operationId);
  if (!found) throw new Error(`Unknown broker operation: ${operationId}`);
  return found;
}

/** Fallback when a proxy or a crash returns a status without a contract body. */
const STATUS_CODES: ReadonlyMap<number, ErrorCode> = new Map(
  (Object.entries(ERROR_STATUS) as [ErrorCode, number][])
    // `sandbox_error` shares 409 with `conflict`; the first entry wins and
    // `conflict` is the safer generic reading of a bare 409.
    .filter(([code]) => code !== "sandbox_error")
    .map(([code, status]) => [status, code]),
);

function statusErrorCode(status: number): ErrorCode {
  return STATUS_CODES.get(status) ?? "internal";
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

function fillPath(definition: RouteDefinition, params: Record<string, string>): string {
  return definition.path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`Missing path parameter ${name} for ${definition.operationId}`);
    }
    return encodeURIComponent(value);
  });
}

/**
 * Path validation happens client-side against the same schema the server uses,
 * so a traversal attempt never reaches the network.
 */
function fileQuery(operationId: string, input: { path: string }): Record<string, string> {
  return { path: validateRequest(operationId, FilePathQuery, input).path };
}

function validateRequest<T>(operationId: string, schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new BrokerRequestError(
      operationId,
      `Request does not satisfy the broker v1 contract for ${operationId}.`,
      parsed.error.issues,
    );
  }
  return parsed.data;
}

async function readErrorBody(response: Response): Promise<unknown> {
  try {
    return JSON.parse(await response.text()) as unknown;
  } catch {
    return null;
  }
}

/** Never includes request headers, so the bearer token cannot leak into logs. */
async function apiError(operationId: string, response: Response): Promise<BrokerApiError> {
  const envelope = ErrorResponse.safeParse(await readErrorBody(response));
  if (envelope.success) {
    return new BrokerApiError(operationId, {
      status: response.status,
      code: envelope.data.error.code,
      message: envelope.data.error.message,
      details: envelope.data.error.details,
    });
  }
  return new BrokerApiError(operationId, {
    status: response.status,
    code: statusErrorCode(response.status),
    message: `Broker request ${operationId} failed with HTTP ${response.status}.`,
  });
}

export class SandboxBrokerClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetch: FetchLike;

  constructor(options: SandboxBrokerClientOptions) {
    if (!options.baseUrl) throw new Error("baseUrl is required.");
    if (!options.token) throw new Error("token is required.");
    this.#baseUrl = options.baseUrl;
    this.#token = options.token;
    this.#fetch =
      options.fetch ?? ((input, init) => globalThis.fetch(input, init as RequestInit));
  }

  // -- service -------------------------------------------------------------

  /** Liveness. Unauthenticated by contract; the token is not sent. */
  async health(options: RequestOptions = {}): Promise<z.infer<typeof HealthResponse>> {
    const response = await this.#send("getHealth", {}, options);
    return this.#json("getHealth", response, HealthResponse);
  }

  /**
   * Readiness. A not-ready broker answers 503 with the same body, so that is
   * returned rather than thrown: `ready: false` is an answer, not a failure.
   */
  async ready(options: RequestOptions = {}): Promise<z.infer<typeof ReadyResponse>> {
    const response = await this.#send("getReady", {}, options, { allowStatus: [503] });
    return this.#json("getReady", response, ReadyResponse);
  }

  async capabilities(
    options: RequestOptions = {},
  ): Promise<z.infer<typeof CapabilitiesResponse>> {
    const response = await this.#send("getCapabilities", {}, options);
    return this.#json("getCapabilities", response, CapabilitiesResponse);
  }

  // -- lifecycle -----------------------------------------------------------

  /**
   * Idempotent creation. `created` is false when the broker replayed an
   * existing sandbox for the same idempotency key.
   */
  async createSandbox(
    request: z.input<typeof CreateSandboxRequest>,
    options: RequestOptions = {},
  ): Promise<{ sandbox: z.infer<typeof Sandbox>; created: boolean }> {
    const body = validateRequest("createSandbox", CreateSandboxRequest, request);
    const response = await this.#send("createSandbox", {}, options, { json: body });
    const sandbox = await this.#json("createSandbox", response, Sandbox);
    return { sandbox, created: response.status === 201 };
  }

  async listSandboxes(options: RequestOptions = {}): Promise<z.infer<typeof Sandbox>[]> {
    const response = await this.#send("listSandboxes", {}, options);
    return (await this.#json("listSandboxes", response, SandboxList)).sandboxes;
  }

  async getSandbox(id: string, options: RequestOptions = {}): Promise<z.infer<typeof Sandbox>> {
    const response = await this.#send("getSandbox", { id }, options);
    return this.#json("getSandbox", response, Sandbox);
  }

  /** Returns only after the broker re-applied and verified the network policy. */
  async startSandbox(id: string, options: RequestOptions = {}): Promise<z.infer<typeof Sandbox>> {
    const response = await this.#send("startSandbox", { id }, options);
    return this.#json("startSandbox", response, Sandbox);
  }

  async stopSandbox(id: string, options: RequestOptions = {}): Promise<z.infer<typeof Sandbox>> {
    const response = await this.#send("stopSandbox", { id }, options);
    return this.#json("stopSandbox", response, Sandbox);
  }

  /** Removes the container *and* the workspace volume. */
  async deleteSandbox(id: string, options: RequestOptions = {}): Promise<z.infer<typeof Sandbox>> {
    const response = await this.#send("deleteSandbox", { id }, options);
    return this.#json("deleteSandbox", response, Sandbox);
  }

  // -- workspace files -----------------------------------------------------

  async readFile(id: string, path: string, options: RequestOptions = {}): Promise<Uint8Array> {
    const response = await this.#readFileResponse(id, path, options);
    return new Uint8Array(await response.arrayBuffer());
  }

  /** Streaming variant for files too large to hold in memory. */
  async readFileStream(
    id: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<ReadableStream<Uint8Array>> {
    const response = await this.#readFileResponse(id, path, options);
    if (!response.body) {
      throw new BrokerResponseError("readFile", "Broker returned a file response with no body.", {
        status: response.status,
      });
    }
    return response.body as ReadableStream<Uint8Array>;
  }

  async writeFile(
    id: string,
    path: string,
    body: FileUpload,
    options: RequestOptions = {},
  ): Promise<void> {
    await this.#send(
      "writeFile",
      { id },
      options,
      {
        query: fileQuery("writeFile", { path }),
        body,
        contentType: "application/octet-stream",
      },
    );
  }

  async deleteFile(id: string, path: string, options: DeleteFileOptions = {}): Promise<void> {
    const request =
      options.recursive === undefined ? { path } : { path, recursive: options.recursive };
    validateRequest("deleteFile", DeleteFileQuery, request);
    const query: Record<string, string> = { path };
    if (options.recursive !== undefined) query["recursive"] = String(options.recursive);
    await this.#send("deleteFile", { id }, options, { query });
  }

  // -- exec ----------------------------------------------------------------

  /**
   * Starts a command and returns its validated NDJSON frames.
   *
   * The HTTP round trip is awaited before any frame is yielded, so `404`,
   * `409` (an execution is already running) and `503` surface as thrown
   * {@link BrokerApiError}s instead of hiding inside a committed 200 stream.
   * Aborting `options.signal` cancels the execution broker-side.
   */
  async exec(
    id: string,
    request: z.input<typeof ExecRequest>,
    options: RequestOptions = {},
  ): Promise<AsyncIterable<ExecEvent>> {
    const body = validateRequest("execCommand", ExecRequest, request);
    const response = await this.#send("execCommand", { id }, options, {
      json: body,
      accept: "application/x-ndjson",
    });
    if (!response.body) {
      throw new BrokerResponseError("execCommand", "Broker returned an empty exec stream.", {
        status: response.status,
      });
    }
    return parseExecStream(response.body as ReadableStream<Uint8Array>, {
      ...(options.signal ? { signal: options.signal } : {}),
      operationId: "execCommand",
    });
  }

  /**
   * Convenience wrapper that buffers the whole execution. A terminal `error`
   * frame becomes a thrown {@link BrokerExecError}, so a caller that only looks
   * at `exitCode` cannot mistake a broken stream for a successful command.
   */
  async execCollect(
    id: string,
    request: z.input<typeof ExecRequest>,
    options: RequestOptions = {},
  ): Promise<ExecOutcome> {
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    let result: ExecResult | null = null;

    for await (const event of await this.exec(id, request, options)) {
      switch (event.type) {
        case "stdout":
          stdout.push(decodeBase64(event.dataBase64));
          break;
        case "stderr":
          stderr.push(decodeBase64(event.dataBase64));
          break;
        case "result":
          result = event;
          break;
        case "error":
          throw new BrokerExecError("execCommand", {
            code: event.code,
            message: event.message,
            executionId: event.executionId,
          });
      }
    }

    if (!result) {
      // parseExecStream guarantees a terminal frame, so this is unreachable
      // unless the parser contract itself changes.
      throw new BrokerResponseError("execCommand", "Exec stream produced no result frame.", {
        status: 200,
      });
    }
    return { stdout: concatBytes(stdout), stderr: concatBytes(stderr), result };
  }

  // -- internals -----------------------------------------------------------

  async #readFileResponse(
    id: string,
    path: string,
    options: RequestOptions,
  ): Promise<Response> {
    return this.#send("readFile", { id }, options, {
      query: fileQuery("readFile", { path }),
      accept: "application/octet-stream",
    });
  }

  async #send(
    operationId: string,
    params: Record<string, string>,
    options: RequestOptions,
    extra: {
      query?: Record<string, string>;
      json?: unknown;
      body?: FileUpload;
      contentType?: string;
      accept?: string;
      allowStatus?: number[];
    } = {},
  ): Promise<Response> {
    const definition = route(operationId);
    const search = new URLSearchParams(extra.query ?? {}).toString();
    const url = `${joinUrl(this.#baseUrl, fillPath(definition, params))}${
      search ? `?${search}` : ""
    }`;

    const headers: Record<string, string> = {
      Accept: extra.accept ?? "application/json",
    };
    if (definition.auth) headers["Authorization"] = `Bearer ${this.#token}`;
    if (extra.json !== undefined) headers["Content-Type"] = "application/json";
    else if (extra.contentType) headers["Content-Type"] = extra.contentType;

    const init: RequestInit & { duplex?: "half" } = {
      method: definition.method,
      headers,
    };
    if (extra.json !== undefined) init.body = JSON.stringify(extra.json);
    else if (extra.body !== undefined) {
      init.body = toBodyInit(extra.body);
      // Required by undici whenever the request body is a stream.
      if (extra.body instanceof ReadableStream) init.duplex = "half";
    }
    if (options.signal) init.signal = options.signal;

    const response = await this.#fetch(url, init);
    if (!response.ok && !(extra.allowStatus ?? []).includes(response.status)) {
      throw await apiError(operationId, response);
    }
    return response;
  }

  async #json<T>(operationId: string, response: Response, schema: z.ZodType<T>): Promise<T> {
    let body: unknown;
    try {
      body = (await response.json()) as unknown;
    } catch {
      throw new BrokerResponseError(operationId, "Broker returned a non-JSON response body.", {
        status: response.status,
      });
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new BrokerResponseError(
        operationId,
        `Broker response for ${operationId} does not match the v1 contract.`,
        { status: response.status, issues: parsed.error.issues },
      );
    }
    return parsed.data;
  }
}

/** `BodyInit` is not a global under `lib: ES2023`; derive it from `RequestInit`. */
type RequestBody = NonNullable<RequestInit["body"]>;

function toBodyInit(body: FileUpload): RequestBody {
  return body as RequestBody;
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function createSandboxBrokerClient(
  options: SandboxBrokerClientOptions,
): SandboxBrokerClient {
  return new SandboxBrokerClient(options);
}
