import { describe, expect, it, vi } from 'vitest'
import { createRunbookCreationProposal } from '../src/features/runbooks/authoring'
import { SqliteRunbookAuthoringProposalStore } from '../src/features/runbooks/desktop-runbook-authoring-proposal.store'

describe('SqliteRunbookAuthoringProposalStore', () => {
  it('persists and reloads artifact lineage for an incident', async () => {
    const proposal = createRunbookCreationProposal({
      id: 'proposal-v2',
      artifactId: 'artifact-1',
      artifactVersion: 2,
      parentProposalId: 'proposal-v1',
      incidentThreadId: 'incident-1',
      prompt: 'Add readiness checks.',
      draftRunbook: {
        title: 'API health',
        description: 'Check API health.',
        actions: [{
          id: 'health',
          type: 'http',
          title: 'Check health',
          url: 'https://example.test/health',
          method: 'GET',
        }],
      },
    })
    const rows: Array<Record<string, unknown>> = []
    const delegate = {
      findMany: vi.fn().mockImplementation(() => Promise.resolve(rows)),
      upsert: vi.fn().mockImplementation(({ create }: { create: Record<string, unknown> }) => {
        rows.splice(0, rows.length, create)
        return Promise.resolve(create)
      }),
    }
    const store = new SqliteRunbookAuthoringProposalStore({
      runbookAuthoringProposal: delegate,
    })

    await store.save(proposal)
    const restored = await store.list('incident-1')

    expect(delegate.findMany).toHaveBeenCalledWith({
      where: { incidentThreadId: 'incident-1' },
      orderBy: { artifactVersion: 'asc' },
    })
    expect(restored).toMatchObject([{
      id: 'proposal-v2',
      artifactId: 'artifact-1',
      artifactVersion: 2,
      parentProposalId: 'proposal-v1',
    }])
  })
})
