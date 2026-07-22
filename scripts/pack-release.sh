#!/usr/bin/env bash
# Builds the release artifacts for the TypeScript packages.
#
#   scripts/pack-release.sh [--verify]
#
# Output (deterministic: identical inputs produce byte-identical tarballs):
#
#   dist/release/sandbox-broker-contracts-<version>.tgz
#   dist/release/sandbox-broker-client-<version>.tgz
#   dist/release/SHA256SUMS
#
# The client depends on the contracts package, which is deliberately not
# published to any registry. pnpm's `overrides` do not reach the dependencies of
# a tarball dependency, so the packed client manifest points straight at the
# sibling contracts tarball instead. By default that is the GitHub Release asset
# URL for this version, which makes `pnpm add <client-url>` resolve with no
# registry auth and no override in the consumer. Override the spec for local
# testing:
#
#   SANDBOX_BROKER_CONTRACTS_SPEC=file:/abs/path/contracts.tgz scripts/pack-release.sh
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${repo_root}"

version="$(node -p "require('./package.json').version")"
repo="${GITHUB_REPOSITORY:-felixuhmann/sandbox-broker}"
tag="${RELEASE_TAG:-v${version}}"
out_dir="${RELEASE_OUT_DIR:-${repo_root}/dist/release}"
contracts_tarball="sandbox-broker-contracts-${version}.tgz"
contracts_spec="${SANDBOX_BROKER_CONTRACTS_SPEC:-https://github.com/${repo}/releases/download/${tag}/${contracts_tarball}}"

client_manifest="${repo_root}/packages/client/package.json"
backup="$(mktemp)"

restore_manifest() {
  if [[ -s "${backup}" ]]; then
    cp "${backup}" "${client_manifest}"
    rm -f "${backup}"
  fi
}
trap restore_manifest EXIT

pack() {
  local target_dir="$1"
  rm -rf "${target_dir}"
  mkdir -p "${target_dir}"

  # A clean rebuild is what makes the tarball a function of the sources only.
  rm -rf "${repo_root}/packages/contracts/dist" "${repo_root}/packages/client/dist"
  pnpm --filter @sandbox-broker/contracts build >/dev/null
  pnpm --filter @sandbox-broker/client build >/dev/null

  pnpm --filter @sandbox-broker/contracts pack --out "${target_dir}/%s-%v.tgz" >/dev/null

  cp "${client_manifest}" "${backup}"
  # Rewrite the workspace dependency to a spec a consumer can actually resolve,
  # and drop devDependencies (which reference the private server package).
  # shellcheck disable=SC2016  # the single quotes delimit JavaScript, not shell
  CONTRACTS_SPEC="${contracts_spec}" node -e '
    const fs = require("node:fs");
    const path = process.argv[1];
    const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
    manifest.dependencies["@sandbox-broker/contracts"] = process.env.CONTRACTS_SPEC;
    delete manifest.devDependencies;
    fs.writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  ' "${client_manifest}"

  pnpm --filter @sandbox-broker/client pack --out "${target_dir}/%s-%v.tgz" >/dev/null
  restore_manifest

  (cd "${target_dir}" && sha256sum ./*.tgz | sed 's#\./##' > SHA256SUMS)
}

pack "${out_dir}"

if [[ "${1:-}" == "--verify" ]]; then
  echo "==> verifying tarballs are reproducible"
  verify_dir="$(mktemp -d)"
  pack "${verify_dir}"
  if ! diff -u "${out_dir}/SHA256SUMS" "${verify_dir}/SHA256SUMS"; then
    echo "pack-release: tarballs are not reproducible" >&2
    rm -rf "${verify_dir}"
    exit 1
  fi
  rm -rf "${verify_dir}"
  echo "==> reproducible"
fi

echo "==> release artifacts in ${out_dir}"
cat "${out_dir}/SHA256SUMS"
echo "==> contracts dependency spec: ${contracts_spec}"
