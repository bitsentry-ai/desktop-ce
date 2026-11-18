#!/usr/bin/env bash
# Publishes the nightly as a GitHub prerelease that is never marked latest. Runs from apps/desktop.
# Env: GH_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA, NIGHTLY_TAG, NIGHTLY_VERSION, R2_PUBLIC_BASE_URL, R2_PREFIX.
set -e
gh release create "${NIGHTLY_TAG}" \
  "release/build/bitsentry-desktop-ce-${NIGHTLY_VERSION}-macos-aarch64.dmg" \
  "release/build/bitsentry-desktop-ce-${NIGHTLY_VERSION}-macos-aarch64.zip" \
  release/build/SHA256SUMS \
  --repo "${GITHUB_REPOSITORY}" \
  --target "${GITHUB_SHA}" \
  --title "BitSentry Desktop CE nightly ${NIGHTLY_VERSION}" \
  --notes "BitSentry Desktop CE nightly from ${GITHUB_SHA}. R2 prefix: ${R2_PUBLIC_BASE_URL}/${R2_PREFIX}. Stable and beta feeds are unchanged. Notarization is enabled only when all Apple credentials are configured." \
  --prerelease \
  --latest=false
