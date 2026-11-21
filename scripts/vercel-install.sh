#!/usr/bin/env bash
set -euo pipefail

# Vercel build image ships Bun 1.3.x which cannot parse Bun 1.4 lockfileVersion 2.
BUN_VERSION="1.4.4"
SHA256_X64="bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c"
SHA256_ARM64="baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e"
BUN_INSTALL="${HOME}/.bun"
BUN_BIN="${BUN_INSTALL}/bin/bun"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "scripts/vercel-install.sh supports Linux Vercel build containers only" >&2
  exit 1
fi

ARCH="$(uname -m)"
if [[ "${ARCH}" == "x86_64" || "${ARCH}" == "amd64" ]]; then
  ASSET="bun-linux-x64"
  EXPECTED_SHA="${SHA256_X64}"
elif [[ "${ARCH}" == "aarch64" || "${ARCH}" == "arm64" ]]; then
  ASSET="bun-linux-aarch64"
  EXPECTED_SHA="${SHA256_ARM64}"
else
  echo "Unsupported architecture: ${ARCH}" >&2
  exit 1
fi

if [[ ! -x "${BUN_BIN}" ]] || [[ "$("${BUN_BIN}" --version 2>/dev/null || true)" != "${BUN_VERSION}" ]]; then
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "${TMP_DIR}"' EXIT
  ARCHIVE="${TMP_DIR}/${ASSET}.zip"
  curl -fsSL --connect-timeout 15 --max-time 120 --retry 3 --retry-delay 2 --retry-all-errors "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${ASSET}.zip" -o "${ARCHIVE}"
  printf '%s  %s\n' "${EXPECTED_SHA}" "${ARCHIVE}" | sha256sum -c -
  unzip -q "${ARCHIVE}" -d "${TMP_DIR}"
  mkdir -p "${BUN_INSTALL}/bin"
  install -m 0755 "${TMP_DIR}/${ASSET}/bun" "${BUN_BIN}"
fi

export PATH="${BUN_INSTALL}/bin:${PATH}"
test "$("${BUN_BIN}" --version)" = "${BUN_VERSION}"
"${BUN_BIN}" install --frozen-lockfile
