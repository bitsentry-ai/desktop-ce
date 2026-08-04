# BitSentry Desktop

BitSentry Desktop is a macOS desktop app for on-call engineers: SSH runbooks plus AI diagnosis, local-first by design. No data leaves your machine.

This repository is the Community Edition codebase, extracted from the BitSentry monorepo.

## Layout

- `apps/desktop`: the Electron app (Electron 40 + React 19 + SQLite via Drizzle, IPC via electron-trpc).
- `packages/core`: domain logic and Zod schemas (vendored copy tracked in the CE workspace).
- `packages/components`: shared UI components (vendored copy tracked in the CE workspace).
- `packages/i18n`: translations and i18n runtime (vendored copy tracked in the CE workspace).
- `packages/electron-trpc`: IPC transport, vendored into the CE workspace and shared by CE/Pro desktop.

Inside the monorepo, Desktop CE remains the tracked base for these desktop-shared packages. Desktop Pro should derive from the CE package trees rather than replacing them with reverse links back into Pro or the root workspace.

## Setup

```sh
pnpm run setup
```

## Build and verify

```sh
pnpm run desktop:quality
```

This builds electron-trpc, typechecks, runs contract checks and tests, then builds the app. Packaging targets live under `desktop:package*`.

## License

Apache-2.0 (see [LICENSE](LICENSE)).

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
