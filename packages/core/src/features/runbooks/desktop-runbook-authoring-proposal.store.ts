import type { RunbookAuthoringProposal } from './authoring'

interface ProposalRow {
  id: string
  incidentThreadId: string
  artifactId: string
  artifactVersion: number
  proposalJson: string
  createdAt: string
  updatedAt: string
}

interface ProposalDelegate {
  findMany(args: {
    where: { incidentThreadId: string }
    orderBy: { artifactVersion: 'asc' }
  }): Promise<Array<Record<string, unknown>>>
  upsert(args: {
    where: { id: string }
    create: ProposalRow
    update: Omit<ProposalRow, 'id' | 'createdAt'>
  }): Promise<unknown>
}

export interface RunbookAuthoringProposalPersistence {
  list(incidentThreadId: string): Promise<RunbookAuthoringProposal[]>
  save(proposal: RunbookAuthoringProposal): Promise<void>
}

function parseProposal(row: Record<string, unknown>): RunbookAuthoringProposal {
  if (typeof row.proposalJson !== 'string') {
    throw new Error('Stored runbook authoring proposal is invalid.')
  }
  const parsed = JSON.parse(row.proposalJson) as RunbookAuthoringProposal
  return {
    ...parsed,
    artifactId: parsed.artifactId ?? parsed.id,
    artifactVersion: parsed.artifactVersion ?? 1,
  }
}

export class SqliteRunbookAuthoringProposalStore
implements RunbookAuthoringProposalPersistence {
  constructor(private readonly db: { runbookAuthoringProposal: ProposalDelegate }) {}

  async list(incidentThreadId: string): Promise<RunbookAuthoringProposal[]> {
    const rows = await this.db.runbookAuthoringProposal.findMany({
      where: { incidentThreadId },
      orderBy: { artifactVersion: 'asc' },
    })
    return rows.map(parseProposal)
  }

  async save(proposal: RunbookAuthoringProposal): Promise<void> {
    if (proposal.incidentThreadId === undefined || proposal.incidentThreadId.length === 0) {
      return
    }
    const artifactId = proposal.artifactId ?? proposal.id
    const artifactVersion = proposal.artifactVersion ?? 1
    const proposalJson = JSON.stringify({ ...proposal, artifactId, artifactVersion })
    await this.db.runbookAuthoringProposal.upsert({
      where: { id: proposal.id },
      create: {
        id: proposal.id,
        incidentThreadId: proposal.incidentThreadId,
        artifactId,
        artifactVersion,
        proposalJson,
        createdAt: proposal.createdAt,
        updatedAt: proposal.updatedAt,
      },
      update: {
        incidentThreadId: proposal.incidentThreadId,
        artifactId,
        artifactVersion,
        proposalJson,
        updatedAt: proposal.updatedAt,
      },
    })
  }
}
