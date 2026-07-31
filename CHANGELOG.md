# Changelog

All notable changes to SuperTerminal Community Edition are documented in this file.
Entries are generated from git history with [git-cliff](https://git-cliff.org) (`pnpm run changelog`).

## [0.1.0] - Unreleased

### Added

- Initial Community Edition release: SSH runbook executor, Claude Code/Codex subprocess integration, variable passing, timeouts, log filters, global variables, runbook import/export, and folders.
- Host runbook tools now use Model Context Protocol (MCP) across Claude Code, Cursor, Codex, and OpenCode, with a token-scoped local endpoint and host-owned execution ledger.

### Changed

- Incident chats now default to Safe Tools. The retired Ask First and supervised access mode is no longer exposed.
- CLI system instructions stay out of replayed chat roles. Claude receives its native system prompt, while other CLI providers receive a clearly labelled host-instructions header.

### Fixed

- Bundled desktop builds launch the embedded MCP shim through Node and record session-tagged MCP and provider diagnostics.
- Codex normalizes empty MCP tool arguments and confines Safe Tools sessions without an explicit working directory to a unique scratch directory.
- Cursor reports any additional MCP servers it exposes at incident-session startup because its current CLI approval flag is global.
