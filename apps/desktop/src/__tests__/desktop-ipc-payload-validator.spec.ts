import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { createDesktopIpcPayloadValidator } from '@bitsentry-ce/components/services'

function createValidator() {
  const looseObjectSchema = z.looseObject({})

  return createDesktopIpcPayloadValidator({
    llmProviderKeys: ['claude_code'],
    telemetryActionTypes: ['data_source_query'],
    exportRunbooksInputSchema: z.object({}),
    runbookImportOptionsSchema: looseObjectSchema,
    logFilterConfigSchema: looseObjectSchema,
    telemetryActionConfigSchema: looseObjectSchema,
  })
}

describe('desktop IPC payload validation', () => {
  it.each([
    [
      'agent:start',
      'prompt',
      {
        id: 'text-1',
        type: 'text',
        name: 'notes.md',
        mimeType: 'text/markdown',
        sizeBytes: 12,
        text: '# Notes',
      },
    ],
    [
      'agent:send',
      'message',
      {
        id: 'csv-1',
        type: 'csv',
        name: 'findings.csv',
        mimeType: 'text/csv',
        sizeBytes: 18,
        text: 'id,status\n1,open',
        rowCount: 1,
        totalRowCount: 1,
      },
    ],
  ] as const)('accepts %s text-based attachments', (channel, textField, attachment) => {
    const validate = createValidator()

    expect(
      validate(channel, {
        [textField]: 'Inspect the attachment',
        attachments: [attachment],
      }),
    ).toMatchObject({ attachments: [attachment] })
  })

  it('rejects unsupported text attachment MIME types', () => {
    const validate = createValidator()

    expect(() =>
      validate('agent:start', {
        prompt: 'Inspect the attachment',
        attachments: [
          {
            id: 'text-1',
            type: 'text',
            name: 'script.sh',
            mimeType: 'application/x-sh',
            sizeBytes: 12,
            text: 'echo unsafe',
          },
        ],
      }),
    ).toThrow()
  })

  it('accepts first-party plugin source types for error source probes', () => {
    const validate = createValidator()

    expect(
      validate('errorSources:probeConnection', {
        pluginId: 'github',
        sourceType: 'github',
        setupValues: {
          accessToken: 'github-token',
        },
      }),
    ).toMatchObject({
      pluginId: 'github',
      sourceType: 'github',
      setupValues: {
        accessToken: 'github-token',
      },
    })
  })

  it('rejects source-type-only error source activation payloads', () => {
    const validate = createValidator()

    expect(() =>
      validate('errorSources:create', {
        sourceType: 'github',
        name: 'GitHub Issues',
      }),
    ).toThrow()
    expect(() =>
      validate('errorSources:probeConnection', {
        sourceType: 'github',
      }),
    ).toThrow()
  })
})
