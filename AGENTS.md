# BitSentry Desktop

BitSentry Desktop is a desktop app for on-call engineers: SSH runbooks plus AI diagnosis, local-first by design. This repository is the Community Edition (CE), licensed Apache-2.0. It ships the full runbook executor and runs coding agent CLIs (Claude Code, Codex, Cursor, OpenCode) as subprocesses that reach the app through local host tools.

BitSentry Desktop Pro builds on the packages in this repository through `@bitsentry-ce/*`. Treat their exports as a public seam: a breaking change here breaks Pro too.

## What we never compromise on

### 1. Correctness first

Runbooks SSH into production servers and run commands there. A wrong command, a misread result, or a step that silently runs against the wrong host is an outage for the person using the app. Prefer refusing with a clear reason over guessing. Read-only checks stay read-only, and anything that changes a host needs the operator's approval.

### 2. Local-first

No data leaves the user's machine. Runbooks, execution history, chats and diagnosis live in local SQLite. Credentials live in the OS keychain or encrypted local storage, never in plain files or logs. The host tool endpoint binds to `127.0.0.1` only. A feature that needs a server does not belong here.

### 3. Plain language

Users are engineers at 3am. Copy, error messages, PR titles and chat replies use plain words and say what happened and what to do next. No AI jargon, no em-dashes.

## How to work

Understand the real constraint before changing anything, then make the smallest change that makes the correct behavior unsurprising. Do not keep complexity just because it exists, and do not add machinery because it looks architecturally impressive. Measure twice, cut once, and YAGNI. Fight scope creep.

Treat this file as good defaults, not hard rules. The developer's instructions override anything here. If a rule fights the task in front of you, say so plainly and get sign-off before breaking it.

## A small glossary

- **you** means the agent reading this file.
- **we** and **maintainers** mean the people building BitSentry Desktop, who you are talking to now.
- **user** means the on-call engineer using the app.
- **runbook** means an ordered list of steps (SSH commands, HTTP calls, plugin actions) run against hosts.
- **execution** means one run of a runbook, with its step results.
- **connection** means a saved SSH target and its credential.
- **provider** means a coding agent CLI the app drives: Claude Code, Codex, Cursor or OpenCode.
- **host tools** means the tools the app exposes to providers over a local MCP endpoint. See [docs/architecture/stateless-mcp-host.md](docs/architecture/stateless-mcp-host.md).
- **plugin** means an integration package (GitHub, Sentry, PostHog, Wazuh, iTop, Outline, Linux CVE status and remediation) built on the plugin SDK.

## The ways to hurt yourself

1. **Touching real hosts.** Never SSH into, run runbooks against, or run plugin actions on a real server unless the developer asks for that exact action.
2. **Writing to the live install.** The installed app's user data directory and keychain entries hold the developer's real runbooks, connections and credentials. Never open the database read-write, clean it up, or delete keychain items.
3. **Starting the app unasked.** `pnpm run desktop:dev` and the packaging scripts launch or build the real app. Run them only when the developer asks to run or test it.
4. **Editing submodules from here.** `packages/electron-trpc`, `packages/plugin-sdk` and every directory in `packages/plugins/` are separate repositories. Change them there, then bump the pointer here in its own PR, like `chore(plugins): pin wazuh to the record lookup actions`.
5. **Native module ABI.** Vitest runs under Node, the app runs under Electron, and `better-sqlite3` and the keyring are native modules. Run Node tests before `pnpm --dir apps/desktop run prepare:native-deps`, the order CI uses. If tests fail to load a native module, it was rebuilt for the wrong runtime.

## Hit every surface

The most common defect is a change that works on the path you tested and is missing everywhere else. Before calling work done, walk this list and say which entries applied:

