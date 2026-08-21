import catalogJson from './model-catalog.json'
import { isChatCompletionModelId } from '../../shared/model-capabilities'

export type ModelCatalogProviderKey = 'groq' | 'kilocode' | 'openai' | 'anthropic' | 'gemini' | 'openrouter' | 'claude_code' | 'codex' | 'opencode' | 'cursor'
export type ModelThinkingMode = 'unsupported' | 'toggle' | 'always_on'
export type ModelReasoningOption = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

/** Provider type: 'api' for cloud LLMs, 'cli' for local CLI agents */
export type ProviderType = 'api' | 'cli'

export const DESKTOP_ENABLED_API_PROVIDERS_ENV = 'BITSENTRY_ENABLED_API_PROVIDERS'
export const DEFAULT_DESKTOP_ENABLED_API_PROVIDERS = ['openai'] as const

const API_PROVIDER_KEYS = new Set<ModelCatalogProviderKey>([
  'groq',
  'kilocode',
  'openai',
  'anthropic',
  'gemini',
  'openrouter',
])

function getDesktopEnabledApiProvidersFlag(): string | undefined {
  return typeof process === 'undefined'
    ? undefined
    : process.env.BITSENTRY_ENABLED_API_PROVIDERS
}

export function isApiProviderEnabled(
  providerKey: ModelCatalogProviderKey,
  rawValue: string | undefined = getDesktopEnabledApiProvidersFlag(),
): boolean {
  if (!API_PROVIDER_KEYS.has(providerKey)) return true

  const configured = (rawValue ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value): value is ModelCatalogProviderKey =>
      API_PROVIDER_KEYS.has(value as ModelCatalogProviderKey),
    )

  const enabled: readonly ModelCatalogProviderKey[] = configured.length === 0
    ? DEFAULT_DESKTOP_ENABLED_API_PROVIDERS
    : [...new Set(configured)]
  return enabled.includes(providerKey)
}

// ---------------------------------------------------------------------------
// Composer option descriptors (per-model toolbar capability declarations)
// ---------------------------------------------------------------------------

export interface ComposerSelectChoice {
  value: string
  label: string
  /** Short label used in the toolbar summary (e.g. "High" for "High (default)") */
  shortLabel?: string
  isDefault?: boolean
}

export interface ComposerSelectOption {
  id: string
  label: string
  type: 'select'
  options: ComposerSelectChoice[]
}

export interface ComposerBooleanOption {
  id: string
  label: string
  type: 'boolean'
  defaultValue?: boolean
  /** Short label shown in toolbar summary when option is active (e.g. "Fast") */
  shortLabel?: string
}

export type ComposerOptionDescriptor = ComposerSelectOption | ComposerBooleanOption

// ---------------------------------------------------------------------------
// Catalog entry types
// ---------------------------------------------------------------------------

export interface ModelCatalogEntry {
  id: string
  displayName: string
  /** User-facing aliases accepted by Incident runbook authoring. */
  aliases?: string[]
  /** Runtime model identifier used by the provider for named variants. */
  runtimeModelId?: string
  /** Provider traits implied by this catalog entry at execution time. */
  runtimeTraitValues?: Record<string, string | boolean>
  supportsImageInput: boolean
  supportsAudioInput: boolean
  supportsVideoInput: boolean
  supportsPdfInput: boolean
  supportsThinking: boolean
  thinkingMode: ModelThinkingMode
  /** Whether the provider accepts sampling controls such as temperature. */
  supportsSamplingParameters?: boolean
  /** Maximum context window reported by the provider, in tokens. */
  contextWindowTokens?: number
  /** Maximum generated output reported by the provider, in tokens. */
  maxOutputTokens?: number
  reasoningOptions: ModelReasoningOption[]
  /** Deliberate default used when composer options are derived from reasoningOptions. */
  defaultReasoningOption?: ModelReasoningOption
  /**
   * Composer toolbar option descriptors. When present, the toolbar renders
   * controls for each descriptor (effort selector, context window, fast mode,
   * thinking toggle, etc.). When absent, the toolbar falls back to deriving
   * controls from `reasoningOptions` and `thinkingMode`.
   *
 * CLI provider models (claude_code, codex, opencode, cursor) should always have this set.
   * Cloud LLM models may omit it and rely on the fallback derivation.
   */
  composerOptions?: ComposerOptionDescriptor[]
}

