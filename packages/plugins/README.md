# Desktop Plugins

This directory is the repo-managed home for built-in desktop plugin manifests.

## Location

- In the standalone `desktop-ce` repository, the built-in plugins live at
  `packages/plugins`.
- In the main monorepo, the same directory is checked out at
  `apps/desktop-ce/packages/plugins`.

## Why

Keeping the shipped plugin manifests inside the `desktop-ce` package tree makes
them:

- versioned with the desktop runtime they target
- reviewable in normal code review
- reusable across CE and Pro desktop flows
- easier to evolve from internal integrations into user-extensible plugins

## Discovery

The desktop node runtime looks for local plugin manifests in this order:

1. `BITSENTRY_PLUGIN_DIR` entries, when explicitly configured
2. the repo-managed desktop plugin directory
3. `.bitsentry/plugins`

That means:

- CE and Pro both pick up the same built-in desktop plugin manifests
- `.bitsentry/plugins` remains available as a per-user fallback for local
  experiments and overrides

## Layout

Each plugin lives in its own directory and exposes a `plugin.json` file:

```text
packages/plugins/
  my-plugin/
    plugin.json
```

The manifest format is the same one used by the desktop local plugin loader:

- top-level plugin metadata
- auth field declarations
- action field declarations
- transport declarations
- optional trigger metadata

Two transport styles currently exist:

- `http`: bounded declarative HTTP actions
- `builtin`: repo-managed manifests that delegate back to typed desktop runtime
  executors when the action needs richer logic

## Current scope

Built-in GitHub, Sentry, Wazuh, and PostHog plugin manifests live here as
repo-managed artifacts. Some actions now execute directly through declarative
HTTP transports, while the remaining actions still delegate back to the typed
desktop runtime where safer transforms, pagination, or desktop-side effects are
still needed.
