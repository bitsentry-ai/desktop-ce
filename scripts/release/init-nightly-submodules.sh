#!/usr/bin/env bash
# Points the package submodules at their HTTPS remotes and fetches them shallowly.
set -euo pipefail
git config submodule.packages/electron-trpc.url https://github.com/bitsentry-ai/electron-trpc.git
git config submodule.packages/plugin-sdk.url https://github.com/bitsentry-ai/-bitsentry-plugin-sdk.git
git config submodule.packages/plugins/github.url https://github.com/bitsentry-ai/bitsentry-plugin-github.git
git config submodule.packages/plugins/linux-cve-status.url https://github.com/bitsentry-ai/bitsentry-plugin-linux-cve-status.git
git config submodule.packages/plugins/posthog.url https://github.com/bitsentry-ai/bitsentry-plugin-posthog.git
git config submodule.packages/plugins/sentry.url https://github.com/bitsentry-ai/bitsentry-plugin-sentry.git
git config submodule.packages/plugins/wazuh.url https://github.com/bitsentry-ai/bitsentry-plugin-wazuh.git
git config submodule.packages/plugins/itop.url https://github.com/bitsentry-ai/bitsentry-plugin-itop.git
git config submodule.packages/plugins/outline.url https://github.com/bitsentry-ai/bitsentry-plugin-outline.git
git submodule update --init --depth 1 \
  packages/electron-trpc \
  packages/plugin-sdk \
  packages/plugins/github \
  packages/plugins/linux-cve-status \
  packages/plugins/posthog \
  packages/plugins/sentry \
  packages/plugins/wazuh \
  packages/plugins/itop \
  packages/plugins/outline
