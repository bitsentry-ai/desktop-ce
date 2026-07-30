import { describe, expect, it } from 'vitest'

import { stripInternalHostBlocks } from '@bitsentry-ce/components/lib/hostProtocol'

describe('stripInternalHostBlocks', () => {
  it('removes foreign function-call markup including an unclosed trailing tag', () => {
    const value = [
      "I'll discover the available runbooks for this incident.",
      '<function_calls>',
      '[{"tool_name": "list_runbooks", "arguments": {}}]',
      '</function_calls>',
      '<function_calls>',
      '',
      'Here are the available runbooks for this incident:',
    ].join('\n')

    expect(stripInternalHostBlocks(value)).toBe(
      "I'll discover the available runbooks for this incident.",
    )
  })
})
