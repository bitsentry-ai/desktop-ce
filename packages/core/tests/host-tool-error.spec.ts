import { describe, expect, it } from 'vitest'

import { parseHostToolError } from '../src/shared/host-tool-error'

const INVALID_ARGUMENTS = JSON.stringify({
  code: 'INVALID_TOOL_ARGUMENTS',
  message: 'Invalid arguments for propose_runbook_edit. Correct the fields and retry.',
  toolName: 'propose_runbook_edit',
  issues: [
    {
      path: 'operations.0.action.pluginId',
      message: 'Plugin action requires a pluginId and pluginActionId.',
    },
  ],
})

describe('parseHostToolError', () => {
  it('leads with the sentence and keeps the field paths out of it', () => {
    const parsed = parseHostToolError(INVALID_ARGUMENTS)

    expect(parsed.summary).toBe(
      'Invalid arguments for propose_runbook_edit. Correct the fields and retry.',
    )
    expect(parsed.summary).not.toContain('operations.0.action.pluginId')
    expect(parsed).toMatchObject({
      code: 'INVALID_TOOL_ARGUMENTS',
      structured: true,
      issues: [
        {
          path: 'operations.0.action.pluginId',
          message: 'Plugin action requires a pluginId and pluginActionId.',
        },
      ],
    })
  })

  it('keeps the original payload available for a technical-details view', () => {
    expect(parseHostToolError(INVALID_ARGUMENTS).raw).toBe(INVALID_ARGUMENTS)
  })

  it('passes a plain error sentence through unchanged', () => {
    expect(parseHostToolError('Runbook not found')).toEqual({
      summary: 'Runbook not found',
      issues: [],
      structured: false,
      raw: 'Runbook not found',
    })
  })

  it('shows unrecognized json rather than inventing a summary', () => {
    const foreign = '{"detail":"upstream exploded"}'

    expect(parseHostToolError(foreign)).toEqual({
      summary: foreign,
      issues: [],
      structured: false,
      raw: foreign,
    })
  })

  it('falls back to the first issue when the payload carries no message', () => {
    const payload = JSON.stringify({
      code: 'INVALID_TOOL_ARGUMENTS',
      issues: [{ path: 'title', message: 'Title is required.' }],
    })

    expect(parseHostToolError(payload)).toMatchObject({
      summary: 'Title is required.',
      code: 'INVALID_TOOL_ARGUMENTS',
      structured: true,
    })
  })

  it('drops malformed issue entries instead of rendering blanks', () => {
    const payload = JSON.stringify({
      message: 'Invalid arguments.',
      issues: [{ path: 'title' }, null, 'nope', { message: 'Title is required.' }],
    })

    expect(parseHostToolError(payload).issues).toEqual([
      { path: '', message: 'Title is required.' },
    ])
  })

  it('reports an empty summary for an empty error', () => {
    expect(parseHostToolError('   ')).toEqual({
      summary: '',
      issues: [],
      structured: false,
      raw: '   ',
    })
  })
})
