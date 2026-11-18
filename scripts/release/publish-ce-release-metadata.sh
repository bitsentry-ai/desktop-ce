#!/usr/bin/env bash
# Creates or updates the GitHub release that lists the CE updater feeds. Non-stable channels are prereleases.
# Env: GH_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA, RELEASE_TAG, RELEASE_VERSION, RELEASE_CHANNEL,
# ARTIFACT_BASE_URL, ARTIFACT_VERSION_SEGMENT.
set -e

cat > release-body.md <<EOF
## BitSentry Desktop CE ${RELEASE_VERSION}

Channel: ${RELEASE_CHANNEL}

### Updater feeds
- macOS arm64: ${ARTIFACT_BASE_URL}/macos/arm64/latest-mac.yml
- macOS x64: ${ARTIFACT_BASE_URL}/macos/x64/latest-mac.yml
- Windows x64: ${ARTIFACT_BASE_URL}/windows/x64/latest.yml
- Linux x64: ${ARTIFACT_BASE_URL}/linux/x64/latest-linux.yml
- Linux arm64: ${ARTIFACT_BASE_URL}/linux/arm64/latest-linux-arm64.yml

Versioned artifact prefix: ${ARTIFACT_VERSION_SEGMENT}/
EOF
if gh release view "${RELEASE_TAG}" --repo "${GITHUB_REPOSITORY}" >/dev/null 2>&1; then
  gh release edit "${RELEASE_TAG}" --repo "${GITHUB_REPOSITORY}" --title "BitSentry Desktop CE ${RELEASE_VERSION}" --notes-file release-body.md
else
  release_args=(--repo "${GITHUB_REPOSITORY}" --title "BitSentry Desktop CE ${RELEASE_VERSION}" --notes-file release-body.md --target "${GITHUB_SHA}")
  if [ "${RELEASE_CHANNEL}" != "stable" ]; then release_args+=(--prerelease); fi
  gh release create "${RELEASE_TAG}" "${release_args[@]}"
fi
