# Workspace quota: what is and is not enforced

`limits.workspaceMiB` is part of the create request, so it is fair to ask what
the broker actually guarantees. The honest answer depends on the host.

## The problem

Docker's `local` volume driver has **no portable per-volume byte quota**.
Enforcing one requires host-specific setup that the broker cannot assume:

- XFS project quotas (`pquota` mount option) on the volume filesystem, or
- a dedicated loopback/LVM device per volume, or
- a third-party volume plugin that implements size limits.

A `tmpfs` volume *can* be size-limited, but it is RAM-backed and does not
survive a reboot, which disqualifies it for a persistent workspace.

The broker therefore refuses to claim a hard quota it cannot deliver.

## The two modes

Set with `SANDBOX_BROKER_QUOTA_MODE`.

### `watchdog` (default)

Best-effort enforcement, honestly labelled:

- **Before every write**, the broker measures `du -sb /workspace` and rejects
  the upload with `409` if the write would cross `workspaceMiB`.
- **During a command**, a watchdog samples usage every two seconds and stops the
  execution when the limit is breached.
- **A measurement failure counts as a breach.** If usage cannot be read, the
  write is refused rather than allowed through.

What this does *not* give you: usage can briefly exceed the limit between
samples — a single `dd` can write past the ceiling before the next sample
lands. Combine it with `SANDBOX_BROKER_HOST_RESERVE_MIB` and a dedicated
filesystem for Docker volumes if the host must be protected from a determined
filler.

`GET /v1/capabilities` reports this mode as `{"mode":"watchdog","enforced":false}`.
That `false` is deliberate and accurate.

### `hard`

Promises a real byte ceiling, and **verifies it at startup**:

1. The broker creates a probe volume with `SANDBOX_BROKER_VOLUME_DRIVER` and
   `SANDBOX_BROKER_VOLUME_OPTS`.
2. It writes 8 MiB into it from a throwaway container.
3. If that write **succeeds**, the driver is not enforcing a size, so
   `GET /v1/ready` returns `503` with an actionable message and the broker
   refuses to serve. It does not silently downgrade to `watchdog`.

On a stock Docker installation with the `local` driver, `hard` mode will fail
readiness. That is the intended behaviour: choose `watchdog` and understand its
limits, or configure a driver that genuinely enforces size.

## Related controls that *are* hard

These are cgroup-enforced by the kernel and are exercised by the integration
suite, not merely configured:

| Limit | Mechanism | Verified by |
|---|---|---|
| `memoryMiB` | cgroup `memory.max`, swap disabled (`MemorySwap == Memory`) | `docker inspect` |
| `cpuCores` | cgroup `cpu.max` via `NanoCpus` | `docker inspect` |
| `pids` | cgroup `pids.max` | fork saturation + reading `pids.max` inside the container |
| root filesystem | `ReadonlyRootfs` | write attempt returns `Read-only file system` |
| `/tmp` size | tmpfs `size=128m`, `noexec` | execution attempt is denied |
