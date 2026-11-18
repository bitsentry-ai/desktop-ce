#!/usr/bin/env bash
# Verifies the nightly updater manifest, then uploads the versioned artifacts and the feed manifest
# under the isolated nightly R2 prefix. Runs from apps/desktop.
# Env: NIGHTLY_VERSION, R2_PREFIX, ARTIFACT_VERSION_SEGMENT, plus the R2_* upload settings.
set -euo pipefail
node scripts/dist/verify-update-manifest.js \
  --manifest release/build/channel-feed/latest-mac.yml \
  --artifact-root release/build \
  --required-path-prefix "${ARTIFACT_VERSION_SEGMENT}" \
  --required-artifact-prefix bitsentry-desktop-ce-
node scripts/dist/upload-r2-artifacts.js \
  --root release/build \
  --prefix "${R2_PREFIX}/macos/arm64/${ARTIFACT_VERSION_SEGMENT}" \
  --include "bitsentry-desktop-ce-${NIGHTLY_VERSION}-macos-aarch64.dmg" \
  --include "bitsentry-desktop-ce-${NIGHTLY_VERSION}-macos-aarch64.zip" \
  --include "bitsentry-desktop-ce-${NIGHTLY_VERSION}-macos-aarch64.dmg.blockmap" \
  --include "bitsentry-desktop-ce-${NIGHTLY_VERSION}-macos-aarch64.zip.blockmap" \
  --include "SHA256SUMS" \
  --if-no-files-found error
node scripts/dist/upload-r2-artifacts.js \
  --root release/build/channel-feed \
  --prefix "${R2_PREFIX}/macos/arm64" \
  --include latest-mac.yml \
  --if-no-files-found error
