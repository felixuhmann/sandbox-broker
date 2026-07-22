# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub Security
Advisories on `felixuhmann/sandbox-broker` ("Report a vulnerability"). Do not
open a public issue for an unfixed vulnerability.

Include a description, affected version/commit, reproduction steps, and impact.
We aim to acknowledge reports within seven days.

## Threat model

`sandbox-broker` runs untrusted agent-generated code in Docker containers on a
**single-tenant** host. It is designed for the case where one operator runs one
Open Agents deployment and wants agent code isolated from the host, the
operator's private network, and the operator's other services.

### What the broker defends against

- Reading or writing host files: sandbox containers get a read-only root
  filesystem, no host bind mounts, and a broker-created workspace volume only.
- Privilege escalation inside the container: `CapDrop: ALL`,
  `no-new-privileges`, non-root UID/GID, default seccomp and AppArmor profiles.
- Reaching the Docker daemon: only the broker receives `/var/run/docker.sock`.
  Sandboxes never do.
- Reaching the operator's private network, the host itself, or cloud metadata
  (`169.254.169.254`): enforced with nftables rules installed into the sandbox
  network namespace before any untrusted code may run.
- Inbound access: sandboxes publish no ports.
- Resource exhaustion: CPU, memory, PID and workspace limits.
- Orphaned processes after timeout, cancellation, or broker crash: the affected
  sandbox is restarted and its network policy re-applied before further work.

### What the broker does NOT defend against

- **Kernel or container-runtime escapes.** Sandboxes share the host kernel via
  `runc`. An unknown kernel or runtime vulnerability defeats this design. There
  is no VM boundary. Do not treat the broker as a multi-tenant security
  boundary.
- **Side channels** between containers (CPU, cache, timing).
- **Anything reachable on the public internet** in `unrestricted` mode. That
  mode intentionally allows public IPv4 egress.
- **Hard workspace byte quotas on every storage driver.** See
  [`docs/workspace-quota.md`](docs/workspace-quota.md) for the exact enforcement
  contract; the broker refuses to start in `hard` quota mode when the host
  cannot enforce it.

## Trust boundaries

| Component | Trust |
|---|---|
| Broker control API | Trusted. Authenticated with a bearer token, never publicly routed. |
| Docker socket | Trusted. Mounted only into the broker. Equivalent to host root. |
| Sandbox container | Untrusted. Runs agent-generated code. |
| Firewall helper container | Trusted, short-lived, `NET_ADMIN`/`NET_RAW` in the sandbox netns only. |

Anyone able to call the broker API with a valid token can run code on the host
inside a sandbox. Protect the token like a host credential.
