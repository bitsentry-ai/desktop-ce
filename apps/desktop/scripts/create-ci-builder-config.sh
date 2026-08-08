#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${DESKTOP_UPDATE_BASE_URL:-}" ]]; then
  echo "DESKTOP_UPDATE_BASE_URL is required" >&2
  exit 1
fi

output_file="${1:-electron-builder.ci.yml}"
enable_after_sign="${DESKTOP_ENABLE_AFTER_SIGN:-false}"

awk -v url="$DESKTOP_UPDATE_BASE_URL" -v enable_after_sign="$enable_after_sign" '
BEGIN {
  skipping_publish = 0
  replaced_publish = 0
}
{
  line = $0
  sub(/\r$/, "", line)
}
line == "publish:" {
  skipping_publish = 1
  replaced_publish = 1
  print "publish:"
  print "  provider: generic"
  print "  url: " url
  print "npmRebuild: false"
  next
}
skipping_publish && line ~ /^[^[:space:]#][^:]*:/ {
  skipping_publish = 0
}
skipping_publish && line == "afterSign: scripts/dist/notarize.js" {
  skipping_publish = 0
  if (enable_after_sign == "true") {
    print ""
    print line
  }
  next
}
skipping_publish && line == "afterPack: scripts/electron-builder-after-pack.js" {
  print line
  next
}
!skipping_publish && line == "afterSign: scripts/dist/notarize.js" {
  if (enable_after_sign == "true") {
    print line
  }
  next
}
!skipping_publish {
  print line
}
END {
  if (replaced_publish == 0) {
    exit 2
  }
}
' electron-builder.yml > "$output_file"

if ! grep -Fqx 'afterPack: scripts/electron-builder-after-pack.js' "$output_file"; then
  echo "Generated builder config is missing the afterPack hook" >&2
  exit 1
fi
