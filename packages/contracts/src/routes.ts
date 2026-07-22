import type { z } from "zod";

import {
  CapabilitiesResponse,
  CreateSandboxRequest,
  DeleteFileQuery,
  ErrorResponse,
  ExecEvent,
  ExecRequest,
  FilePathQuery,
  HealthResponse,
  ReadyResponse,
  Sandbox,
  SandboxList,
} from "./schemas.js";

export type RouteResponse = {
  description: string;
  schema?: z.ZodTypeAny;
  /** Defaults to `application/json`. */
  contentType?: string;
};

export type RouteDefinition = {
  operationId: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** OpenAPI-style template path, e.g. `/v1/sandboxes/{id}`. */
  path: string;
  summary: string;
  description?: string;
  /** `false` only for liveness. */
  auth: boolean;
  pathParams?: readonly string[];
  query?: z.ZodTypeAny;
  requestBody?: { schema?: z.ZodTypeAny; contentType?: string; description?: string };
  responses: Record<string, RouteResponse>;
};

const errorResponse = (description: string): RouteResponse => ({
  description,
  schema: ErrorResponse,
});

/** Errors every authenticated route can return. */
const commonErrors: Record<string, RouteResponse> = {
  "400": errorResponse("Malformed request or unknown field."),
  "401": errorResponse("Missing or invalid bearer token."),
  "429": errorResponse("Too many in-flight operations."),
  "503": errorResponse("Broker or Docker not ready."),
};

const sandboxErrors: Record<string, RouteResponse> = {
  ...commonErrors,
  "404": errorResponse("No broker-owned sandbox with this id."),
};

export const routes: readonly RouteDefinition[] = [
  {
    operationId: "getHealth",
    method: "GET",
    path: "/healthz",
    summary: "Liveness probe",
    description: "Unauthenticated. Reports process liveness only, never Docker internals.",
    auth: false,
    responses: {
      "200": { description: "Process is alive.", schema: HealthResponse },
    },
  },
  {
    operationId: "getReady",
    method: "GET",
    path: "/v1/ready",
    summary: "Readiness probe",
    description:
      "Authenticated. Verifies Docker connectivity, required images, and the configured workspace quota mode.",
    auth: true,
    responses: {
      "200": { description: "Broker is ready.", schema: ReadyResponse },
      "401": commonErrors["401"]!,
      "503": { description: "Broker is not ready.", schema: ReadyResponse },
    },
  },
  {
    operationId: "getCapabilities",
    method: "GET",
    path: "/v1/capabilities",
    summary: "Capability and version report",
    auth: true,
    responses: {
      "200": { description: "Capabilities.", schema: CapabilitiesResponse },
      "401": commonErrors["401"]!,
      "503": commonErrors["503"]!,
    },
  },
  {
    operationId: "createSandbox",
    method: "POST",
    path: "/v1/sandboxes",
    summary: "Create a sandbox idempotently",
    description:
      "Repeating a request with the same idempotencyKey and identical configuration returns the existing sandbox. A conflicting configuration returns 409.",
    auth: true,
    requestBody: { schema: CreateSandboxRequest },
    responses: {
      "201": { description: "Sandbox created.", schema: Sandbox },
      "200": { description: "Existing sandbox for this idempotency key.", schema: Sandbox },
      ...commonErrors,
      "409": errorResponse("Idempotency key reused with a different configuration."),
      "422": errorResponse("Requested policy is not supported by this broker version."),
    },
  },
  {
    operationId: "listSandboxes",
    method: "GET",
    path: "/v1/sandboxes",
    summary: "List broker-owned sandboxes",
    description: "Only containers carrying this broker's ownership labels are returned.",
    auth: true,
    responses: {
      "200": { description: "Sandboxes.", schema: SandboxList },
      ...commonErrors,
    },
  },
  {
    operationId: "getSandbox",
    method: "GET",
    path: "/v1/sandboxes/{id}",
    summary: "Get normalized sandbox state",
    auth: true,
    pathParams: ["id"],
    responses: {
      "200": { description: "Sandbox.", schema: Sandbox },
      ...sandboxErrors,
    },
  },
  {
    operationId: "startSandbox",
    method: "POST",
    path: "/v1/sandboxes/{id}/start",
    summary: "Start a sandbox",
    description:
      "Returns only after the network policy has been re-applied and verified for the new network namespace.",
    auth: true,
    pathParams: ["id"],
    responses: {
      "200": { description: "Sandbox started.", schema: Sandbox },
      ...sandboxErrors,
    },
  },
  {
    operationId: "stopSandbox",
    method: "POST",
    path: "/v1/sandboxes/{id}/stop",
    summary: "Stop a sandbox, preserving its workspace",
    auth: true,
    pathParams: ["id"],
    responses: {
      "200": { description: "Sandbox stopped.", schema: Sandbox },
      ...sandboxErrors,
    },
  },
  {
    operationId: "deleteSandbox",
    method: "DELETE",
    path: "/v1/sandboxes/{id}",
    summary: "Delete a sandbox and its workspace",
    auth: true,
    pathParams: ["id"],
    responses: {
      "200": { description: "Sandbox deleted.", schema: Sandbox },
      ...sandboxErrors,
    },
  },
  {
    operationId: "execCommand",
    method: "POST",
    path: "/v1/sandboxes/{id}/exec",
    summary: "Execute a shell command, streaming NDJSON events",
    description:
      "One execution per sandbox at a time. The response is newline-delimited ExecEvent frames; the stream always ends with a `result` or `error` frame. Disconnecting the client cancels the execution.",
    auth: true,
    pathParams: ["id"],
    requestBody: { schema: ExecRequest },
    responses: {
      "200": {
        description: "NDJSON event stream.",
        schema: ExecEvent,
        contentType: "application/x-ndjson",
      },
      ...sandboxErrors,
      "409": errorResponse("Another execution is already running in this sandbox."),
    },
  },
  {
    operationId: "readFile",
    method: "GET",
    path: "/v1/sandboxes/{id}/files",
    summary: "Read a workspace file",
    auth: true,
    pathParams: ["id"],
    query: FilePathQuery,
    responses: {
      "200": {
        description: "Raw file bytes.",
        contentType: "application/octet-stream",
      },
      ...sandboxErrors,
    },
  },
  {
    operationId: "writeFile",
    method: "PUT",
    path: "/v1/sandboxes/{id}/files",
    summary: "Write a workspace file atomically",
    description: "Parent directories are created. The write lands via a temporary file + rename.",
    auth: true,
    pathParams: ["id"],
    query: FilePathQuery,
    requestBody: { contentType: "application/octet-stream", description: "Raw file bytes." },
    responses: {
      "204": { description: "File written." },
      ...sandboxErrors,
      "409": errorResponse("Workspace quota exceeded."),
    },
  },
  {
    operationId: "deleteFile",
    method: "DELETE",
    path: "/v1/sandboxes/{id}/files",
    summary: "Delete a workspace path",
    auth: true,
    pathParams: ["id"],
    query: DeleteFileQuery,
    responses: {
      "204": { description: "Path deleted." },
      ...sandboxErrors,
    },
  },
];
