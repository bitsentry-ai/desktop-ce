// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@bitsentry-ce/components/ui/tooltip'
import { BitsentryServicesProvider } from '@bitsentry-ce/components/services/context'
import { RunbookEditorHeader } from '@bitsentry-ce/components/desktop/runbook/RunbookEditorHeader'
import type { BitsentryServicePorts } from '@bitsentry-ce/components/services/contracts'

afterEach(cleanup)

const t = (key: string) => key

function header(permissions?: Parameters<typeof BitsentryServicesProvider>[0]['permissions']) {
  return render(
    <BitsentryServicesProvider services={{} as BitsentryServicePorts} permissions={permissions}>
      <TooltipProvider>
        <RunbookEditorHeader
          runbook={{ id: 'r1', title: 'Restart cache', description: 'Clears the cache', actions: [{ id: 'a1' }] } as never}
          metaIssues={{ titleIssue: null, descriptionIssue: null }}
          currentTimeoutMinutes={15}
          currentTimeoutLabel="15m"
          idleTimeoutPresets={[{ value: 15, label: '15m' }]}
          onTitleChange={vi.fn()}
          onTitleBlur={vi.fn()}
          onDescriptionChange={vi.fn()}
          onDescriptionBlur={vi.fn()}
          onIdleTimeoutChange={vi.fn()}
          onExport={vi.fn()}
          onOpenResults={vi.fn()}
          onRun={vi.fn()}
          onDelete={vi.fn()}
          onCreateRunbook={vi.fn()}
          t={t as never}
        />
      </TooltipProvider>
    </BitsentryServicesProvider>,
  )
}

describe('runbook header permissions', () => {
  it('lets Desktop, which has no roles, change and run the runbook', () => {
    header()
    expect(screen.getByLabelText('runbooks.runbook.runbookTitle')).not.toHaveProperty('readOnly', true)
    expect(screen.getByLabelText('runbooks.runbook.newRunbook')).toHaveProperty('disabled', false)
    expect(screen.getByLabelText('runbooks.runbook.executionIdleTimeout')).toHaveProperty('disabled', false)
    expect(screen.getByLabelText('runbooks.runbook.runRunbook')).toHaveProperty('disabled', false)
  })

  it('shows the runbook read-only, with the reason, when the member may not change runbooks', () => {
    const reason = 'Your role cannot change runbooks.'
    header({ canOperate: true, canWriteRunbooks: false, writeRunbooksTitle: reason })
    const title = screen.getByLabelText('runbooks.runbook.runbookTitle')
    expect(title).toHaveProperty('readOnly', true)
    expect(title.getAttribute('title')).toBe(reason)
    expect(screen.getByLabelText('runbooks.runbook.addADescription')).toHaveProperty('readOnly', true)
    expect(screen.getByLabelText('runbooks.runbook.newRunbook')).toHaveProperty('disabled', true)
    const timeout = screen.getByLabelText('runbooks.runbook.executionIdleTimeout')
    expect(timeout).toHaveProperty('disabled', true)
    expect(timeout.getAttribute('title')).toBe(reason)
    // Running is a separate permission.
    expect(screen.getByLabelText('runbooks.runbook.runRunbook')).toHaveProperty('disabled', false)
  })

  it('disables Run with its own reason when the member may not run this runbook', () => {
    header({ canOperate: false, operatorTitle: 'Read-only runbooks only.' })
    const run = screen.getByLabelText('runbooks.runbook.runRunbook')
    expect(run).toHaveProperty('disabled', true)
    expect(run.getAttribute('title')).toBe('Read-only runbooks only.')
  })
})
