#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

SOURCE_APP="${1:-${APP_ROOT}/release/build/mac-arm64/BitSentry-Desktop.app}"
DEST_APP="${2:-/Applications/BitSentry-Desktop.app}"

if [ ! -d "${SOURCE_APP}" ]; then
  echo "Source app bundle not found: ${SOURCE_APP}"
  exit 1
fi

echo "Verifying source app bundle..."
bash "${SCRIPT_DIR}/verify-macos-artifact.sh" "${SOURCE_APP}"

INSTALL_PARENT="$(dirname "${DEST_APP}")"
if [ -w "${INSTALL_PARENT}" ]; then
  rm -rf "${DEST_APP}"
  ditto "${SOURCE_APP}" "${DEST_APP}"
  xattr -dr com.apple.quarantine "${DEST_APP}" 2>/dev/null || true
else
  echo "Installing to ${DEST_APP} requires admin privileges."
  sudo rm -rf "${DEST_APP}"
  sudo ditto "${SOURCE_APP}" "${DEST_APP}"
  sudo xattr -dr com.apple.quarantine "${DEST_APP}" 2>/dev/null || true
fi

echo "Verifying installed app bundle..."
bash "${SCRIPT_DIR}/verify-macos-artifact.sh" "${DEST_APP}"

echo "Installed successfully: ${DEST_APP}"
