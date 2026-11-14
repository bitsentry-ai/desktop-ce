import { describe, expect, it, vi } from 'vitest'

import { subscribeToFullExecutions } from '@bitsentry-ce/components/services/runbookExecutionEvents'

type Execution = { status: string; snapshotVersion?: number; steps: Array<{ output: string }> }
type Event = { resultId: string; executionId: string; execution: Execution; step?: { index: number; record: unknown } }

const full = (version: number, outputs: string[], status = 'running'): Event => ({
  resultId: 'r-1', executionId: 'e-1', execution: { status, snapshotVersion: version, steps: outputs.map((output) => ({ output })) },
})
const flush = (version: number, index: number, output: string): Event => ({
  resultId: 'r-1', executionId: 'e-1', execution: { status: 'running', snapshotVersion: version, steps: [] }, step: { index, record: { output } },
})

describe('runbook execution events', () => {
  it('rebuilds whole executions from step flushes and fetches the execution after a missed one', async () => {
    const handlers: Array<(event: Event) => void> = []
    const emit = (event: Event) => { for (const handler of handlers) handler(event) }
    const getExecution = vi.fn(async () => full(5, ['a', 'b3']).execution)
    const seen: Execution[] = []
    subscribeToFullExecutions<Execution>((handler) => { handlers.push(handler); return () => undefined }, getExecution, (event) => { seen.push(event.execution) })

    emit(full(1, ['a', '']))
    emit(flush(2, 1, 'b1'))
    emit(flush(4, 1, 'b3'))
    await vi.waitFor(() => { expect(seen).toHaveLength(3) })
    emit(flush(6, 0, 'a2'))

    expect(seen.map((execution) => execution.steps.map((step) => step.output))).toEqual([['a', ''], ['a', 'b1'], ['a', 'b3'], ['a2', 'b3']])
    expect(getExecution).toHaveBeenCalledTimes(1)
  })

  it('keeps a finished execution when a fetch started before it finished resolves later', async () => {
    const handlers: Array<(event: Event) => void> = []
    const emit = (event: Event) => { for (const handler of handlers) handler(event) }
    let resolveFetch: ((execution: Execution) => void) | undefined
    const getExecution = vi.fn(() => new Promise<Execution>((resolve) => { resolveFetch = resolve }))
    const seen: Execution[] = []
    subscribeToFullExecutions<Execution>((handler) => { handlers.push(handler); return () => undefined }, getExecution, (event) => { seen.push(event.execution) })

    emit(full(1, ['a']))
    emit(flush(3, 0, 'a2'))
    emit(full(4, ['done'], 'completed'))
    resolveFetch?.(full(3, ['a2']).execution)
    await vi.waitFor(() => { expect(getExecution).toHaveBeenCalledTimes(1) })
    await new Promise((resolve) => setTimeout(resolve, 0))
    emit(full(2, ['a1']))

    expect(seen.map((execution) => [execution.status, execution.steps.map((step) => step.output)])).toEqual([['running', ['a']], ['completed', ['done']]])
  })
})
