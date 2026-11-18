#!/usr/bin/env bash
# Packages the CE macOS app from apps/desktop. Notarization runs only when SKIP_NOTARIZE_INPUT is not "true":
# skipping removes the Apple credentials and disables the afterSign hook.
# Usage: package-ce-macos.sh <arch> <artifact_arch> <electron_arch>
# Env: ARTIFACT_BASE_URL, SKIP_NOTARIZE_INPUT, plus the CSC_* and APPLE_* signing secrets.
set -e
arch="$1"
artifact_arch="$2"
electron_arch="$3"

export DESKTOP_UPDATE_BASE_URL="${ARTIFACT_BASE_URL}/macos/${arch}"
export DESKTOP_ARTIFACT_NAME="bitsentry-desktop-ce-\${version}-macos-${artifact_arch}.\${ext}"
if [ "${SKIP_NOTARIZE_INPUT}" = "true" ]; then
  unset APPLE_ID APPLE_APP_PASSWORD APPLE_TEAM_ID
  export DESKTOP_ENABLE_AFTER_SIGN=false
else
  export DESKTOP_ENABLE_AFTER_SIGN=true
fi
bash scripts/create-ci-builder-config.sh electron-builder.ci.yml
bash scripts/normalize-ce-builder-config.sh electron-builder.ci.yml "$DESKTOP_ARTIFACT_NAME"
npx electron-builder build --config electron-builder.ci.yml --mac --${electron_arch} --publish never
