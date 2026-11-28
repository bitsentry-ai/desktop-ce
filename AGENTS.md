# BitSentry Desktop CE

BitSentry Desktop Community Edition (Apache-2.0): an Electron app for on-call engineers that runs SSH runbooks and drives coding agent CLIs as subprocesses. Desktop Pro builds on its `@bitsentry-ce/*` packages, so treat their exports as a public API.

## Hard stops

- Never SSH into, run runbooks against, or run plugin actions on a real host unless the developer asks for that exact action.
- Never open the installed app's user data or database read-write, and never touch its keychain entries.
- Only when asked: start, package, install or clean the app (`desktop:dev`, `desktop:start`, `desktop:package*`, `desktop:install*`, `desktop:clean-macos-dev`) or publish plugins (`plugins:publish-artifacts`). When asked to run the app, use `pnpm run desktop:qa:isolated` (temporary profile, mock keychain).
- Never push to `main`: plugin changes there publish artifacts (`.github/workflows/plugins-publish.yml`). Use a PR.
- `packages/electron-trpc`, `packages/plugin-sdk` and each `packages/plugins/*` are git submodules: change them in their own repo, then bump the pointer here. The monorepo tracks this repo as `apps/desktop-ce` the same way.

## Constraints

- Credentials, runbooks, chats and history stay on the user's machine, with secrets in the OS keychain or encrypted storage, never in plain files or logs. Requests go only to hosts, endpoints, integrations and model providers the user configured.
- The host tool endpoint binds to `127.0.0.1` only (`docs/architecture/stateless-mcp-host.md`).
- User-visible strings go through `@bitsentry-ce/i18n`, in every locale under `packages/i18n/src/locales`.
- IPC payload schemas live in `packages/components/src/services/desktop-ipc-payload-schemas.ts`; every RPC channel needs one (`apps/desktop/src/__tests__/ipc-schema-parity.spec.ts`).
- Keep the edition checks in `packages/core/src/features/runbooks/desktop-runbook-execution.service.ts`: CE refuses remote model providers, and Pro shares this executor.

## Verify

Use Node from `.nvmrc`, init submodules, then `pnpm run setup`. Follow `.github/workflows/desktop-quality.yml` for the exact commands and prerequisites; `pnpm knip` runs separately. Traps:

- Lint with `pnpm run lint:ts6`; per-package `lint` scripts are no-ops.
- Run Node tests before `pnpm --dir apps/desktop run prepare:native-deps`, which rebuilds `better-sqlite3` for Electron so Vitest can no longer load it.
- Typecheck needs `electron-trpc` built first; browser tests need Playwright Chromium.

## Commits and PRs

- `.github/workflows/change-guardrails.yml` checks the PR title and every commit subject: conventional type, optional lowercase scope, then a description starting with `a-z` and using only lowercase letters, digits, spaces and `.()/_-`. Subjects feed the changelog, so write them for users. Example: `fix(runbooks): let wazuh lookups name cve findings`.
- Open PRs as drafts, with the body from `.github/pull_request_template.md`. Follow its rules except one: agents do not request reviewers or assign people.
- No `Co-Authored-By` lines or AI attribution.
