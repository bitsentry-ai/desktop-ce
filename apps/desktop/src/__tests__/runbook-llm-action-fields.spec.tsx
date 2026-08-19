// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RunbookLlmActionFields } from '@bitsentry-ce/components/desktop/runbook/RunbookLlmActionFields'
import type {
  LlmModelOption,
  RunbookActionTypeFieldsProps,
} from '@bitsentry-ce/components/desktop/runbook/RunbookActionFieldShared'
import type { RunbookActionRecord } from '@bitsentry-ce/components/services'

const modelOptions: LlmModelOption[] = [{
  providerKey: 'openai',
  modelId: 'gpt-5.6-terra',
  label: 'GPT-5.6 Terra',
}]

const actionMeta = {
  llm: { fieldLabelKey: 'Prompt', fieldPlaceholderKey: 'Prompt' },
} as unknown as RunbookActionTypeFieldsProps['actionMeta']

function renderFields(action: RunbookActionRecord, onActionChange = vi.fn()) {
  render(
    <RunbookLlmActionFields
      action={action}
      actionMeta={actionMeta}
      llmModelOptions={modelOptions}
      llmProviderHint="Choose a configured model."
      llmProviderLabelsByKey={{ openai: 'OpenAI' }}
      modelBorderClass="border-border"
      modelDropdownOpen={true}
      modelDropdownRef={{ current: null }}
      onModelDropdownOpenChange={vi.fn()}
      onActionChange={onActionChange}
      t={(key) => key}
    />,
  )
  return { onActionChange }
}

afterEach(() => {
  cleanup()
})

describe('RunbookLlmActionFields model binding', () => {
  it('renders a friendly name while retaining a canonical saved model ID', () => {
    renderFields({
      id: 'step-1',
      type: 'llm',
      title: 'Summarize',
      prompt: 'Summarize the evidence.',
      llmModel: 'gpt-5.6-terra',
      llmProviderKey: 'openai',
    })

    expect(screen.getAllByRole('textbox')[1]).toHaveProperty('value', 'GPT-5.6 Terra')
  })

  it('does not send an unknown typed model to the save draft', () => {
    const { onActionChange } = renderFields({
      id: 'step-1',
      type: 'llm',
      title: 'Summarize',
      prompt: 'Summarize the evidence.',
    })

    fireEvent.change(screen.getAllByRole('textbox')[1]!, {
      target: { value: 'GPT 5.6 Terra (invalid)' },
    })

    expect(onActionChange).not.toHaveBeenCalled()
    expect(screen.getByText(/Unknown model/)).toBeTruthy()
  })

  it('stores the canonical ID when a friendly model name is typed', () => {
    const { onActionChange } = renderFields({
      id: 'step-1',
      type: 'llm',
      title: 'Summarize',
      prompt: 'Summarize the evidence.',
    })

    fireEvent.change(screen.getAllByRole('textbox')[1]!, {
      target: { value: 'GPT 5.6 Terra' },
    })

    expect(onActionChange).toHaveBeenCalledWith(expect.objectContaining({
      llmProviderKey: 'openai',
      llmModel: 'gpt-5.6-terra',
    }))
  })
})