export interface ProviderModelCatalogEntry {
  providerKey: ModelCatalogProviderKey
  displayName: string
  models: ModelCatalogEntry[]
  /** Provider type: 'api' for cloud LLMs, 'cli' for local CLI agents. Defaults to 'api'. */
  providerType?: ProviderType
  /** Whether this provider supports Plan mode in the interaction mode toggle. */
  supportsPlanMode?: boolean
}

interface ModelCatalogJson {
  providers: ProviderModelCatalogEntry[]
}

const catalog = catalogJson as ModelCatalogJson

const providerCatalogByKey = new Map(
  catalog.providers.map((provider): readonly [ModelCatalogProviderKey, ProviderModelCatalogEntry] => [
    provider.providerKey,
    provider,
  ]),
)

const normalizeValue = (value: string): string => value.trim().toLowerCase()

const slugModelText = (value: string): string =>
  normalizeValue(value).replace(/\s+/g, '-')

const modelIdMatchKey = (modelId: string): string =>
  /[/.]/.test(modelId) ? normalizeValue(modelId) : slugModelText(modelId)

export interface ResolvedCatalogModel {
  providerKey: ModelCatalogProviderKey
  modelId: string
}

function resolveCatalogModelInProvider(
  provider: ProviderModelCatalogEntry,
  value: string,
): ResolvedCatalogModel | undefined {
  const normalizedValue = normalizeValue(value)
  const sluggedValue = slugModelText(value)
  const exactIdMatch = provider.models.find(
    (model) => normalizeValue(model.id) === normalizedValue,
  )
  const sluggedIdMatch = provider.models.find(
    (model) => modelIdMatchKey(model.id) === sluggedValue,
  )
  const displayNameMatch = provider.models.find(
    (model) => slugModelText(model.displayName) === sluggedValue,
  )
  const aliasMatch = provider.models.find((model) =>
    model.aliases?.some((alias) => slugModelText(alias) === sluggedValue),
  )
  const model = exactIdMatch ?? sluggedIdMatch ?? aliasMatch ?? displayNameMatch
  return model === undefined
    ? undefined
    : { providerKey: provider.providerKey, modelId: model.id }
}

export function resolveCatalogModelForProvider(
  providerKey: ModelCatalogProviderKey,
  value: string | null | undefined,
): ResolvedCatalogModel | undefined {
  if (value === null || value === undefined || value.trim().length === 0) {
    return undefined
  }
  const provider = getProviderModelCatalog(providerKey)
  return provider === undefined ? undefined : resolveCatalogModelInProvider(provider, value)
}

/**
 * Resolve user-facing model text to the provider-facing catalog ID.
 *
 * Matching is deliberately ordered: canonical IDs first, then slugged IDs,
 * aliases, and display names. Provider order is the catalog order, so native
 * Anthropic aliases win before duplicate CLI display names such as OpenCode.
 */
export function resolveCatalogModel(
  value: string | null | undefined,
): ResolvedCatalogModel | undefined {
  if (value === null || value === undefined || value.trim().length === 0) {
    return undefined
  }

  const normalizedValue = normalizeValue(value)
  const sluggedValue = slugModelText(value)
  const findMatch = (
    predicate: (model: ModelCatalogEntry) => boolean,
  ): ResolvedCatalogModel | undefined => {
    for (const provider of catalog.providers) {
      const model = provider.models.find(predicate)
      if (model !== undefined) {
        return { providerKey: provider.providerKey, modelId: model.id }
      }
    }
    return undefined
  }
  const aliasMatch = findMatch((model) =>
    model.aliases?.some((alias) => slugModelText(alias) === sluggedValue) === true,
  )

  return findMatch((model) => normalizeValue(model.id) === normalizedValue)
    ?? aliasMatch
    ?? findMatch((model) => modelIdMatchKey(model.id) === sluggedValue)
    ?? findMatch((model) => slugModelText(model.displayName) === sluggedValue)
}
const HIDDEN_MODEL_IDS_BY_PROVIDER: Partial<Record<
  ModelCatalogProviderKey,
  ReadonlySet<string>
