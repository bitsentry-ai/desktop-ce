import { describe, expect, it } from 'vitest'

import type {
  RunbookExecutionRequest,
  RunbookGateway,
} from '../src/features/runbooks'

export type RunbookGatewayContractScenario = {
  gateway: RunbookGateway
  recreateGateway(): RunbookGateway | Promise<RunbookGateway>
  request: RunbookExecutionRequest
  expectedRunbook: {
    id: string
    title: string
    revisionNumber: number
  }
}

/**
 * Product-neutral contract suite. Desktop and Cloud adapters supply the same
 * durable scenario so their observable gateway behavior cannot drift.
 */
export function describeRunbookGatewayContract(
  product: string,
  createScenario: () => RunbookGatewayContractScenario | Promise<RunbookGatewayContractScenario>,
): void {
  describe(`${product} RunbookGateway contract`, () => {
    it('lists and resolves the selected executable runbook', async () => {
      const scenario = await createScenario()

      await expect(scenario.gateway.listExecutable()).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: scenario.expectedRunbook.id }),
        ]),
      )
      await expect(scenario.gateway.getRunbookContext(scenario.expectedRunbook.id)).resolves.toMatchObject({
        runbook: scenario.expectedRunbook,
      })
    })

    it('returns a durable execution event and replays one request key after recreation', async () => {
      const scenario = await createScenario()
      const events: Array<{ executionId: string; incidentId: string | null }> = []
      const incidentId = scenario.request.incidentId
      if (incidentId === undefined) {
        throw new Error('RunbookGateway contract scenario must provide an incidentId')
      }
      const unsubscribe = scenario.gateway.subscribe(incidentId, (event) => {
        events.push({ executionId: event.executionId, incidentId: event.incidentId })
      })

      const accepted = await scenario.gateway.start(scenario.request)
      const recreatedGateway = await scenario.recreateGateway()
      const replay = await recreatedGateway.start(scenario.request)
      const recovered = await recreatedGateway.get(accepted.executionId)
      unsubscribe()

      expect(accepted).toMatchObject({
        executionId: expect.any(String),
        runbook: scenario.expectedRunbook,
        deduplicated: false,
      })
      expect(events).toContainEqual({
        executionId: accepted.executionId,
        incidentId,
      })
      expect(replay).toMatchObject({
        executionId: accepted.executionId,
        resultId: accepted.resultId,
        deduplicated: true,
      })
      expect(recovered).toMatchObject({
        executionId: accepted.executionId,
        runbookId: scenario.expectedRunbook.id,
        runbookRevisionNumber: scenario.expectedRunbook.revisionNumber,
      })
    })
  })
}
