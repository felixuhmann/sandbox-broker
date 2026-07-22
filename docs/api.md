# Broker v1 API

The machine-readable contract is [`openapi/openapi.json`](../openapi/openapi.json),
generated from the Zod schemas in `packages/contracts`. `pnpm openapi:check`
fails when the committed document has drifted.

## Authentication

Every route except `GET /healthz` requires `Authorization: Bearer <token>`. The
token is compared in constant time. There is no unauthenticated mode and CORS is
disabled, because the broker is only ever reachable on a private network.

## Fixed request surface

`POST /v1/sandboxes` accepts exactly four fields — `idempotencyKey`, `ownerRef`,
`networkMode`, `limits` — and rejects unknown fields with `400`. There is no way
to select an image, bind mount, capability, device, user, namespace, or
privileged flag through the API. This is a security property, not an oversight.

## Error envelope

All errors share one shape:

```json
{ "error": { "code": "invalid_request", "message": "human readable", "details": {} } }
```

`details` is optional and never contains the bearer token, environment values,
host paths, or Docker container ids.

| Code | HTTP | Meaning |
|---|---|---|
| `invalid_request` | 400 | Malformed body/query, or an unknown field. |
| `unauthorized` | 401 | Missing or wrong bearer token. |
| `not_found` | 404 | No broker-owned sandbox with that id. |
| `conflict` | 409 | Idempotency key reused with a different configuration; or an execution is already running; or the workspace quota is exceeded. |
| `sandbox_error` | 409 | The sandbox is in a state that cannot serve the request. |
| `unsupported_policy` | 422 | A policy this broker version cannot honour (for example a CIDR allowlist). Fails closed; never widened. |
| `rate_limited` | 429 | Too many in-flight operations, or the broker is at `SANDBOX_BROKER_MAX_SANDBOXES`. On create, `details` carries `{ maxSandboxes, inUse }` and nothing was created. |
| `not_ready` | 503 | Docker unreachable, required images missing, or the configured quota mode is unenforceable. |
| `internal` | 500 | Unexpected failure. Details are logged, not returned. |

## Exec stream

`POST /v1/sandboxes/{id}/exec` responds with `application/x-ndjson`: one JSON
object per line.

```jsonc
{"type":"stdout","executionId":"...","seq":1,"dataBase64":"aGkK"}
{"type":"stderr","executionId":"...","seq":2,"dataBase64":"..."}
{"type":"result","executionId":"...","seq":3,"exitCode":0,"timedOut":false,"cancelled":false,"durationMs":42}
```

- `seq` starts at 1 and increases by one per frame, across both streams.
- Output is base64 so arbitrary binary bytes survive the transport.
- The stream always terminates with exactly one `result` or `error` frame.
- `exitCode` is `124` when `timedOut`, `130` when `cancelled`.
- Disconnecting cancels the execution.
- Only one execution runs per sandbox at a time; a second request gets `409`.

After a timeout or cancellation the broker restarts the sandbox and re-applies
the network policy before accepting the next command, so no reparented process
can survive. `/workspace` is preserved across that restart.

## Files

`GET|PUT|DELETE /v1/sandboxes/{id}/files?path=/workspace/...`

Bodies are raw bytes (`application/octet-stream`), so uploads and downloads are
binary-safe. Paths must normalize to a location strictly beneath `/workspace`;
anything else is rejected by the contract before it reaches Docker. Writes are
atomic (temporary file + rename).