>> = {
  // These IDs are rejected by Codex when authenticated with a ChatGPT account.
  // Keep the raw catalog data for migration/display compatibility, but never
  // offer them as selectable models.
  codex: new Set(['gpt-5.2-codex', 'gpt-5.1-codex-mini']),
  // Confirmed stale by product decision. Keep live discovery from re-adding
  // these IDs after they are removed from the static catalog.
  gemini: new Set([
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.5-computer-use-preview-10-2025',
  ]),
}
const LEGACY_CATALOG_MODEL_ID_ALIASES: Partial<Record<
  ModelCatalogProviderKey,
  Readonly<Record<string, string>>
>> = {
  // Cursor ACP uses `auto`; older Desktop CE settings stored this as `default`.
  cursor: { default: 'auto' },
  opencode: {
    'openai/gpt-5.5-fast': 'openai/gpt-5.5',
    'openai/gpt-5.4-fast': 'openai/gpt-5.4',
    'openai/gpt-5.4-mini-fast': 'openai/gpt-5.4-mini',
    'anthropic/claude-opus-4-8-fast': 'anthropic/claude-opus-4-8',
  },
}

function resolveLegacyCatalogModelId(
  providerKey: ModelCatalogProviderKey,
  modelId: string,
): string {
  const normalizedModelId = normalizeValue(modelId)
  return LEGACY_CATALOG_MODEL_ID_ALIASES[providerKey]?.[normalizedModelId]
    ?? normalizedModelId
}

const CONTEXT_WINDOW_OPTION_ID = 'contextWindow'
const MODEL_CONTEXT_WINDOW_LIMIT_FALLBACKS: Readonly<Record<string, number>> = {
  // Official OpenAI model docs show 1M for gpt-5.4 and 400K for gpt-5.4-mini.
  // GPT-5.2 docs also show 400K, so use that fallback when the app-server
  // omits the live `modelContextWindow` field.
  'gpt-5.4': 1_000_000,
  'gpt-5.4-mini': 400_000,
  'gpt-5.3-codex': 400_000,
  'gpt-5.3-codex-spark': 400_000,
  'gpt-5.2': 400_000,
}
const CLI_FALLBACK_EFFORT_OPTIONS: Partial<
  Record<ModelCatalogProviderKey, ComposerSelectOption>
> = {
  claude_code: {
    id: 'effort',
    label: 'common.traitsDropdown.reasoning',
    type: 'select',
    options: [
      { value: 'low', label: 'common.traitsDropdown.reasoningLow' },
      { value: 'medium', label: 'common.traitsDropdown.reasoningMedium' },
      { value: 'high', label: 'common.traitsDropdown.reasoningHigh', isDefault: true },
      {
        value: 'xhigh',
        label: 'common.traitsDropdown.reasoningExtraHigh',
        shortLabel: 'common.traitsDropdown.reasoningExtraHighShort',
      },
      { value: 'max', label: 'common.traitsDropdown.reasoningMax' },
      {
        value: 'ultrathink',
        label: 'common.traitsDropdown.reasoningUltrathink',
        shortLabel: 'common.traitsDropdown.reasoningUltrathinkShort',
      },
    ],
  },
  codex: {
    id: 'effort',
    label: 'common.traitsDropdown.reasoning',
    type: 'select',
    options: [
      { value: 'low', label: 'common.traitsDropdown.reasoningLow' },
      { value: 'medium', label: 'common.traitsDropdown.reasoningMedium' },
      { value: 'high', label: 'common.traitsDropdown.reasoningHigh', isDefault: true },
      {
        value: 'xhigh',
        label: 'common.traitsDropdown.reasoningExtraHigh',
        shortLabel: 'common.traitsDropdown.reasoningExtraHighShort',
      },
    ],
  },
  opencode: {
    id: 'effort',
    label: 'common.traitsDropdown.reasoning',
    type: 'select',
    options: [
      { value: 'low', label: 'common.traitsDropdown.reasoningLow' },
      { value: 'medium', label: 'common.traitsDropdown.reasoningMedium', isDefault: true },
      { value: 'high', label: 'common.traitsDropdown.reasoningHigh' },
    ],
  },
  cursor: {
    id: 'effort',
    label: 'common.traitsDropdown.reasoning',
    type: 'select',
    options: [
      { value: 'low', label: 'common.traitsDropdown.reasoningLow' },
      { value: 'medium', label: 'common.traitsDropdown.reasoningMedium' },
      { value: 'high', label: 'common.traitsDropdown.reasoningHigh', isDefault: true },
    ],
  },
}

