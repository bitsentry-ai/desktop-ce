/**
 * Shared composer and access-level policy types for local coding agents.
 *
 * These helpers power both the renderer composer controls and the
 * main-process provider permission mapping.
 */

import {
  DEFAULT_ACCESS_LEVEL,
  type AccessLevel,
} from '@bitsentry-ce/components/chat/types'

export type { AccessLevel, InteractionMode } from '@bitsentry-ce/components/chat/types'
export {
  DEFAULT_ACCESS_LEVEL,
  DEFAULT_INTERACTION_MODE,
  OPTION_IDS,
  ACCESS_LEVEL_LABELS,
  ACCESS_LEVEL_DESCRIPTIONS,
  INTERACTION_MODE_LABELS,
} from '@bitsentry-ce/components/chat/types'

export type {
  ComposerSelectChoice as SelectOptionChoice,
  ComposerSelectOption as SelectOptionDescriptor,
  ComposerBooleanOption as BooleanOptionDescriptor,
  ComposerOptionDescriptor as OptionDescriptor,
} from '@bitsentry-ce/components/llm/modelCatalog'

export function getCodexPolicies(accessLevel: AccessLevel): {
  approvalPolicy: 'untrusted' | 'on-request' | 'never'
  sandboxPolicy: { type: 'readOnly' | 'workspaceWrite' | 'dangerFullAccess' }
} {
  switch (accessLevel) {
    case 'auto-accept-edits':
      return {
        approvalPolicy: 'untrusted',
        sandboxPolicy: { type: 'workspaceWrite' },
      }
    case 'full-access':
      return {
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'dangerFullAccess' },
      }
  }
}

export function normalizeAccessLevel(value: unknown): AccessLevel {
  switch (value) {
    case 'auto-accept-edits':
    case 'full-access':
      return value
    default:
      return DEFAULT_ACCESS_LEVEL
  }
}

export const CLAUDE_CODE_TOOL_POLICY: Record<AccessLevel, 'none' | 'read-write' | 'all'> = {
  'auto-accept-edits': 'read-write',
  'full-access': 'all',
}

export type CloudToolApprovalMode = 'prompt' | 'auto-read' | 'auto-approve'

export const CLOUD_TOOL_APPROVAL: Record<AccessLevel, CloudToolApprovalMode> = {
  'auto-accept-edits': 'auto-read',
  'full-access': 'auto-approve',
}
