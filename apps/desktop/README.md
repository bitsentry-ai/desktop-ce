# BitSentry Desktop App

BitSentry Desktop is the local-first Electron runtime for BitSentry's incident investigation harness. It provides a typed IPC/tRPC boundary, local SQLite persistence, desktop-native auth/session flows, and the execution boundary for controlled investigations, diagnoses, and report generation.

## Workspace Role

- Package: `@bitsentry-ce/desktop`
- Runtime: Electron + React + TypeScript
- Transport: `electron-trpc` + shared IPC contracts from desktop-local shared modules
- Core reuse: domain logic from `@bitsentry-ce/core`

## Architecture

- Main process (`src/main`):
  - IPC dispatcher and handlers
  - SQLite repositories and migration/bootstrap logic
  - job runtime/schedules
  - security boundary enforcement (validation, rate controls, secret handling)
- Preload (`src/preload`):
  - isolated bridge and event subscription API
  - `electron-trpc` exposure
- Renderer (`src/renderer/src`):
  - route/pages and UI flows
  - typed desktop IPC invocation via shared channel contracts

## Key Scripts

Run from repo root:

```bash
pnpm --filter @bitsentry-ce/desktop run test
pnpm --filter @bitsentry-ce/desktop run test:contracts
pnpm --filter @bitsentry-ce/desktop run test:smoke
pnpm --filter @bitsentry-ce/desktop run typecheck:contract
pnpm --filter @bitsentry-ce/desktop run test:error-sources
pnpm --filter @bitsentry-ce/desktop run typecheck
pnpm --filter @bitsentry-ce/desktop run build
pnpm --filter @bitsentry-ce/desktop run package:mac:arm64
pnpm --filter @bitsentry-ce/desktop run package:mac:arm64:install
pnpm --filter @bitsentry-ce/desktop run clean-macos-dev
pnpm --filter @bitsentry-ce/desktop run package:mac:x64
```

macOS note: moving `.app` to Trash does not remove app data in `~/Library`.
Use `clean-macos-dev` to remove local DB leftovers.

Additional cross-workspace quality gates:

```bash
pnpm run desktop:test
pnpm run desktop:test:contracts
pnpm run desktop:test:smoke
pnpm run desktop:typecheck
pnpm run typecheck
pnpm run lint
```

## Desktop Feature Surface (Current)

- Auth/session:
  - password login
  - optional TOTP setup/enable/disable
  - session lock/unlock with idle/sleep policy support
- Security operations:
  - agents, vulnerabilities, threats, analytics
  - integrations with provider routing
  - reports and export flows
- Telemetry processor parity:
  - `telemetry:v3:*`, `diagnosis:*`, and `cve:*` IPC namespaces
  - local telemetry/diagnosis/CVE persistence
  - scheduler catch-up and queued runtime behavior
- Supportability:
  - mutation-level audit logging
  - startup diagnostics artifact
  - diagnostics export for support workflows
- External sources:
  - Settings > `External Sources` handles source connection
  - Dashboard auto-selects the saved primary source when it is still valid
  - Dashboard only shows the source dropdown when no valid primary source is configured

## Product Direction (Target)

- Top-level product objects:
  - `Incident`: the case record users create and track
  - `Investigation`: the controlled chat-like workspace inside an incident
  - `Diagnosis`: one runbook execution within an investigation
  - `Runbook`: predefined procedure used to gather, parse, and explain evidence
- Primary diagnosis workspace:
  - `Report`
  - `Analysis Trace`
  - `Evidence`
- Current code reality:
  - desktop code is still diagnosis-first
  - there is no shipped first-class incident object yet
  - desktop now ships a DB-backed runbook editor with normalized action storage, revision tracking, and structured context export
  - running a runbook now starts a sequential main-process execution session
  - `shell`, `llm`, `http`, and `external_source` runbook actions execute today; `llm` actions can inspect prior results through read-only runbook context tools
  - diagnosis launch snapshots the exported runbook context for that execution, while the diagnosis view subscribes to live execution snapshots
  - `http` actions support method, URL, headers, and optional request body; `external_source` actions query selected saved sources through installed code plugins
  - execution snapshots are persisted to diagnosis sessions and stale running sessions are marked failed after restart; full step resumption across restart, runbook approval, and structured shell target resolution remain unfinished

## Runbook Model (Current)

- Persistence:
  - `Runbook` stores metadata plus `revisionNumber`
  - `RunbookAction` stores one ordered action row per runbook action
  - legacy `RunbookVersion.actionsJson` remains only as a migration source
- Renderer behavior:
  - `/runbooks` reads and writes through dedicated desktop IPC handlers
  - action edits save on committed UI interactions
  - drag/drop reorder rewrites canonical `sortOrder`
  - export generates deterministic `RunbookContextV1` JSON on demand
- Execution behavior:
  - `runbooks:execute` starts a sequential execution session in main process
  - `runbooks:getExecution` and `bitsentry:runbooks:execution` provide live per-step status and output snapshots to the Diagnosis page
  - `llm` is the canonical action type name; legacy `ai` values are normalized for compatibility
  - `llm` steps run the authored prompt as-is and can call read-only context tools: `get_previous_result`, `get_step_result`, `list_available_results`, and `get_runbook_context`
  - `http` steps execute in the main process using authored method, URL, headers, and optional request body; non-2xx responses fail the step with captured response context
  - `external_source` steps execute saved-source queries in the main process through plugin-backed provider actions
  - persisted execution snapshots are stored on `DiagnosisSession`; on the next app launch, stale running sessions are marked failed rather than resumed
- Diagnosis launch:
  - starting a diagnosis stores `runbookRevisionNumber` and `runbookContextJson` in the diagnosis session snapshot
  - later runbook edits do not mutate the already-launched diagnosis context

## Important Paths

- IPC contracts: `apps/desktop/src/shared/ipc/ipc-contract.ts`
- Runbook handlers: `apps/desktop/src/main/features/runbooks/runbooks.handlers.ts`
- Main router wiring: `apps/desktop/src/main/trpc/router.ts`
- Dispatcher/security boundary: `apps/desktop/src/main/ipc/dispatcher.ts`
- Desktop contract tests: `apps/desktop/src/__tests__/*.test.ts`

## Documentation

- Plan and gates: `docs/features/bitsentry-desktop/plan/plan.md`
- Final change inventory: `docs/features/bitsentry-desktop/plan/final_changes.md`
- Final validation snapshot: `docs/features/bitsentry-desktop/plan/final_validation_doc.md`
- Phase ledger: `docs/features/bitsentry-desktop/phases.md`
