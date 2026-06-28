import type { ErrorSourceType } from './desktop-error-sources.types'
import type { ErrorSourceProvider } from './desktop-error-source-provider.interface'
import {
  PluginBackedErrorSourceProviderAdapter,
  type ErrorSourceOauthDelegateFactory,
} from './desktop-plugin-backed-error-source-provider.adapter'
import { SentryProviderAdapter } from './desktop-sentry-provider.adapter'
import { PostHogProviderAdapter } from './desktop-posthog-provider.adapter'
import type { DesktopPluginDescriptor } from '../plugins/plugins.types'
import type { DesktopPluginRuntimeService } from '../plugins/desktop-plugin-registry'
import { createDesktopNodePluginRuntimeService } from '../plugins/desktop-plugin-runtime.node'

const ISSUE_PROVIDER_ACTIONS = [
  'listOrganizations',
  'listProjects',
  'getProject',
  'queryIssues',
  'listIssues',
  'listIssueEvents',
] as const

export class ErrorSourceProviderFactory {
  private readonly providers = new Map<ErrorSourceType, ErrorSourceProvider>()

  constructor(pluginRuntime?: DesktopPluginRuntimeService) {
    this.runtime = pluginRuntime ?? createDesktopNodePluginRuntimeService()
    this.registerRuntimePlugins()
  }

  private readonly runtime: DesktopPluginRuntimeService

  getProvider(sourceType: ErrorSourceType): ErrorSourceProvider {
    const provider = this.providers.get(sourceType)
    if (provider === undefined) {
      throw new Error(`Unsupported error source type: ${sourceType}`)
    }
    return provider
  }

  getProviderForSource(source: {
    sourceType: ErrorSourceType
    additionalMetadata?: unknown
  }): ErrorSourceProvider {
    const pluginId = this.readPluginId(source.additionalMetadata) ?? source.sourceType

    if (this.hasProviderPlugin(pluginId, source.sourceType)) {
      return this.createProvider(pluginId, source.sourceType)
    }

    return this.getProvider(source.sourceType)
  }

  getPlugin(pluginId: string): DesktopPluginDescriptor | null {
    return this.runtime.getPlugin(pluginId)
  }

  private registerRuntimePlugins(): void {
    for (const plugin of this.runtime.listPlugins()) {
      const sourceType = plugin.metadata?.errorSource?.sourceType
      if (sourceType === undefined || sourceType.trim().length === 0) {
        continue
      }

      if (!this.hasIssueProviderActions(plugin)) {
        continue
      }

      if (this.providers.has(sourceType) && plugin.id !== sourceType) {
        continue
      }

      this.providers.set(sourceType, this.createProvider(plugin.id, sourceType))
    }
  }

  private hasProviderPlugin(pluginId: string, sourceType: ErrorSourceType): boolean {
    const plugin = this.runtime.getPlugin(pluginId)
    if (plugin?.metadata?.errorSource?.sourceType !== sourceType) {
      return false
    }

    return this.hasIssueProviderActions(plugin)
  }

  private hasIssueProviderActions(plugin: DesktopPluginDescriptor): boolean {
    const sourceType = plugin.metadata?.errorSource?.sourceType
    if (sourceType === 'sentry' || sourceType === 'posthog') {
      return true
    }

    const providerActions = plugin.metadata?.errorSource?.providerActions
    if (providerActions === undefined) {
      return false
    }

    for (const action of ISSUE_PROVIDER_ACTIONS) {
      if (providerActions[action] !== undefined) {
        return true
      }
    }

    return false
  }

  private createProvider(
    pluginId: string,
    sourceType: ErrorSourceType,
  ): ErrorSourceProvider {
    return new PluginBackedErrorSourceProviderAdapter({
      runtime: this.runtime,
      pluginId,
      sourceType,
      createOauthDelegate: this.createOauthDelegate(sourceType),
    })
  }

  private createOauthDelegate(
    sourceType: ErrorSourceType,
  ): ErrorSourceOauthDelegateFactory | undefined {
    if (sourceType === 'sentry') {
      return () => new SentryProviderAdapter()
    }

    if (sourceType === 'posthog') {
      return ({ baseUrl }) => new PostHogProviderAdapter({ apiBase: baseUrl })
    }

    return undefined
  }

  private readPluginId(additionalMetadata: unknown): string | undefined {
    if (
      additionalMetadata === null ||
      additionalMetadata === undefined ||
      typeof additionalMetadata !== 'object' ||
      Array.isArray(additionalMetadata)
    ) {
      return undefined
    }

    const pluginId = (additionalMetadata as { pluginId?: unknown }).pluginId
    if (typeof pluginId !== 'string') {
      return undefined
    }

    const normalized = pluginId.trim()
    if (normalized.length === 0) {
      return undefined
    }

    return normalized
  }
}
