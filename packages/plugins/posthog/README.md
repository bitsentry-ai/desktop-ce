# @bitsentry/plugin-posthog

BitSentry code plugin for PostHog projects and event queries.

This package is source for a first-party SuperTerminal plugin. In v1, CI builds the
TypeScript plugin into a single `plugin.js` artifact, uploads that artifact to the
BitSentry Cloudflare R2 bucket, and updates the first-party YAML index.

```sh
pnpm run build
```

Users install the published artifact through the index, not from an npm package or
archive:

```sh
bitsentry plugin install posthog
```