export function filterSelectableModelIds(
  providerKey: ModelCatalogProviderKey,
  modelIds: string[],
): string[] {
  const hiddenModelIds = HIDDEN_MODEL_IDS_BY_PROVIDER[providerKey]
  const seen = new Set<string>()
  const filtered: string[] = []

  for (const modelId of modelIds) {
    const normalizedModelId = normalizeValue(modelId)
    const resolvedModelId = resolveLegacyCatalogModelId(providerKey, modelId)
    if (
      !isChatCompletionModelId(modelId) ||
      resolvedModelId.length === 0 ||
      hiddenModelIds?.has(resolvedModelId) === true ||
      seen.has(resolvedModelId)
    ) {
      continue
    }

    seen.add(resolvedModelId)
    filtered.push(resolvedModelId === normalizedModelId ? modelId : resolvedModelId)
  }

  return filtered
}

export function getModelCatalogProviders(
  enabledApiProviders?: string,
): ProviderModelCatalogEntry[] {
  return catalog.providers.filter((provider) =>
    isApiProviderEnabled(provider.providerKey, enabledApiProviders),
  )
}

export function getProviderModelCatalog(
  providerKey: ModelCatalogProviderKey,
): ProviderModelCatalogEntry | undefined {
  return providerCatalogByKey.get(providerKey)
}

export function getProviderCatalogModels(
  providerKey: ModelCatalogProviderKey,
): ModelCatalogEntry[] {
  return getProviderModelCatalog(providerKey)?.models ?? []
}

export function getCatalogModel(
  providerKey: ModelCatalogProviderKey,
  modelId: string | null | undefined,
): ModelCatalogEntry | undefined {
  if (modelId === null || modelId === undefined || modelId.length === 0) return undefined
  const normalizedModelId = resolveLegacyCatalogModelId(providerKey, modelId)
  const catalogModels = getProviderCatalogModels(providerKey)
  const exactMatch = catalogModels.find(
    (model) => normalizeValue(model.id) === normalizedModelId,
  )
  if (exactMatch !== undefined) return exactMatch
  const undatedModelId = normalizedModelId.replace(/-\d{8}$/, '')
  if (undatedModelId === normalizedModelId) return undefined
  return catalogModels.find((model) => normalizeValue(model.id) === undatedModelId)
}

function getAnthropicFallbackCapability(modelId: string): ModelCatalogEntry | undefined {
  const sourceModel = getProviderCatalogModels('anthropic').find((model) =>
    getEffectiveComposerOptions(model).some(
      (option) => option.id === "effort" && option.type === "select",
    ),
  )
  if (sourceModel === undefined) return undefined

  const effortOption = getEffectiveComposerOptions(sourceModel).find(
    (option): option is ComposerSelectOption =>
      option.id === "effort" && option.type === "select",
  )
  if (effortOption === undefined) return undefined

  return {
    id: modelId,
    displayName: formatModelDisplayName(modelId),
    supportsImageInput: false,
    supportsAudioInput: false,
    supportsVideoInput: false,
    supportsPdfInput: false,
    supportsThinking: sourceModel.supportsThinking,
    thinkingMode: sourceModel.thinkingMode,
    reasoningOptions: [],
    composerOptions: [{
      ...effortOption,
      options: effortOption.options.map((option) => ({ ...option })),
    }],
  }
}

/**
 * Resolve the composer capability for a selected model. Discovery is
 * authoritative for model existence, while catalog entries remain
 * authoritative for model-specific traits.
 */
export function getModelCapability(
  providerKey: ModelCatalogProviderKey,
  modelId: string | null | undefined,
): ModelCatalogEntry | undefined {
  const catalogModel = getCatalogModel(providerKey, modelId)
  if (catalogModel !== undefined) return catalogModel
  if (modelId === null || modelId === undefined || modelId.length === 0) return undefined
  if (providerKey === "anthropic") return getAnthropicFallbackCapability(modelId)
  if (!isCliProvider(providerKey)) return undefined

  const effortOption = CLI_FALLBACK_EFFORT_OPTIONS[providerKey]
  if (effortOption === undefined) return undefined

  return {
    id: modelId,
    displayName: formatModelDisplayName(modelId),
    supportsImageInput: false,
    supportsAudioInput: false,
    supportsVideoInput: false,
    supportsPdfInput: false,
    supportsThinking: false,
    thinkingMode: 'unsupported',
    reasoningOptions: [],
    composerOptions: [{
      ...effortOption,
      options: effortOption.options.map((option) => ({ ...option })),
    }],
  }
}

