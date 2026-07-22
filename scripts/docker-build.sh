#!/usr/bin/env bash
# Builds the images the broker needs at runtime.
#
# Tags are intentionally local-only here; the release workflow is what pushes
# immutable tags/digests to GHCR.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tag="${SANDBOX_BROKER_IMAGE_TAG:-dev}"

echo "==> building sandbox-broker/sandbox:${tag}"
docker build -t "sandbox-broker/sandbox:${tag}" "${repo_root}/images/sandbox"

echo "==> building sandbox-broker/firewall:${tag}"
docker build -t "sandbox-broker/firewall:${tag}" "${repo_root}/images/firewall"

echo "==> building sandbox-broker/server:${tag}"
docker build -t "sandbox-broker/server:${tag}" -f "${repo_root}/images/server/Dockerfile" "${repo_root}"

echo "==> done"
docker image inspect \
  "sandbox-broker/sandbox:${tag}" \
  "sandbox-broker/firewall:${tag}" \
  "sandbox-broker/server:${tag}" \
  --format '{{.RepoTags}} {{.Id}}'
