#!/usr/bin/env bash
# Fails before any macOS runner starts when R2 or signing secrets are missing, or when Apple
# notarization secrets are only partly configured. Prints secret names only, never values.
set -euo pipefail

for name in R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET; do
  if [ -z "${!name:-}" ]; then
    echo "Missing required R2 secret: ${name}" >&2
    exit 1
  fi
done

if [ -z "${MAC_CSC_LINK:-}" ] || \
  { [ -z "${MAC_CSC_KEY_PASSWORD:-}" ] && [ -z "${MAC_CSC_PASSWORD:-}" ]; }; then
  echo "Missing macOS signing secrets; refusing to create an unsigned nightly." >&2
  echo "Configure MAC_CSC_LINK and MAC_CSC_KEY_PASSWORD (or MAC_CSC_PASSWORD)." >&2
  exit 1
fi

apple_secret_count=0
for name in APPLE_ID APPLE_APP_PASSWORD APPLE_TEAM_ID; do
  if [ -n "${!name:-}" ]; then
    apple_secret_count=$((apple_secret_count + 1))
  fi
done

if [ "${apple_secret_count}" -ne 0 ] && [ "${apple_secret_count}" -ne 3 ]; then
  echo "Apple notarization configuration is partial; provide APPLE_ID, APPLE_APP_PASSWORD, and APPLE_TEAM_ID together or omit all three." >&2
  exit 1
fi

if [ "${apple_secret_count}" -eq 3 ]; then
  echo "Apple notarization is enabled."
else
  echo "Apple notarization is disabled explicitly; the signed artifact will still be verified before publishing."
fi
