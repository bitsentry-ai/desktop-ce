#!/usr/bin/env bash
set -euo pipefail

HOME_DIR="${HOME:-}"
if [ -z "${HOME_DIR}" ]; then
  echo "HOME is not set; cannot resolve local app data paths."
  exit 1
fi

DB_DIRS=(
  "${HOME_DIR}/Library/Application Support/@bitsentry-ce/desktop"
  "${HOME_DIR}/Library/Application Support/BitSentry AI"
  "${HOME_DIR}/Library/Application Support/BitSentry Desktop"
  "${HOME_DIR}/Library/Application Support/ai.bitsentry.desktop.ce"
)

for db_dir in "${DB_DIRS[@]}"; do
  if [ ! -d "${db_dir}" ]; then
    echo "Skip (not found): ${db_dir}"
    continue
  fi

  rm -f "${db_dir}/bitsentry.db" "${db_dir}/bitsentry.db-wal" "${db_dir}/bitsentry.db-shm"
  rm -rf "${db_dir}/db-backups"
  echo "Cleaned DB leftovers in: ${db_dir}"
done

echo "macOS desktop DB cleanup completed."
