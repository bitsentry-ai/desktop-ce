#!/usr/bin/env bash
# Verifies the macOS updater manifest, then uploads the versioned artifacts and the feed manifest to R2.
# Preview builds publish the raw manifest next to the artifacts; other channels publish the channel feed.
# Usage: upload-ce-macos-artifacts.sh <arch> <artifact_arch> <release_version>
# Env: BITSENTRY_RELEASE_CHANNEL, ARTIFACT_PREFIX, ARTIFACT_VERSION_SEGMENT, plus the R2_* upload settings.
set -e
arch="$1"
artifact_arch="$2"
release_version="$3"

manifest="apps/desktop/release/build/latest-mac.yml"
if [ "${BITSENTRY_RELEASE_CHANNEL}" != "preview" ]; then
  manifest="apps/desktop/release/build/channel-feed/latest-mac.yml"
fi
args=(--manifest "${manifest}" --artifact-root apps/desktop/release/build --required-artifact-prefix bitsentry-desktop-ce-)
if [ "${BITSENTRY_RELEASE_CHANNEL}" != "preview" ]; then args+=(--required-path-prefix "${ARTIFACT_VERSION_SEGMENT}"); fi
node apps/desktop/scripts/dist/verify-update-manifest.js "${args[@]}"
node apps/desktop/scripts/dist/upload-r2-artifacts.js \
  --root apps/desktop/release/build \
  --prefix "${ARTIFACT_PREFIX}/macos/${arch}/${ARTIFACT_VERSION_SEGMENT}" \
  --include "bitsentry-desktop-ce-${release_version}-macos-${artifact_arch}.dmg" \
  --include "bitsentry-desktop-ce-${release_version}-macos-${artifact_arch}.zip" \
  --include "bitsentry-desktop-ce-${release_version}-macos-${artifact_arch}.dmg.blockmap" \
  --include "bitsentry-desktop-ce-${release_version}-macos-${artifact_arch}.zip.blockmap" \
  --if-no-files-found error
if [ "${BITSENTRY_RELEASE_CHANNEL}" != "preview" ]; then
  node apps/desktop/scripts/dist/upload-r2-artifacts.js --root apps/desktop/release/build/channel-feed --prefix "${ARTIFACT_PREFIX}/macos/${arch}" --include latest-mac.yml --if-no-files-found error
else
  node apps/desktop/scripts/dist/upload-r2-artifacts.js --root apps/desktop/release/build --prefix "${ARTIFACT_PREFIX}/macos/${arch}/${ARTIFACT_VERSION_SEGMENT}" --include latest-mac.yml --if-no-files-found error
fi
