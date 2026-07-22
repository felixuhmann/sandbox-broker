# Releasing sandbox-broker

A release publishes four artifacts from one commit:

| Artifact | Where |
|---|---|
| `sandbox-broker-server` image | GHCR, tagged by version + digest |
| `sandbox-broker-sandbox` image | GHCR, tagged by version + digest |
| `sandbox-broker-firewall` image | GHCR, tagged by version + digest |
| `@sandbox-broker/client` + `@sandbox-broker/contracts` tarballs | GitHub Release assets |

Everything is driven by [`.github/workflows/release.yml`](../.github/workflows/release.yml).
Actions are pinned by commit SHA.

## Versioning

The root `package.json` version is the single source of truth. The workflow
refuses to run when a pushed tag does not equal `v<version>`, because the packed
client embeds the release asset URL for that exact tag.

A version containing a hyphen (`0.1.0-rc.1`) is treated as a prerelease: the
GitHub Release is marked as such and no image is tagged `latest`.

## Release-candidate rehearsal (no tag, no push)

Nothing below writes to GHCR, creates a tag, or creates a release.

```bash
pnpm install --frozen-lockfile
pnpm check                        # build, typecheck, lint, unit tests, OpenAPI drift
bash scripts/docker-build.sh      # all three images, local tags only
pnpm test:integration             # real Docker security suite
pnpm release:pack:verify          # tarballs, packed twice and compared
```

Then run the **Release** workflow with `workflow_dispatch` and `dry_run` left at
its default. It builds all three images without pushing, packs the tarballs,
verifies they are reproducible, and attaches them to the workflow run so they
can be downloaded and installed before any tag exists.

To install a dry-run tarball, point the client at the local contracts tarball —
otherwise its manifest refers to a release asset that does not exist yet:

```bash
SANDBOX_BROKER_CONTRACTS_SPEC="file:$PWD/dist/release/sandbox-broker-contracts-0.1.0.tgz" \
  pnpm release:pack
```

## Cutting the release

```bash
git tag v0.1.0            # or v0.1.0-rc.1
git push origin v0.1.0
```

The workflow then builds and pushes the three images, packs the tarballs, and
creates (or updates) the GitHub Release with the image digests and the artifact
checksums in the notes.

Afterwards, read the result back rather than trusting the push:

```bash
gh release view v0.1.0
docker buildx imagetools inspect ghcr.io/felixuhmann/sandbox-broker-server:0.1.0
```

The first release of a package under a new GHCR namespace is private by
default. Make each of the three packages public in the repository's package
settings, or deployments will need a pull secret.

## Deterministic tarballs

`scripts/pack-release.sh` writes to `dist/release/`:

```text
dist/release/sandbox-broker-contracts-<version>.tgz
dist/release/sandbox-broker-client-<version>.tgz
dist/release/SHA256SUMS
```

It rebuilds both packages from scratch first, so the tarballs are a function of
the sources only; `--verify` packs a second time into a temporary directory and
fails if any checksum differs. CI runs `--verify` on every push, so a packaging
regression surfaces long before a tag.

The packed client manifest differs from the workspace manifest in two ways, both
applied by the script and reverted afterwards:

- `@sandbox-broker/contracts` becomes the release asset URL for this version
  instead of `workspace:*`. pnpm `overrides` do **not** reach the dependencies of
  a tarball dependency, so a consumer would otherwise have to resolve an
  unpublished package from the registry.
- `devDependencies` (which reference the private server package) are dropped.

## npm publishing

Off by default and not required by any consumer. The `npm` job runs only when
the repository variable `PUBLISH_NPM` is `true` **and** the `NPM_TOKEN` secret
exists; it fails loudly rather than silently skipping if the variable is set
without the secret. Turning it on requires first securing the public
`@sandbox-broker` npm scope.
