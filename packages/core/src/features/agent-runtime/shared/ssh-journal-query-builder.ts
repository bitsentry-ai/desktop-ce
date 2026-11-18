/**
 * SSH + journalctl Command Builder (Shared)
 *
 * Allowlisted command construction used by both:
 * - Manual UI runner (server-logs feature)
 * - Agentic tool executor (agent-runtime feature)
 *
 * Guardrails:
 * - NEVER accepts raw command strings from renderer
 * - All remote arguments are shell-escaped per POSIX rules
 * - SSH config: BatchMode=yes, bounded ConnectTimeout
 * - Uses system SSH identity (~/.ssh, ssh-agent, SSH config)
 */

import type {
  ErrorClassification,
  SshJournalctlCommand,
  SshJournalQueryInput,
} from '../types'

type SshErrorRule = {
  matches: (stderr: string) => boolean
  classification: ErrorClassification
}

const SSH_ERROR_RULES: SshErrorRule[] = [
  {
    matches: (stderr) =>
      stderr.includes('you are currently not seeing messages from other users and the system'),
    classification: {
      message:
        'Limited journal access: some system logs are hidden. User needs adm or systemd-journal group for full access.',
      level: 'warning',
    },
  },
  {
    matches: (stderr) =>
      stderr.includes('permission denied') && stderr.includes('journalctl'),
    classification: {
      message: 'Permission denied. User may need sudo access for journalctl.',
      level: 'error',
    },
  },
  {
    matches: (stderr) => stderr.includes('permission denied'),
    classification: {
      message: 'Permission denied. Check SSH key access or user permissions.',
      level: 'error',
    },
  },
  {
    matches: (stderr) =>
      stderr.includes('could not resolve hostname') ||
      stderr.includes('name or service not known'),
    classification: {
      message: 'Host not found. Check the hostname.',
      level: 'error',
    },
  },
  {
    matches: (stderr) =>
      stderr.includes('connection timed out') ||
      stderr.includes('operation timed out'),
    classification: {
      message:
        'Connection timed out. Host is unreachable or network is blocking SSH. Check VPN, firewall, or host status.',
      level: 'error',
    },
  },
  {
    matches: (stderr) => stderr.includes('connection refused'),
    classification: {
      message: 'Connection refused. Check if host is reachable and SSH port is correct.',
      level: 'error',
    },
  },
  {
    matches: (stderr) => stderr.includes('host key verification failed'),
    classification: {
      message:
        'Host key verification failed. Remove old key from known_hosts or verify host identity.',
      level: 'error',
    },
  },
  {
    matches: (stderr) => stderr.includes('no space left on device'),
    classification: {
      message: 'Remote disk full. journalctl cannot write output.',
      level: 'error',
    },
  },
  {
    matches: (stderr) => stderr.includes('unit') && stderr.includes('not found'),
    classification: {
      message: 'Specified systemd unit not found.',
      level: 'error',
    },
  },
]

/**
 * Shell-escapes a single argument for safe use in SSH remote command string.
 * Uses single-quote wrapping with proper escaping per POSIX shell rules.
 *
 * @example
 *   shellEscape("hello's world")  // => 'hello'"'"'s world'
 */
export function shellEscape(arg: string): string {
  return `'${arg.replace(/'/g, "'\"'\"'")}'`
}

function appendSshPortArg(args: string[], input: SshJournalQueryInput): void {
  if (input.port !== undefined) {
    args.push('-p', String(input.port))
  }
}

function appendJournalTimeArgs(journalParts: string[], input: SshJournalQueryInput): void {
  if (input.until !== undefined) {
    journalParts.push('--until', shellEscape(input.until))
  }

  if (input.cursor !== undefined) {
    journalParts.push('--after-cursor', shellEscape(input.cursor))
  }
}

function appendJournalFilterArgs(journalParts: string[], input: SshJournalQueryInput): void {
  if (input.units !== undefined && input.units.length > 0) {
    for (const unit of input.units) {
      journalParts.push('--unit', shellEscape(unit))
    }
  }

  if (input.priorities !== undefined && input.priorities.length > 0) {
    journalParts.push('-p', input.priorities.join(','))
  }
}

function appendJournalLimitArgs(journalParts: string[], input: SshJournalQueryInput): void {
  const limit = input.limit ?? 1000
  journalParts.push('-n', String(limit))

  if (input.follow === true) {
    journalParts.push('-f')
  }
}

/**
 * Builds allowlisted SSH + journalctl command arguments from validated inputs.
 *
 * IMPORTANT:
 * - Only allowlisted journalctl flags are supported
 * - No raw command strings are accepted
 * - Shell escaping prevents command injection
 * - Uses system SSH identity (no key/passphrase storage)
 * - guardrail: always includes -o json for structured output
 *
 * @param input - Validated SSH journal query input
 * @returns Command args with safe display string
 */
export function buildSshJournalctlCommand(input: SshJournalQueryInput): SshJournalctlCommand {
  const args: string[] = []

  args.push('-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes')
  appendSshPortArg(args, input)

  const target = `${input.username}@${input.host}`
  args.push(target)

  // guardrail: always use JSON output for structured parsing by agent
  const journalParts: string[] = ['journalctl', '--no-pager', '--output', 'json', '--since', shellEscape(input.since)]

  appendJournalTimeArgs(journalParts, input)
  appendJournalFilterArgs(journalParts, input)
  appendJournalLimitArgs(journalParts, input)

  args.push(journalParts.join(' '))

  return {
    args,
    display: `ssh ${target} "${journalParts.join(' ')}"`,
  }
}

/**
 * Parses common SSH/journalctl error messages for actionable feedback.
 * Order matters: more specific checks must come before generic ones.
 *
 * Distinguishes between:
 * - 'warning': non-fatal hints (limited journal access, etc.)
 * - 'error': terminal failures (permission denied, unreachable, etc.)
 *
 * @param stderr - Error output from SSH/journalctl
 * @returns Classified error with message and severity level
 */
export function classifySshError(stderr: string): ErrorClassification {
  const lower = stderr.toLowerCase()

  for (const rule of SSH_ERROR_RULES) {
    if (rule.matches(lower)) {
      return rule.classification
    }
  }

  const firstLine = stderr.split('\n').find((line) => line.length > 0) ?? 'Unknown error'
  return {
    message: firstLine.slice(0, 200),
    level: 'error',
  }
}
