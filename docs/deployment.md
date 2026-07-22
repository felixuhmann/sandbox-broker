# Deploying sandbox-broker

## Topology

```text
┌─ private control network ────────────────────────┐
│  your app  ──HTTP+bearer──▶  sandbox-broker      │
│                                   │              │
└───────────────────────────────────┼──────────────┘
                                    │ /var/run/docker.sock
                                    ▼
                       ┌─ broker-owned egress bridge ─┐
                       │  sandbox   sandbox   sandbox │
                       └──────────────────────────────┘
```

Non-negotiables:

- **Only the broker gets the Docker socket.** It is equivalent to host root.
  Your application, your database and the sandboxes never receive it.
- **The broker publishes no host port and gets no public route.** It is reached
  over a private Docker network by service name.
- **The sandbox egress bridge is separate** from the application/database
  network, and is created and owned by the broker.
- Sandboxes publish no ports at all.

## Images

| Image | Purpose |
|---|---|
| `sandbox-broker/server` | The control API. Holds the Docker socket. |
| `sandbox-broker/sandbox` | The hardened sandbox. Inert PID 1. |
| `sandbox-broker/firewall` | Short-lived nftables helper. |

Build locally with `bash scripts/docker-build.sh`. **In production, pin by
digest** (`image@sha256:...`), not by tag, and pass the pinned sandbox and
firewall references to the broker so it can never resolve a moved tag.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SANDBOX_BROKER_TOKEN` | — | Bearer token. At least 32 characters. |
| `SANDBOX_BROKER_TOKEN_FILE` | — | Read the token from a file instead. |
| `SANDBOX_BROKER_GENERATE_TOKEN` | `false` | Create the token file on first start (0600, atomic). Only honoured together with `..._TOKEN_FILE`. |
| `SANDBOX_BROKER_PORT` | `8080` | Listen port. Never publish it to the host. |
| `SANDBOX_BROKER_NAMESPACE` | `default` | Ownership namespace. The broker only ever touches resources carrying its own namespace label. |
| `SANDBOX_BROKER_SANDBOX_IMAGE` | `sandbox-broker/sandbox:dev` | Pin to a digest in production. |
| `SANDBOX_BROKER_FIREWALL_IMAGE` | `sandbox-broker/firewall:dev` | Pin to a digest in production. |
| `SANDBOX_BROKER_EGRESS_NETWORK` | `sandbox-broker-egress` | Broker-owned bridge for `unrestricted` sandboxes. Must not be your app/database network. |
| `SANDBOX_BROKER_BLOCKED_CIDRS` | — | Extra destinations sandboxes must not reach. |
| `SANDBOX_BROKER_QUOTA_MODE` | `watchdog` | `watchdog` or `hard`. See [workspace-quota.md](workspace-quota.md). |
| `SANDBOX_BROKER_HOST_RESERVE_MIB` | `2048` | Host headroom to keep free. |
| `SANDBOX_BROKER_MAX_EXEC_TIMEOUT_MS` | `1800000` | Server-side ceiling on any command. |
| `SANDBOX_BROKER_DEFAULT_EXEC_TIMEOUT_MS` | `300000` | Applied when a caller omits a timeout. |
| `SANDBOX_BROKER_MAX_UPLOAD_BYTES` | `268435456` | Ceiling on a single file upload. |
| `SANDBOX_BROKER_VOLUME_DRIVER` / `..._VOLUME_OPTS` | `local` / — | Workspace volume driver. Relevant only for `hard` quota mode. |
| `SANDBOX_BROKER_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |

The token is never logged, never returned by any endpoint, and is excluded from
the config object's own serialization.

## The token

Two workable patterns:

1. **Supply it.** Generate `openssl rand -base64 32` once and put it in both the
   broker's and the application's environment. Simple and explicit.
2. **Let the broker generate it.** Set `SANDBOX_BROKER_TOKEN_FILE` to a path on
   a shared volume and `SANDBOX_BROKER_GENERATE_TOKEN=true`. The broker writes
   32 random bytes atomically with mode 0600 on first start and reuses the file
   afterwards. Mount that volume read-only into the application.

Pattern 2 removes a manual secret but makes application start depend on the
broker having initialized the volume. If that ordering is not reliable in your
orchestrator, use pattern 1.

## Docker socket access

The broker runs as UID 10101 and needs group access to the socket:

```yaml
group_add:
  - "${DOCKER_GID}"   # getent group docker | cut -d: -f3
volumes:
  - /var/run/docker.sock:/var/run/docker.sock
```

Do not run the broker as root just to reach the socket.

## Host address detection

For `unrestricted` sandboxes the broker briefly runs the firewall helper in the
**host** network namespace to enumerate the host's IPv4 addresses, so it can
block them — including a public address, which RFC1918 filtering cannot cover.
This is a trusted, fixed script that exits in milliseconds.

If your platform forbids `network_mode: host`, that probe fails and readiness
reports `egress-policy` as not ok. In that case list the host's addresses
explicitly in `SANDBOX_BROKER_BLOCKED_CIDRS`.

## Compose

See [`compose.example.yaml`](../compose.example.yaml) at the repository root for
a complete, commented example.

## Operational notes

- **Restarting the broker is safe.** State is rebuilt from Docker labels. Any
  sandbox found running is restarted first, because a command may still be
  executing in it and its network policy cannot be trusted.
- **Stopping a sandbox destroys its network namespace.** The broker re-applies
  and re-verifies the policy on every start, and refuses `exec` until it has.
- **Workspaces are named volumes.** They survive stop/start and container
  recreation, and are deleted only by `DELETE /v1/sandboxes/{id}`.
- **After a host firewall or interface change**, restart the broker so it
  re-probes host addresses; the block list is cached for the process lifetime.
