import * as NodeFS from 'node:fs'
import * as NodeModule from 'node:module'
import * as NodePath from 'node:path'
import { describe, expect, it } from 'vitest'

const desktopRoot = NodePath.resolve(__dirname, '../..')
const ceRoot = NodePath.resolve(desktopRoot, '../..')
const requireFromDesktop = NodeModule.createRequire(NodePath.join(desktopRoot, 'package.json'))
const babel: {
  transformFileSync: (file: string, options: Record<string, unknown>) => unknown
} = requireFromDesktop('@babel/core')
const compilerPlugin = requireFromDesktop.resolve('babel-plugin-react-compiler')

// Files the compiler skips today. A skipped file still ships, just unmemoized.
// This list only shrinks: the test fails when a file here starts compiling, so
// delete its entry in the same change.
const KNOWN_BAILOUTS: Record<string, string> = {
  'packages/components/src/chat/useCustomerReportIntake.ts': 'try/finally in answer and dismiss',
  'packages/components/src/desktop/DesktopAppSettingsScaffold.tsx': 'try/finally and throw inside try',
  'packages/components/src/desktop/DesktopStateBootstrap.tsx': 'try/finally; ++ on a variable captured by a closure',
  'packages/components/src/desktop/runbook/RunbookActionList.tsx': 'hook chosen dynamically at render',
  'packages/components/src/desktop/runbook/useRunbookCatalogFlow.ts': 'try without catch',
  'packages/components/src/desktop/runbook/useRunbookDeleteFlow.ts': 'try/finally',
  'packages/components/src/desktop/runbook/useRunbookImportFlow.ts': 'throw inside try; try/finally',
  'packages/components/src/desktop/runbook/useRunbookPersistenceFlow.ts': 'conditional or optional chaining inside try',
  'packages/components/src/desktop/runbook/useRunbookResourceData.ts': 'try/finally; throw inside try',
  'packages/components/src/desktop/useDesktopCodingAgentPrimary.ts': 'conditional or optional chaining inside try',
  'packages/components/src/hooks/useDebouncedAutoSave.ts': 'arrow function default value; try/finally',
  'packages/components/src/investigation/IntegrationActionsView.tsx': 'try/finally',
  'packages/components/src/investigation/IntegrationDeliveriesView.tsx': 'try/finally',
  'packages/components/src/investigation/KnowledgeExecutionPanel.tsx': 'try/finally',
  'packages/components/src/investigation/RunbookPicker.tsx': 'eslint-disable of a react-hooks rule',
  'packages/components/src/investigation/RunbookProposalArtifact.tsx': 'try/finally',
  'packages/components/src/settings/CodingAgentProvidersSection.tsx': 'conditional or optional chaining inside try',
  'packages/components/src/settings/GlobalVariablesSettingsSection.tsx': 'conditional or optional chaining inside try',
  'packages/components/src/settings/IntegrationConnectionsSection.tsx': 'try/finally',
  'packages/components/src/settings/TelemetrySection.tsx': 'try/finally and throw inside try',
  'packages/components/src/settings/UpdateSettingsSection.tsx': 'try/finally',
  'packages/components/src/tutorial/HelpSection.tsx': 'manual memoization the compiler cannot preserve',
  'packages/components/src/tutorial/useTour.ts': 'conditional or optional chaining inside try',
}

const SOURCE_ROOTS = ['packages/components/src', 'apps/desktop/src/renderer/src']
const EXCLUDED_DIRS = /(^|\/)(dist|__tests__|__generated__)\//
const EXCLUDED_FILES = /\.(test|spec|stories|gen)\.tsx?$|\.d\.ts$/
const EXPORTS_HOOK = /export\s+(?:default\s+)?(?:async\s+)?(?:function|const)\s+use[A-Z]/

// Every component file, plus the .ts files that define hooks.
const sourceFiles = SOURCE_ROOTS.flatMap((root) =>
  NodeFS.readdirSync(NodePath.join(ceRoot, root), { recursive: true })
    .map((file) => `${root}/${String(file).split(NodePath.sep).join('/')}`)
    .filter((file) => !EXCLUDED_DIRS.test(file) && !EXCLUDED_FILES.test(file))
    .filter(
      (file) =>
        file.endsWith('.tsx') ||
        (file.endsWith('.ts') &&
          (/^use[A-Z]/.test(NodePath.basename(file)) ||
            EXPORTS_HOOK.test(NodeFS.readFileSync(NodePath.join(ceRoot, file), 'utf8')))),
    ),
).sort()

interface CompilerEvent {
  readonly kind: string
  readonly reason?: string
  readonly data?: string
  readonly detail?: {
    readonly category?: string
    readonly reason?: string
    readonly options?: { readonly category?: string; readonly reason?: string }
  }
}

// CompileDiagnostic only reports the experimental JSX inlining, so it is not a bailout.
function compilerBailouts(file: string): string[] {
  const events: CompilerEvent[] = []
  babel.transformFileSync(NodePath.join(ceRoot, file), {
    babelrc: false,
    configFile: false,
    code: false,
    parserOpts: { plugins: ['typescript', 'jsx'] },
    plugins: [[compilerPlugin, { logger: { logEvent: (_: string, event: CompilerEvent) => events.push(event) } }]],
  })
  return events
    .filter((event) => ['CompileError', 'CompileSkip', 'PipelineError'].includes(event.kind))
    .map((event) => {
      const detail = event.detail?.options ?? event.detail
      return `${detail?.category ?? event.kind}: ${detail?.reason ?? event.reason ?? event.data ?? ''}`
    })
}

describe('React Compiler coverage', () => {
  it('the renderer build runs the compiler', () => {
    const config = NodeFS.readFileSync(NodePath.join(desktopRoot, 'electron.vite.config.ts'), 'utf8')
    expect(config).toContain("['babel-plugin-react-compiler'")
  })

  it.each(sourceFiles)('compiles %s', (file) => {
    const bailouts = compilerBailouts(file)
    if (file in KNOWN_BAILOUTS) {
      expect(bailouts, `${file} compiles now; remove it from KNOWN_BAILOUTS`).not.toEqual([])
    } else {
      expect(bailouts).toEqual([])
    }
  })

  it('lists only files that exist', () => {
    expect(Object.keys(KNOWN_BAILOUTS).filter((file) => !sourceFiles.includes(file))).toEqual([])
  })
}, 120_000)