export function resolveCatalogModelId(
  providerKey: ModelCatalogProviderKey,
  modelId: string | null | undefined,
): string | null {
  return getCatalogModel(providerKey, modelId)?.id ?? null
}

export function getCatalogModelIds(
  providerKey: ModelCatalogProviderKey,
): string[] {
  return filterSelectableModelIds(
    providerKey,
    getProviderCatalogModels(providerKey).map((model) => model.id),
  )
}

export interface CatalogModelRuntimeSelection {
  modelId: string | undefined
  traitValues: Record<string, string | boolean>
}

const LEGACY_RUNTIME_SELECTIONS: Partial<Record<
  ModelCatalogProviderKey,
  Record<string, CatalogModelRuntimeSelection>
>> = {
  claude_code: {
    // Keep existing saved sessions runnable without exposing the old variant
    // as a selectable catalog model.
    'claude-opus-4-8-fast': {
      modelId: 'claude-opus-4-8',
      traitValues: { fastMode: true },
    },
  },
  cursor: {
    default: {
      modelId: 'auto',
      traitValues: {},
    },
  },
}

/**
 * Resolve a UI catalog selection into the provider-facing model and traits.
 * Explicit runtime traits override catalog defaults so user controls remain
 * authoritative without changing the saved model selection.
 */
export function resolveCatalogModelRuntimeSelection(
  providerKey: ModelCatalogProviderKey,
  modelId: string | undefined,
  traitValues: Record<string, string | boolean> = {},
): CatalogModelRuntimeSelection {
  const model = getCatalogModel(providerKey, modelId)
  const legacySelection = modelId === undefined
    ? undefined
    : LEGACY_RUNTIME_SELECTIONS[providerKey]?.[modelId]
  return {
    modelId: model?.runtimeModelId ?? legacySelection?.modelId ?? modelId,
    traitValues: {
      ...(model?.runtimeTraitValues ?? {}),
      ...(legacySelection?.traitValues ?? {}),
      ...traitValues,
    },
  }
}

export function filterChatModelIds(
  providerKey: ModelCatalogProviderKey,
  modelIds: string[],
): string[] {
  const seen = new Set<string>()
  const filtered: string[] = []

  for (const modelId of modelIds) {
    const resolved = resolveCatalogModelId(providerKey, modelId)
    if (resolved === null || seen.has(resolved)) continue
    seen.add(resolved)
    filtered.push(resolved)
  }

  return filtered
}

/**
 * Returns the effective composer option descriptors for a model.
 *
 * If the model has explicit `composerOptions`, returns those directly.
 * Otherwise, derives options from the legacy `reasoningOptions` and
 * `thinkingMode` fields so that cloud LLM models don't need to duplicate
 * their capability declarations.
 */
export function getEffectiveComposerOptions(model: ModelCatalogEntry): ComposerOptionDescriptor[] {
  if (model.composerOptions !== undefined) {
    return model.composerOptions
  }

  const options: ComposerOptionDescriptor[] = []

  // Derive effort selector from reasoningOptions
  if (model.reasoningOptions.length > 0) {
    const REASONING_LABELS: Record<string, string> = {
      none: 'common.traitsDropdown.reasoningNone',
      minimal: 'common.traitsDropdown.reasoningMinimal',
      low: 'common.traitsDropdown.reasoningLow',
      medium: 'common.traitsDropdown.reasoningMedium',
      high: 'common.traitsDropdown.reasoningHigh',
      xhigh: 'common.traitsDropdown.reasoningExtraHigh',
    }

    options.push({
      id: 'effort',
      label: 'common.traitsDropdown.reasoning',
      type: 'select',
      options: model.reasoningOptions.map((opt) => ({
        value: opt,
        label: REASONING_LABELS[opt] ?? opt,
        isDefault: opt === model.defaultReasoningOption,
      })),
    })
  } else if (model.supportsThinking && model.thinkingMode === 'toggle') {
    // Model has thinking but no granular effort levels -- show simple toggle
    options.push({
      id: 'thinking',
      label: 'common.traitsDropdown.thinking',
      type: 'boolean',
      defaultValue: false,
    })
  }
  // Models with thinkingMode 'always_on' don't get a toggle (it's always on)

  return options
}

