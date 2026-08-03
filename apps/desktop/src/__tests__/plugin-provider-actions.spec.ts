import { describe, expect, it } from 'vitest'

import { resolveErrorSourceProviderActionId } from '@bitsentry-ce/core/features/error-sources/desktop-plugin-error-source-actions'
import {
  DesktopPluginRuntimeService,
  type DesktopPluginDescriptor,
} from '@bitsentry-ce/core/features/plugins'

class TestPluginRuntimeService extends DesktopPluginRuntimeService {
  constructor(private readonly descriptors: DesktopPluginDescriptor[]) {
    super()
  }

  override listPlugins(): DesktopPluginDescriptor[] {
    return this.descriptors
  }

  override getPlugin(pluginId: string): DesktopPluginDescriptor | null {
    return this.descriptors.find((plugin) => plugin.id === pluginId) ?? null
  }
}

function createPluginDescriptor(
  overrides: Partial<DesktopPluginDescriptor> = {},
): DesktopPluginDescriptor {
  return {
    id: 'posthog',
    name: 'PostHog',
    version: '1.0.0',
    description: 'Code plugin descriptor for PostHog.',
    type: "data_source",
    metadata: {
      dataSource: {
        sourceType: 'posthog',
        setupFields: [],
      },
    },
    auth: {
      fields: [],
    },
    actions: [],
    ...overrides,
  }
}

function createProviderAction(
  id: string,
): DesktopPluginDescriptor['actions'][number] {
  return {
    id,
    title: id,
    description: `${id} action.`,
    riskLevel: 'read',
    fields: [],
  }
}

describe('plugin error source provider actions', () => {
  it('resolves conventional code action IDs without provider metadata', () => {
    const runtime = new TestPluginRuntimeService([
      createPluginDescriptor({
        actions: [createProviderAction('queryIssues')],
      }),
    ])

    expect(
      resolveErrorSourceProviderActionId({
        runtime,
        pluginId: 'posthog',
        sourceType: 'posthog',
        action: 'queryIssues',
      }),
    ).toBe('queryIssues')
  })

  it('resolves snake_case code action IDs', () => {
    const runtime = new TestPluginRuntimeService([
      createPluginDescriptor({
        actions: [createProviderAction('query_issues')],
      }),
    ])

    expect(
      resolveErrorSourceProviderActionId({
        runtime,
        pluginId: 'posthog',
        sourceType: 'posthog',
        action: 'queryIssues',
      }),
    ).toBe('query_issues')
  })

  it('resolves first-party source provider action IDs from code plugin metadata', () => {
    const runtime = new TestPluginRuntimeService([
      createPluginDescriptor({
        id: 'github',
        name: 'GitHub',
        metadata: {
          dataSource: {
            sourceType: 'github',
            setupFields: [],
          },
        },
        actions: [
          createProviderAction('list_organizations'),
          createProviderAction('list_projects'),
        ],
      }),
    ])
    const listOrganizationsActionId = resolveErrorSourceProviderActionId({
      runtime,
      pluginId: 'github',
      sourceType: 'github',
      action: 'listOrganizations',
    })
    const listProjectsActionId = resolveErrorSourceProviderActionId({
      runtime,
      pluginId: 'github',
      sourceType: 'github',
      action: 'listProjects',
    })

    expect(listOrganizationsActionId).toBe('list_organizations')
    expect(listProjectsActionId).toBe('list_projects')
  })
})
