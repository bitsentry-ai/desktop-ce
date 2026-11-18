#!/usr/bin/env bash
# Maps the requested CE channel to its R2 prefix and whether GitHub release metadata is published.
# Env: RELEASE_VERSION, RELEASE_CHANNEL, BASE_URL, GITHUB_REF_NAME, GITHUB_SHA, GITHUB_OUTPUT.
set -e

if [[ ! "${RELEASE_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.+][0-9A-Za-z.-]+)?$ ]]; then
  echo "Invalid CE release version: ${RELEASE_VERSION}" >&2
  exit 1
fi

sanitized_ref="$(printf '%s' "${GITHUB_REF_NAME}" | tr '/:@' '---')"
if [ "${RELEASE_CHANNEL}" = "stable" ] && [ "${GITHUB_REF_NAME}" != "main" ]; then
  echo "Stable CE releases can only be published from main." >&2
  exit 1
fi

if [ "${RELEASE_CHANNEL}" = "stable" ]; then
  artifact_prefix="desktop-ce/releases"
  artifact_version_segment="desktop-ce-v${RELEASE_VERSION}"
  publish_release_metadata=true
elif [ "${RELEASE_CHANNEL}" = "beta" ]; then
  artifact_prefix="desktop-ce/beta/${sanitized_ref}"
  artifact_version_segment="${GITHUB_SHA}"
  publish_release_metadata=true
else
  artifact_prefix="desktop-ce/previews/${sanitized_ref}"
  artifact_version_segment="${GITHUB_SHA}"
  publish_release_metadata=false
fi

{
  echo "release_tag=desktop-ce-v${RELEASE_VERSION}"
  echo "release_version=${RELEASE_VERSION}"
  echo "release_display_version=v${RELEASE_VERSION}"
  echo "release_channel=${RELEASE_CHANNEL}"
  echo "artifact_prefix=${artifact_prefix}"
  echo "artifact_version_segment=${artifact_version_segment}"
  echo "artifact_base_url=${BASE_URL}/${artifact_prefix}"
  echo "publish_release_metadata=${publish_release_metadata}"
} >> "${GITHUB_OUTPUT}"