export function getComposerDefaultTraitValues(
  model: ModelCatalogEntry | undefined,
): Record<string, string | boolean> {
  if (model === undefined) return {}

  const defaults: Record<string, string | boolean> = {}
  for (const option of getEffectiveComposerOptions(model)) {
    if (option.type === 'select') {
      const defaultChoice = option.options.find((choice) => choice.isDefault === true)
      if (defaultChoice !== undefined) defaults[option.id] = defaultChoice.value
    } else if (option.defaultValue !== undefined) {
      defaults[option.id] = option.defaultValue
    }
  }

  return defaults
}

function parseCompactTokenLimit(value: string): number | undefined {
  const normalized = value.trim().toLowerCase()
  const match = normalized.match(/^(\d+(?:\.\d+)?)([km])$/)
  if (match === null) return undefined

  const amount = Number.parseFloat(match[1])
  if (!Number.isFinite(amount)) return undefined

  if (match[2] === 'k') {
    return Math.round(amount * 1_000)
  }

  return Math.round(amount * 1_000_000)
}

function getFallbackModelContextWindowLimit(
  model: ModelCatalogEntry | undefined,
): number | undefined {
  if (model === undefined) return undefined
  return MODEL_CONTEXT_WINDOW_LIMIT_FALLBACKS[normalizeValue(model.id)]
}

export function getModelContextWindowLimit(
  model: ModelCatalogEntry | undefined,
  values: Record<string, string | boolean>,
): number | undefined {
  if (model === undefined || model.composerOptions === undefined) {
    return getFallbackModelContextWindowLimit(model)
  }

  const contextOption = model.composerOptions.find(
    (option): option is ComposerSelectOption =>
      option.type === 'select' && option.id === CONTEXT_WINDOW_OPTION_ID,
  )
  if (contextOption === undefined) {
    return getFallbackModelContextWindowLimit(model)
  }

  const explicitValue = values[CONTEXT_WINDOW_OPTION_ID]
  if (typeof explicitValue === 'string') {
    return parseCompactTokenLimit(explicitValue) ?? getFallbackModelContextWindowLimit(model)
  }

  let defaultValue = contextOption.options[0]?.value
  const defaultOption = contextOption.options.find((option) => option.isDefault === true)
  if (defaultOption !== undefined) {
    defaultValue = defaultOption.value
  }

  if (typeof defaultValue !== 'string') {
    return getFallbackModelContextWindowLimit(model)
  }

  return parseCompactTokenLimit(defaultValue) ?? getFallbackModelContextWindowLimit(model)
}

/**
 * Check whether a provider is a CLI provider (local agent) vs cloud API.
 */
export function isCliProvider(providerKey: ModelCatalogProviderKey): boolean {
  return providerKey === 'claude_code' || providerKey === 'codex' || providerKey === 'opencode' || providerKey === 'cursor'
}

/**
 * Get provider type from the catalog entry, defaulting to 'api'.
 */
export function getProviderType(providerKey: ModelCatalogProviderKey): ProviderType {
  const provider = providerCatalogByKey.get(providerKey)
  return provider?.providerType ?? 'api'
}

/**
 * Check whether a provider supports Plan mode.
 */
