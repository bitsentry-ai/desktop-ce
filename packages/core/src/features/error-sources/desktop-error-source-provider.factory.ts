import type { ErrorSourceType } from './desktop-error-sources.types'
import type { ErrorSourceProvider } from './desktop-error-source-provider.interface'
import { PluginBackedSentryProviderAdapter } from './desktop-plugin-backed-sentry-provider.adapter'
import { PluginBackedPostHogProviderAdapter } from './desktop-plugin-backed-posthog-provider.adapter'
import type { DesktopPluginManifest } from '../plugins/plugins.types'
import type { DesktopPluginRuntimeService } from '../plugins/desktop-plugin-registry'
import { createDesktopNodePluginRuntimeService } from '../plugins/desktop-plugin-runtime.node'

export class ErrorSourceProviderFactory {
  private readonly providers = new Map<ErrorSourceType, ErrorSourceProvider>()

  constructor(pluginRuntime?: DesktopPluginRuntimeService) {
    this.runtime = pluginRuntime ?? createDesktopNodePluginRuntimeService()

    if (this.hasPlugin('sentry', 'sentry')) {
      const sentry = new PluginBackedSentryProviderAdapter(this.runtime)
      this.providers.set(sentry.sourceType, sentry)
    }

    if (this.hasPlugin('posthog', 'posthog')) {
      const posthog = new PluginBackedPostHogProviderAdapter(this.runtime)
      this.providers.set(posthog.sourceType, posthog)
    }
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

    if (source.sourceType === 'sentry') {
      if (this.hasPlugin(pluginId, source.sourceType)) {
        return new PluginBackedSentryProviderAdapter(this.runtime, pluginId)
      }

      return this.getProvider(source.sourceType)
    }

    if (source.sourceType === 'posthog') {
      if (this.hasPlugin(pluginId, source.sourceType)) {
        return new PluginBackedPostHogProviderAdapter(this.runtime, pluginId)
      }

      return this.getProvider(source.sourceType)
    }

    return this.getProvider(source.sourceType)
  }

  getPlugin(pluginId: string): DesktopPluginManifest | null {
    return this.runtime.getPlugin(pluginId)
  }

  private hasPlugin(pluginId: string, sourceType: ErrorSourceType): boolean {
    const plugin = this.runtime.getPlugin(pluginId)
    return plugin?.metadata?.errorSource?.sourceType === sourceType
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
    return normalized.length > 0 ? normalized : undefined
  }
}
