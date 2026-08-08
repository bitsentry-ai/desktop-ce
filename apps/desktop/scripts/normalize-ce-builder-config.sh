#!/usr/bin/env bash
set -euo pipefail

config_path="${1:?builder config path is required}"
artifact_name="${2:?artifact name is required}"
temporary_path="${config_path}.tmp"

awk -v artifact_name="$artifact_name" '
BEGIN {
  in_publish = 0
}

/^[[:space:]]*artifactName:/ {
  indentation = $0
  sub(/[^[:space:]].*$/, "", indentation)
  print indentation "artifactName: \"" artifact_name "\""
  next
}

/^publish:$/ {
  in_publish = 1
  print
  next
}

in_publish && /^  url:/ {
  print
  print "  channel: latest"
  next
}

in_publish && /^npmRebuild: false$/ {
  next
}

in_publish && /^[^[:space:]#]/ {
  in_publish = 0
}

{
  print
}
' "$config_path" > "$temporary_path"

mv "$temporary_path" "$config_path"