export function providerSupportsPlanMode(providerKey: ModelCatalogProviderKey): boolean {
  const provider = providerCatalogByKey.get(providerKey)
  return provider?.supportsPlanMode ?? false
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function formatVariant(variant: string | undefined): string {
  if (variant === undefined || variant.length === 0) {
    return ''
  }

  return ` ${variant.split('-').map(titleCase).join(' ')}`
}

function formatVersion(major: string, minor: string | undefined): string {
  if (minor === undefined || minor.length === 0) {
    return major
  }

  return `${major}.${minor}`
}

function withProviderPrefix(
  providerPrefix: string | undefined,
  expectedProvider: string,
  name: string,
  displayProvider: string,
): string {
  if (providerPrefix === expectedProvider) {
    return `${displayProvider} ${name}`
  }

  return name
}

/**
 * Format a raw model ID into a human-readable display name.
 *
 * Used as fallback when a model isn't in the static catalog (e.g., models
 * discovered at runtime by CLI probes). Handles GPT, Claude, and o-series
 * naming conventions.
 *
 * Examples:
 *   "gpt-5.2-codex"            → "GPT-5.2 Codex"
 *   "gpt-5.1-codex-max"        → "GPT-5.1 Codex Max"
 *   "gpt-5.4-mini"             → "GPT-5.4 Mini"
 *   "claude-sonnet-4-20250514" → "Claude Sonnet 4"
 *   "claude-opus-4-7"          → "Claude Opus 4.7"
 *   "claude-haiku-4-5-20251001"→ "Claude Haiku 4.5"
 *   "o3"                       → "o3"
 *   "o4-mini"                  → "o4 Mini"
 */
export function formatModelDisplayName(modelId: string): string {
  // Strip date suffixes (8-digit, e.g. -20250514)
  const withoutDate = modelId.replace(/-\d{8}$/, '')
  const providerMatch = withoutDate.match(/^([^/]+)\/(.+)$/)
  let providerPrefix: string | undefined
  let id = withoutDate
  if (providerMatch !== null) {
    providerPrefix = providerMatch[1].toLowerCase()
    id = providerMatch[2]
  }

  // GPT models: "gpt-5.2-codex" → "GPT-5.2 Codex", "gpt-4o" → "GPT-4o", "gpt-oss-120b" → "GPT-OSS 120B"
  const gptMatch = id.match(/^gpt-(\w+(?:\.\d+)?)(?:-(.+))?$/i)
  if (gptMatch !== null) {
    const version = gptMatch[1]
    const name = `GPT-${version}${formatVariant(gptMatch[2])}`
    return withProviderPrefix(providerPrefix, 'openai', name, 'OpenAI')
  }

  // Claude models: "claude-opus-4-7" → "Claude Opus 4.7", "claude-3-5-haiku" → "Claude 3.5 Haiku"
  const numberedClaudeMatch = id.match(/^claude-(\d+)(?:-(\d+))?-(\w+)(?:-.+)?$/i)
  const namedClaudeMatch = id.match(/^claude-(\w+)-(\d+)(?:-(\d+))?(?:-.+)?$/i)
  if (numberedClaudeMatch !== null) {
    const tier = numberedClaudeMatch[3]
    const versionMajor = numberedClaudeMatch[1]
    const versionMinor = numberedClaudeMatch[2]
    const tierText = titleCase(tier)
    const version = formatVersion(versionMajor, versionMinor)
    const name = `Claude ${version} ${tierText}`
    return withProviderPrefix(providerPrefix, 'anthropic', name, 'Anthropic')
  }
  if (namedClaudeMatch !== null) {
    const tier = namedClaudeMatch[1]
    const versionMajor = namedClaudeMatch[2]
    const versionMinor = namedClaudeMatch[3]
    const tierText = titleCase(tier)
    const version = formatVersion(versionMajor, versionMinor)
    const name = `Claude ${tierText} ${version}`
    return withProviderPrefix(providerPrefix, 'anthropic', name, 'Anthropic')
  }

  // o-series models: "o3" → "o3", "o4-mini" → "o4 Mini"
  const oMatch = id.match(/^(o\d+)(?:-(.+))?$/i)
  if (oMatch !== null) {
    return `${oMatch[1]}${formatVariant(oMatch[2])}`
  }

  // Fallback: capitalize each hyphen-separated part
  const fallbackName = id
    .split('-')
    .map((part) => {
      if (/^\d/.test(part)) return part
      return titleCase(part)
    })
    .join(' ')
  if (providerPrefix !== undefined && providerPrefix !== 'opencode') {
    return `${titleCase(providerPrefix)} ${fallbackName}`
  }

  return fallbackName
}

/**
 * Get the display name for a model, checking the catalog first and falling
 * back to formatting the raw ID.
 */
export function getModelDisplayName(
  providerKey: ModelCatalogProviderKey,
  modelId: string,
): string {
  return getCatalogModel(providerKey, modelId)?.displayName ?? formatModelDisplayName(modelId)
}

export function getCapabilityBadges(model: ModelCatalogEntry): string[] {
  const badges = ['text']
  if (model.supportsImageInput) badges.push('image')
  if (model.supportsAudioInput) badges.push('audio')
  if (model.supportsVideoInput) badges.push('video')
  if (model.supportsPdfInput) badges.push('pdf')
  if (model.supportsThinking) {
    if (model.thinkingMode === 'always_on') {
      badges.push('thinking on')
    } else {
      badges.push('thinking')
    }
  }
  return badges
}
