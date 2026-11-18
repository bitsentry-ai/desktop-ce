#!/usr/bin/env bash
# Decides whether today's CE nightly runs (only from main, only with new commits since the last
# nightly tag) and names its version, tag and R2 prefix.
# Env: GITHUB_REF_NAME, GITHUB_RUN_NUMBER, GITHUB_RUN_ATTEMPT, GITHUB_SHA, GITHUB_OUTPUT.
set -euo pipefail

if [ "${GITHUB_REF_NAME}" != "main" ]; then
  echo "Desktop CE nightlies may only be published from main; received ${GITHUB_REF_NAME}." >&2
  exit 1
fi

nightly_date="$(date -u +%Y%m%d)"
nightly_version="0.1.0-nightly.${nightly_date}"
nightly_tag="desktop-nightly-${nightly_date}.${GITHUB_RUN_NUMBER}.${GITHUB_RUN_ATTEMPT}"
r2_prefix="desktop-ce/nightly/${nightly_date}/${nightly_tag}"
artifact_version_segment="${GITHUB_SHA}"
last_nightly_tag="$(git tag --list 'desktop-nightly-*' --sort=-creatordate | head -n 1 || true)"
should_run=true

if [ -n "${last_nightly_tag}" ] && \
  git merge-base --is-ancestor "${last_nightly_tag}" "${GITHUB_SHA}" && \
  [ "$(git rev-list --count "${last_nightly_tag}..${GITHUB_SHA}")" -eq 0 ]; then
  should_run=false
  echo "No commits changed since ${last_nightly_tag}; skipping this nightly run."
fi

{
  echo "should_run=${should_run}"
  echo "nightly_date=${nightly_date}"
  echo "nightly_version=${nightly_version}"
  echo "nightly_tag=${nightly_tag}"
  echo "r2_prefix=${r2_prefix}"
  echo "artifact_version_segment=${artifact_version_segment}"
} >> "${GITHUB_OUTPUT}"
