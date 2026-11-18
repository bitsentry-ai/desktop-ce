#!/usr/bin/env bash
# Refuses ad-hoc or non-Developer-ID signatures, checks the DMG and ZIP, and writes SHA256SUMS.
# Runs from apps/desktop. Env: NIGHTLY_VERSION.
set -euo pipefail
app_path="release/build/mac-arm64/BitSentry-Desktop.app"
dmg="release/build/bitsentry-desktop-ce-${NIGHTLY_VERSION}-macos-aarch64.dmg"
zip="release/build/bitsentry-desktop-ce-${NIGHTLY_VERSION}-macos-aarch64.zip"
bash scripts/verify-macos-artifact.sh "${app_path}"
codesign_output="$(codesign -dv --verbose=4 "${app_path}" 2>&1 || true)"
team_id="$(printf '%s\n' "${codesign_output}" | sed -n 's/^TeamIdentifier=//p' | head -n 1)"
authority="$(printf '%s\n' "${codesign_output}" | sed -n 's/^Authority=//p' | head -n 1)"
case "${team_id}" in
  ""|"not set"|"-")
    echo "Refusing to publish an ad-hoc or unsigned nightly; expected a Developer ID team identity." >&2
    printf '%s\n' "${codesign_output}" >&2
    exit 1
    ;;
esac
case "${authority}" in
  "Developer ID Application:"*) ;;
  *)
    echo "Refusing to publish a non-Developer-ID macOS artifact." >&2
    printf '%s\n' "${codesign_output}" >&2
    exit 1
    ;;
esac
test -f "${dmg}"
test -f "${zip}"
test -f "${dmg}.blockmap"
test -f "${zip}.blockmap"
hdiutil verify "${dmg}"
unzip -t "${zip}" >/dev/null
shasum -a 256 \
  "${dmg}" \
  "${zip}" \
  "${dmg}.blockmap" \
  "${zip}.blockmap" \
  > release/build/SHA256SUMS
