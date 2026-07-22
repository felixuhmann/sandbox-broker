import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { routes, type RouteDefinition, type RouteResponse } from "./routes.js";
import { BROKER_API_VERSION } from "./schemas.js";

type JsonObject = Record<string, unknown>;

function jsonSchema(schema: z.ZodTypeAny): JsonObject {
  const converted = zodToJsonSchema(schema, {
    target: "openApi3",
    $refStrategy: "none",
    errorMessages: false,
  }) as JsonObject;
  delete converted["$schema"];
  return converted;
}

/** Unwraps optional/default/effect wrappers to find the underlying object shape. */
function objectShape(schema: z.ZodTypeAny): Record<string, z.ZodTypeAny> | null {
  let current: z.ZodTypeAny = schema;
  for (let i = 0; i < 8; i += 1) {
    if (current instanceof z.ZodObject) {
      return current.shape as Record<string, z.ZodTypeAny>;
    }
    if (current instanceof z.ZodEffects) {
      current = current.innerType();
      continue;
    }
    if (current instanceof z.ZodOptional || current instanceof z.ZodDefault) {
      current = current._def.innerType as z.ZodTypeAny;
      continue;
    }
    return null;
  }
  return null;
}

function isRequired(schema: z.ZodTypeAny): boolean {
  return !schema.isOptional();
}

function responseObject(response: RouteResponse): JsonObject {
  const out: JsonObject = { description: response.description };
  if (response.schema) {
    out["content"] = {
      [response.contentType ?? "application/json"]: { schema: jsonSchema(response.schema) },
    };
  } else if (response.contentType) {
    out["content"] = {
      [response.contentType]: { schema: { type: "string", format: "binary" } },
    };
  }
  return out;
}

function operationObject(route: RouteDefinition): JsonObject {
  const operation: JsonObject = {
    operationId: route.operationId,
    summary: route.summary,
    tags: [route.path.startsWith("/v1/sandboxes") ? "sandboxes" : "service"],
  };
  if (route.description) operation["description"] = route.description;
  operation["security"] = route.auth ? [{ bearerAuth: [] }] : [];

  const parameters: JsonObject[] = [];
  for (const name of route.pathParams ?? []) {
    parameters.push({
      name,
      in: "path",
      required: true,
      schema: { type: "string", format: "uuid" },
    });
  }
  const queryShape = route.query ? objectShape(route.query) : null;
  if (queryShape) {
    for (const [name, schema] of Object.entries(queryShape)) {
      parameters.push({
        name,
        in: "query",
        required: isRequired(schema),
        schema: jsonSchema(schema),
      });
    }
  }
  if (parameters.length > 0) operation["parameters"] = parameters;

  if (route.requestBody) {
    const contentType = route.requestBody.contentType ?? "application/json";
    const schema = route.requestBody.schema
      ? jsonSchema(route.requestBody.schema)
      : { type: "string", format: "binary" };
    const body: JsonObject = { required: true, content: { [contentType]: { schema } } };
    if (route.requestBody.description) body["description"] = route.requestBody.description;
    operation["requestBody"] = body;
  }

  const responses: JsonObject = {};
  for (const status of Object.keys(route.responses).sort()) {
    responses[status] = responseObject(route.responses[status]!);
  }
  operation["responses"] = responses;
  return operation;
}

/**
 * Builds the OpenAPI document. Output is a pure function of {@link routes} so
 * `openapi:check` can detect uncommitted contract drift.
 */
export function buildOpenApiDocument(version: string): JsonObject {
  const paths: JsonObject = {};
  for (const route of routes) {
    const existing = (paths[route.path] as JsonObject | undefined) ?? {};
    existing[route.method.toLowerCase()] = operationObject(route);
    paths[route.path] = existing;
  }

  return {
    openapi: "3.0.3",
    info: {
      title: "sandbox-broker",
      version,
      description:
        "Authenticated control API for hardened, single-tenant Docker sandboxes. " +
        "Requests carry a fixed option set: the API never accepts an image, bind mount, " +
        "capability, device, user or privileged flag.",
      license: { name: "Apache-2.0", url: "https://www.apache.org/licenses/LICENSE-2.0" },
    },
    servers: [{ url: "/", description: "Private broker endpoint" }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "opaque" },
      },
    },
    tags: [
      { name: "service", description: "Health, readiness and capabilities" },
      { name: "sandboxes", description: `Sandbox lifecycle, exec and files (${BROKER_API_VERSION})` },
    ],
    paths,
  };
}
