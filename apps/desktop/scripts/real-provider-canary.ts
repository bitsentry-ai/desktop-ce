import path from 'node:path'

type CLIProbeResult = {
  auth: { status: 'authenticated' | 'unauthenticated' | 'unknown' }
  status: 'ready' | 'error' | 'warning'
  errorKind?: string
  message?: string
}

type CanaryProbeModule = {
  probeClaudeCode(binaryPath: string): Promise<CLIProbeResult>
  probeCodex(binaryPath: string): Promise<CLIProbeResult>
  probeCursor(binaryPath: string): Promise<CLIProbeResult>
  probeOpenCode(binaryPath: string): Promise<CLIProbeResult>
}

const canaryProbeModule = require(
  path.resolve(__dirname, '../../../../packages/coding-agents/dist/cli-probe.service.js'),
) as CanaryProbeModule

type CanaryProbe = {
  flag: string
  name: string
  run: () => Promise<CLIProbeResult>
}

const probes: CanaryProbe[] = [
  { flag: 'BITSENTRY_REAL_CODEX_PROBE', name: 'Codex', run: () => canaryProbeModule.probeCodex('codex') },
  { flag: 'BITSENTRY_REAL_CLAUDE_PROBE', name: 'Claude Code', run: () => canaryProbeModule.probeClaudeCode('claude') },
  { flag: 'BITSENTRY_REAL_CURSOR_PROBE', name: 'Cursor', run: () => canaryProbeModule.probeCursor('cursor-agent') },
  { flag: 'BITSENTRY_REAL_OPENCODE_PROBE', name: 'OpenCode', run: () => canaryProbeModule.probeOpenCode('opencode') },
]

function enabled(flag: string): boolean {
  return process.env[flag] === '1'
}

async function main(): Promise<void> {
  const selected = probes.filter((probe) => enabled(probe.flag))
  if (selected.length === 0) {
    process.stdout.write('No real-provider canary flags enabled; skipped.\n')
    return
  }

  const failures: string[] = []
  for (const probe of selected) {
    const result = await probe.run()
    process.stdout.write(`${probe.name}: ${result.status} (${result.auth.status})\n`)
    if (result.status === 'error' || result.auth.status === 'unauthenticated') {
      failures.push(`${probe.name}: ${result.message ?? result.errorKind ?? 'probe failed'}`)
    }
  }

  if (failures.length > 0) {
    throw new Error(`Real-provider canary failed:\n${failures.join('\n')}`)
  }
}

void main().catch((error: unknown) => {
  let message = String(error)
  if (error instanceof Error) {
    message = error.message
  }
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
