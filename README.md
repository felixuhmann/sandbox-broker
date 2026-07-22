# sandbox-broker

Hardened single-tenant Docker sandbox broker for AI agents.

`sandbox-broker` is a small authenticated HTTP service that creates and drives
locked-down Docker containers for running untrusted, agent-generated code. It
exists so that an application (for example [Open Agents]) can get a sandbox with
a filesystem, a shell, and controlled network access **without** ever touching
the Docker socket itself, and without any per-sandbox daemon, agent, or
published host port.

Inspired by the `docker exec` command channel used by Eve and Mastra.

> **Status:** v0.1.0 — single-tenant only. Sandboxes share the host kernel via
> `runc`. Read [SECURITY.md](SECURITY.md) before deploying.

## What it does

- **Fixed-shape containers only.** The API takes an owner reference, a network
  mode, and resource limits. It never accepts an image, bind mount, capability,
  device, user, or privileged flag.
- **Two network modes.**
  - `deny-all` — Docker `NetworkMode: none`; no network path at all.
  - `unrestricted` — public IPv4 egress, while loopback, RFC1918, CGNAT,
    link-local, `169.254.169.254`, Docker bridge ranges, every detected host
    address, and the broker's own control endpoints stay blocked. IPv6 is
    disabled inside the namespace.
- **Streaming exec** over NDJSON with a mandatory server-side timeout and
  client-disconnect cancellation. Recovery restarts the sandbox and re-applies
  the network policy so no orphaned process survives.
- **Binary-safe workspace files** under `/workspace`, on a named Docker volume
  that survives stop/start and container recreation.
- **Reconstructible state.** Broker state lives in Docker labels; a restarted
  broker rebuilds its view from Docker and never touches resources it does not
  own.

## Layout

| Path | Contents |
|---|---|
| `apps/server` | The Hono service (`@sandbox-broker/server`) |
| `packages/contracts` | Zod schemas + OpenAPI route metadata (`@sandbox-broker/contracts`) |
| `packages/client` | Typed HTTP/NDJSON client (`@sandbox-broker/client`) |
| `images/sandbox` | Hardened sandbox image |
| `images/firewall` | Short-lived nftables policy helper |
| `images/server` | Broker service image |
| `openapi/openapi.json` | Generated, committed API contract |

## Requirements

- Docker Engine with nftables available in the kernel (any modern Linux host).
- Node.js 24 for the published images and CI. Node 22.11+ works for local
  development.
- pnpm 11.

## Quick start (development)

```bash
pnpm install
pnpm check                 # build + typecheck + lint + unit tests + OpenAPI drift
bash scripts/docker-build.sh
pnpm test:integration      # real Docker; creates and destroys containers
```

Deployment, configuration and the Compose topology are documented in
[`docs/deployment.md`](docs/deployment.md). The workspace quota enforcement
contract — including what is *not* portably enforceable — is in
[`docs/workspace-quota.md`](docs/workspace-quota.md).

## License

Apache-2.0. See [LICENSE](LICENSE).

[Open Agents]: https://github.com/felixuhmann/open-agents
