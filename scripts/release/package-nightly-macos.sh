#!/usr/bin/env bash
# Builds and packages the signed CE nightly for macOS arm64 from apps/desktop. Notarization (the
# afterSign hook) runs only when APPLE_ID, APPLE_APP_PASSWORD and APPLE_TEAM_ID are all set.
# Env: NIGHTLY_VERSION, R2_PUBLIC_BASE_URL, R2_PREFIX, CSC_*, APPLE_*.
set -euo pipefail
node -e "const fs=require('node:fs'); const p='package.json'; const j=JSON.parse(fs.readFileSync(p,'utf8')); j.version=process.env.NIGHTLY_VERSION; fs.writeFileSync(p, JSON.stringify(j,null,2)+'\\n')"
pnpm run build:shared-cli
pnpm run build:notarize-hook
pnpm run build:cli-bundle
pnpm run prepare:native-deps -- --arch=arm64
pnpm run build

export DESKTOP_UPDATE_BASE_URL="${R2_PUBLIC_BASE_URL}/${R2_PREFIX}/macos/arm64"
export DESKTOP_ARTIFACT_NAME="bitsentry-desktop-ce-\${version}-macos-aarch64.\${ext}"
if [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
  export DESKTOP_ENABLE_AFTER_SIGN=true
else
  export DESKTOP_ENABLE_AFTER_SIGN=false
fi

bash scripts/create-ci-builder-config.sh electron-builder.ci.yml
bash scripts/normalize-ce-builder-config.sh electron-builder.ci.yml "$DESKTOP_ARTIFACT_NAME"
npx electron-builder build \
  --config electron-builder.ci.yml \
  --mac \
  --arm64 \
  --publish never
