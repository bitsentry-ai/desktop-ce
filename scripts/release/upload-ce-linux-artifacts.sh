#!/usr/bin/env bash
# Verifies the Linux updater manifest, uploads the AppImage, then uploads the feed manifest.
# Preview builds keep the manifest beside the versioned artifacts.
# Usage: upload-ce-linux-artifacts.sh <arch> <artifact_arch> <update_manifest> <release_version>
# Env: BITSENTRY_RELEASE_CHANNEL, ARTIFACT_PREFIX, ARTIFACT_VERSION_SEGMENT, plus the R2_* upload settings.
set -e
arch="$1"
artifact_arch="$2"
update_manifest="$3"
release_version="$4"

manifest="apps/desktop/release/build/${update_manifest}"
object_prefix="${ARTIFACT_PREFIX}/linux/${arch}/${ARTIFACT_VERSION_SEGMENT}"
if [ "${BITSENTRY_RELEASE_CHANNEL}" != "preview" ]; then manifest="apps/desktop/release/build/channel-feed/${update_manifest}"; fi
args=(--manifest "${manifest}" --artifact-root apps/desktop/release/build --required-artifact-prefix bitsentry-desktop-ce-)
if [ "${BITSENTRY_RELEASE_CHANNEL}" != "preview" ]; then args+=(--required-path-prefix "${ARTIFACT_VERSION_SEGMENT}"); fi
node apps/desktop/scripts/dist/verify-update-manifest.js "${args[@]}"
node apps/desktop/scripts/dist/upload-r2-artifacts.js --root apps/desktop/release/build --prefix "${object_prefix}" --include "bitsentry-desktop-ce-${release_version}-linux-${artifact_arch}.AppImage" --if-no-files-found error
if [ "${BITSENTRY_RELEASE_CHANNEL}" != "preview" ]; then
  node apps/desktop/scripts/dist/upload-r2-artifacts.js --root apps/desktop/release/build/channel-feed --prefix "${ARTIFACT_PREFIX}/linux/${arch}" --include "${update_manifest}" --if-no-files-found error
else
  node apps/desktop/scripts/dist/upload-r2-artifacts.js --root apps/desktop/release/build --prefix "${object_prefix}" --include "${update_manifest}" --if-no-files-found error
fi