- **IPC.** A renderer feature crosses the main/renderer boundary. Payloads are validated with Zod in both `packages/components/src/services/desktop-ipc-payload-schemas.ts` and `apps/desktop/src/main/platform/app/ipc/schemas.ts`. The contract and parity tests in `apps/desktop/src/__tests__` keep them in sync.
- **Providers.** Claude Code, Codex, Cursor and OpenCode each have an adapter in `packages/coding-agents`. A provider-shaped feature needs a decision per adapter, even if the decision is "not supported here".
- **Host tools.** A capability a user can trigger from the UI is usually one a provider should reach as a host tool. That only works when it is a service method, not handler code.
- **CLI.** `packages/desktop-cli` shares runtime and credential code with the app. A change to plugins, credentials or runbook execution usually reaches it too.
- **Platforms.** The app packages for macOS, Linux and Windows. Paths, shells and process handling differ.
- **Translations.** User-visible strings go through `@bitsentry-ce/i18n`, in every locale under `packages/i18n/src/locales`.
- **Reverse states.** If you added a way in, add the way out and the way to see it. A one-way door is a bug.
- **Docs.** Check whether the change makes existing guidance inaccurate. See [Documentation](#documentation).

## Verifying

- Setup: use the Node version in `.nvmrc`, initialize the package submodules, then `pnpm run setup`.
- `pnpm run build` must pass before a task is done.
- Lint with `pnpm run lint:ts6`. Per-package `lint` scripts only print a warning, because typescript-eslint does not support the TypeScript 7 compiler API yet.
- Typecheck with `pnpm run desktop:typecheck` and `pnpm run desktop:typecheck:test`.
- While you iterate, run focused tests: `pnpm --filter @bitsentry-ce/desktop test -- <path>`, `pnpm --filter @bitsentry-ce/core test -- <path>`, `pnpm --filter @bitsentry-ce/desktop-cli test -- <path>`. The desktop tests build the plugins first, so the plugin submodules must be present.
- Plugin or plugin runtime changes: `pnpm run plugin-system:test`.
- `pnpm run desktop:quality` runs the full local gate: typecheck, contract checks, plugin system tests, desktop tests and build.
- Behavior changes ship with focused tests for that behavior. Logic, data, state and protocol bugs get a failing test first, then the fix. Purely visual bugs get before/after screenshots instead of a test.
- Test meaningful logic or observable behavior. Do not add tests that only assert callback wiring or mirror the implementation.

## Pull requests

- Never open a PR unless the developer asks.
- Branch from the latest `origin/main`.
- CI checks the PR title and every commit subject against `.github/workflows/change-guardrails.yml`: a conventional type (`build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, `test`), an optional lowercase scope, then a lowercase subject using only letters, digits, spaces and `.()/_-`. Example: `fix(runbooks): let wazuh record lookups name cve findings`.
- The changelog is generated from these subjects with git-cliff (`pnpm run changelog`), so write them for users.
- Body: what was wrong or missing, what changed as a short list, and what proves it.
- UI changes need before/after screenshots. Upload them to the PR. Never commit PR-only assets.
- One request is one PR. Split it only when asked.
- Do not add `Co-Authored-By` lines or AI attribution footers to commits or PRs.

## Documentation

Most code changes do not need a docs change. Agents can read the code.

- `docs/architecture/` is for decisions and constraints that span components or are hard to discover from the source. Before adding a paragraph, ask what a maintainer would get wrong without it. If the code answers the question, leave it out.
- Do not enumerate fields or methods, narrate control flow, keep file catalogs, or append PR summaries. When a documented decision changes, rewrite or remove the old text instead of appending.
- Do not commit implementation plans, research notes or agent scratch files.

## Where code lives

- `apps/desktop`: the Electron app (`@bitsentry-ce/desktop`). `src/main` holds the main process: `platform/` for Electron, IPC, storage and runtime wiring, `features/` for app-level features. `src/preload` is the bridge, `src/renderer` mounts the UI. Tests live in `src/__tests__`.
- `packages/core`: domain logic, Zod schemas and the local SQLite client (better-sqlite3 + Drizzle). `kernel/` holds errors, results and DI tokens, `features/` holds the domain modules.
- `packages/components`: the React UI, including the IPC contract and payload schemas the renderer uses.
- `packages/coding-agents`: provider adapters, subprocess lifecycle, and the host MCP server and stdio shim.
- `packages/desktop-cli`: the bundled CLI, plugin credential storage and packaging helpers.
- `packages/i18n`: the i18n runtime and translation bundles.
- `packages/electron-trpc`: IPC transport. A submodule with its own lockfile.
- `packages/plugin-sdk`: the plugin SDK (`@bitsentry/plugin-sdk`). A submodule.
- `packages/plugins/*`: one submodule per plugin. `itop` and `outline` install and build on their own, outside the workspace.
- `scripts/`: lint, i18n, plugin artifact and security check tooling.

## Taste

- Complexity belongs at the adapter boundary. Domain logic stays pure, UI stays dumb.
- Features are services; transports stay thin. An IPC handler or host tool decodes input, calls one service method, and maps errors.
- Validate at the boundary with Zod. Inferred types over annotations. `any` is the enemy.
- Fail loudly and specifically. A refusal that says what was wrong and whether anything ran beats a silent empty result.
- Comments say why: a constraint, an external quirk, or an invariant the code cannot show. Do not restate names, narrate steps, or record history.
- Security matters most where we hold credentials or run commands on hosts. Do not over-index on it for maintainer-only tooling.
