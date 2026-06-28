import path from 'path'

import {
  ErrorSourceProviderFactory,
  getProviderForSource,
} from '@bitsentry-ce/core/features/error-sources'
import { createDesktopNodePluginRuntimeService } from '@bitsentry-ce/core/features/plugins/node'
import { afterEach, describe, expect, it, vi } from 'vitest'

type PostHogIssuePage = {
  issues?: Array<{
    id?: string
    title?: string
    projectIdentifier?: string
    environment?: string
  }>
  hasMore?: boolean
}

describe('PostHog code plugin', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('loads from the repo-managed plugin directory and queries issues through HogQL', async () => {
    const pluginDirectory = path.resolve(process.cwd(), '../../packages/plugins')
    const runtime = createDesktopNodePluginRuntimeService([pluginDirectory])
    const descriptor = runtime.getPlugin('posthog')

    expect(descriptor).toMatchObject({
      id: 'posthog',
      metadata: {
        errorSource: {
          sourceType: 'posthog',
          providerActions: {
            queryIssues: 'query_issues',
            listIssueEvents: 'list_issue_events',
          },
        },
      },
    })

    const fetchMock = vi.fn<(url: string, request?: RequestInit) => Promise<Response>>().mockResolvedValue(
      new Response(
        JSON.stringify({
          columns: [
            'fingerprint',
            'message',
            'exception_type',
            'level',
            'lib',
            'environment',
            'event_count',
            'user_count',
            'first_seen',
            'last_seen',
            'exception_list',
            'project_id',
          ],
          results: [
            [
              'fp-1',
              'SMTP 550 mailbox full',
              'EmailDeliveryError',
              'error',
              'python',
              'prod',
              19,
              16,
              '2026-05-12T04:31:56.740Z',
              '2026-05-12T04:55:40.560Z',
              null,
              '177710',
            ],
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const provider = getProviderForSource(new ErrorSourceProviderFactory(runtime), {
      sourceType: 'posthog',
      configuration: {
        posthogBaseUrl: 'https://eu.posthog.com',
      },
    })
    const page = await provider.queryIssues({
      accessToken: 'phx-token',
      orgSlug: 'org-1',
      projectIds: ['177710'],
      query: '`mailbox`',
      limit: 2,
    })

    expect(page).toMatchObject({
      hasMore: false,
      issues: [
        {
          id: '177710:fp-1',
          title: 'EmailDeliveryError: SMTP 550 mailbox full',
          projectIdentifier: '177710',
          environment: 'prod',
        },
      ],
    } satisfies PostHogIssuePage)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const firstCall = fetchMock.mock.calls[0]
    if (firstCall === undefined) {
      throw new Error('Expected PostHog plugin to call fetch')
    }

    const [url, request] = firstCall
    expect(url).toBe('https://eu.posthog.com/api/projects/177710/query/')
    expect(request?.method).toBe('POST')
    expect(request?.headers).toMatchObject({
      Authorization: 'Bearer phx-token',
      'Content-Type': 'application/json',
    })

    if (typeof request?.body !== 'string') {
      throw new Error('Expected PostHog plugin to send a JSON request body')
    }

    const body = JSON.parse(request.body) as {
      query?: { kind?: string; query?: string }
    }
    expect(body.query).toMatchObject({ kind: 'HogQLQuery' })
    expect(body.query?.query).toContain(
      "properties.$exception_message ILIKE '%mailbox%'",
    )
    expect(body.query?.query).toContain('LIMIT 3')
  })
})
