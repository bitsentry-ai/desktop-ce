#!/usr/bin/env bash
# Verifies the Windows updater manifest, uploads the installer and blockmap, checks the uploaded objects,
# then uploads the feed manifest. Preview builds keep the manifest beside the versioned artifacts.
# Usage: upload-ce-windows-artifacts.sh <release_version>
# Env: BITSENTRY_RELEASE_CHANNEL, ARTIFACT_PREFIX, ARTIFACT_VERSION_SEGMENT, plus the R2_* upload settings.
set -eo pipefail
release_version="$1"

manifest="apps/desktop/release/build/latest.yml"
object_prefix="${ARTIFACT_PREFIX}/windows/x64/${ARTIFACT_VERSION_SEGMENT}"
if [ "${BITSENTRY_RELEASE_CHANNEL}" != "preview" ]; then manifest="apps/desktop/release/build/channel-feed/latest.yml"; fi
verify_object_prefix="${object_prefix}"
args=(--manifest "${manifest}" --artifact-root apps/desktop/release/build --required-artifact-prefix bitsentry-desktop-ce-)
if [ "${BITSENTRY_RELEASE_CHANNEL}" != "preview" ]; then
  args+=(--required-path-prefix "${ARTIFACT_VERSION_SEGMENT}")
  verify_object_prefix="${ARTIFACT_PREFIX}/windows/x64"
fi
node apps/desktop/scripts/dist/verify-update-manifest.js "${args[@]}"
node apps/desktop/scripts/dist/upload-r2-artifacts.js --root apps/desktop/release/build --prefix "${object_prefix}" \
  --include "bitsentry-desktop-ce-${release_version}-windows-x86_64.exe" \
  --include "bitsentry-desktop-ce-${release_version}-windows-x86_64.exe.blockmap" \
  --if-no-files-found error
node apps/desktop/scripts/dist/verify-r2-artifacts.js --manifest "${manifest}" --object-prefix "${verify_object_prefix}" \
  --exe "apps/desktop/release/build/bitsentry-desktop-ce-${release_version}-windows-x86_64.exe" \
  --blockmap "apps/desktop/release/build/bitsentry-desktop-ce-${release_version}-windows-x86_64.exe.blockmap"
if [ "${BITSENTRY_RELEASE_CHANNEL}" != "preview" ]; then
  node apps/desktop/scripts/dist/upload-r2-artifacts.js --root apps/desktop/release/build/channel-feed --prefix "${ARTIFACT_PREFIX}/windows/x64" --include latest.yml --if-no-files-found error
else
  node apps/desktop/scripts/dist/upload-r2-artifacts.js --root apps/desktop/release/build --prefix "${object_prefix}" --include latest.yml --if-no-files-found error
fi
