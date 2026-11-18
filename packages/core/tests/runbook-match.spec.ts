import { describe, expect, it } from 'vitest'
import {
  RUNBOOK_MATCH_TIER,
  foldText,
  matchWords,
  rankRunbooks,
  resolveRunbookMatch,
  scoreRunbookMatch,
} from '../src/shared/runbook-match'

const runbooks = [
  {
    id: 'nginx',
    title: 'Restart nginx',
    description: 'Reload the web server after a config change.',
    stepTitles: ['Check config syntax', 'Restart service'],
  },
  {
    id: 'disk',
    title: 'Disk pressure triage',
    description: 'Find what is filling the root volume and confirm log rotation is working.',
    stepTitles: ['Top directories by size', 'Check logrotate'],
  },
  {
    id: 'tls',
    title: 'TLS certificate expiry check',
    description: 'Confirm the public endpoint serves a certificate that is not about to expire.',
    stepTitles: ['Fetch certificate'],
  },
  {
    id: 'cafe',
    title: 'Café cache warmup',
    description: '',
  },
]

describe('text folding', () => {
  it('drops accents and filler words', () => {
    expect(foldText('Café')).toBe('cafe')
    expect(matchWords('Please run the Disk-pressure runbook')).toEqual(['disk', 'pressure'])
  })
})

describe('scoreRunbookMatch', () => {
  it('ranks title matches above description matches', () => {
    expect(scoreRunbookMatch('Restart nginx', runbooks[0])).toBe(RUNBOOK_MATCH_TIER.exactTitle)
    expect(scoreRunbookMatch('restart', runbooks[0])).toBe(RUNBOOK_MATCH_TIER.titlePrefix)
    expect(scoreRunbookMatch('nginx', runbooks[0])).toBe(RUNBOOK_MATCH_TIER.titleWordStart)
    expect(scoreRunbookMatch('nginx restart', runbooks[0])).toBeGreaterThanOrEqual(RUNBOOK_MATCH_TIER.allWordsInTitle)
    expect(scoreRunbookMatch('root volume', runbooks[1])).toBeGreaterThanOrEqual(RUNBOOK_MATCH_TIER.allWords)
    expect(scoreRunbookMatch('root volume', runbooks[1])).toBeLessThan(RUNBOOK_MATCH_TIER.allWordsInTitle)
  })

  it('tolerates one typo in longer words and accents', () => {
    expect(scoreRunbookMatch('nginx restrat', runbooks[0])).toBeGreaterThan(0)
    expect(scoreRunbookMatch('certificat expiry', runbooks[2])).toBeGreaterThan(0)
    expect(scoreRunbookMatch('cafe cache', runbooks[3])).toBe(RUNBOOK_MATCH_TIER.titlePrefix)
  })

  it('matches step names', () => {
    expect(scoreRunbookMatch('logrotate', runbooks[1])).toBeGreaterThanOrEqual(RUNBOOK_MATCH_TIER.allWords)
  })

  it('does not match unrelated words', () => {
    expect(scoreRunbookMatch('database backup', runbooks[0])).toBe(0)
  })
})

describe('rankRunbooks', () => {
  it('puts the title match before a description mention', () => {
    const ranked = rankRunbooks('certificate', runbooks).map(({ runbook }) => runbook.id)
    expect(ranked[0]).toBe('tls')
  })
})

describe('resolveRunbookMatch', () => {
  it('commits to a runbook named by its title or by what it does', () => {
    expect(resolveRunbookMatch('the nginx restart runbook', runbooks)).toEqual({ kind: 'match', runbook: runbooks[0] })
    expect(resolveRunbookMatch('the one that finds what is filling the root volume', runbooks)).toEqual({
      kind: 'match',
      runbook: runbooks[1],
    })
  })

  it('returns candidates instead of guessing when two runbooks match equally', () => {
    const twins = [
      { id: 'a', title: 'Restart nginx on web', description: '' },
      { id: 'b', title: 'Restart nginx on api', description: '' },
    ]
    const resolution = resolveRunbookMatch('restart nginx', twins)
    expect(resolution.kind).toBe('ambiguous')
  })

  it('does not commit on a weak match', () => {
    expect(resolveRunbookMatch('rsnx', runbooks).kind).not.toBe('match')
    expect(resolveRunbookMatch('database backup', runbooks)).toEqual({ kind: 'none' })
  })
})

describe('matching by meaning', () => {
  it('ignores word endings', () => {
    expect(scoreRunbookMatch('restarting nginx', runbooks[0])).toBeGreaterThanOrEqual(RUNBOOK_MATCH_TIER.allWordsInTitle)
    expect(scoreRunbookMatch('certificates expiring', runbooks[2])).toBeGreaterThan(0)
  })

  it('finds a runbook by an operations synonym', () => {
    expect(rankRunbooks('reboot nginx', runbooks)[0]?.runbook.id).toBe('nginx')
    expect(rankRunbooks('storage pressure', runbooks)[0]?.runbook.id).toBe('disk')
    expect(rankRunbooks('ssl cert expiry', runbooks)[0]?.runbook.id).toBe('tls')
  })

  it('can be turned off for spelling-only scoring', () => {
    expect(scoreRunbookMatch('reboot nginx', runbooks[0], { meanings: false })).toBe(0)
  })

  it('offers a meaning-only match as a candidate instead of choosing it to run', () => {
    const resolution = resolveRunbookMatch('reboot nginx', runbooks)
    expect(resolution.kind).toBe('ambiguous')
    expect(resolution.kind === 'ambiguous' ? resolution.candidates[0]?.id : null).toBe('nginx')
  })

  it('still runs a runbook named by spelling with a different ending', () => {
    const resolution = resolveRunbookMatch('restart nginx', runbooks)
    expect(resolution.kind === 'match' ? resolution.runbook.id : null).toBe('nginx')
  })
})
