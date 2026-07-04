import { useState, useEffect, useCallback } from 'react'
import { Button } from '@bitsentry-ce/components/ui/button'
import { Badge } from '@bitsentry-ce/components/ui/badge'
import { useToast } from '@bitsentry-ce/components/hooks/use-toast'
import { useDebouncedAutoSave } from '@bitsentry-ce/components/hooks/useDebouncedAutoSave'
import { getCatalogModelIds, getModelDisplayName } from '@bitsentry-ce/components/llm/modelCatalog'
import { useTranslation } from '@bitsentry-ce/i18n'
import {
  getDesktopApi,
  type DesktopBitsentryApi,
  type DesktopCliProbeResult,
  type DesktopLocalLlmSettings,
} from '../services/desktop-api'

type CaptureDesktopAnalyticsEvent = (
  event: string,
  properties?: Record<string, unknown>,
) => void

type CaptureRendererException = (
  error: unknown,
  context?: Record<string, unknown>,
) => void

type DesktopLlmApi = NonNullable<DesktopBitsentryApi['llm']> & {
  local: NonNullable<NonNullable<DesktopBitsentryApi['llm']>['local']>
  saveProvider: NonNullable<NonNullable<DesktopBitsentryApi['llm']>['saveProvider']>
}

type ProviderSettingsRecord = Record<string, { model?: string }>

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message
  }

  if (typeof error === 'string' && error.trim().length > 0) {
    return error
  }

  return fallback
}

function getDesktopLlmApi(): DesktopLlmApi {
  const desktopApi = getDesktopApi()
  if (
    desktopApi?.llm?.local === undefined ||
    typeof desktopApi.llm.getProviders !== 'function' ||
    typeof desktopApi.llm.saveProvider !== 'function'
  ) {
    throw new Error('Desktop LLM API is unavailable.')
  }

  return desktopApi.llm as DesktopLlmApi
}

interface CodingAgentProviderState {
  enabled: boolean
  binaryPath: string
  model: string
  availableModels: string[]
  codexArgs?: string[]
  opencodeArgs?: string[]
  probe?: DesktopCliProbeResult
  probing: boolean
}

export type ProviderId = 'codex' | 'cursor' | 'claude_code' | 'opencode'
type ProviderStateSetter = React.Dispatch<React.SetStateAction<CodingAgentProviderState>>

interface ProviderMeta {
  id: ProviderId
  displayName: string
  providerSiteUrl: string
  defaultModels: string[]
}

const PROVIDER_META: Record<ProviderId, ProviderMeta> = {
  codex: {
    id: 'codex',
    displayName: 'Codex',
    providerSiteUrl: 'https://openai.com/codex',
    defaultModels: [],
  },
  cursor: {
    id: 'cursor',
    displayName: 'Cursor',
    providerSiteUrl: 'https://cursor.com/docs/cli/acp',
    defaultModels: getCatalogModelIds('cursor'),
  },
  claude_code: {
    id: 'claude_code',
    displayName: 'Claude Code',
    providerSiteUrl: 'https://www.anthropic.com/claude-code',
    defaultModels: getCatalogModelIds('claude_code'),
  },
  opencode: {
    id: 'opencode',
    displayName: 'OpenCode',
    providerSiteUrl: 'https://opencode.ai/docs/cli/',
    defaultModels: getCatalogModelIds('opencode'),
  },
}

const LLM_PROVIDERS_UPDATED_EVENT = 'bitsentry:llm-providers-updated'

function notifyLlmProvidersUpdated(): void {
  window.dispatchEvent(new Event(LLM_PROVIDERS_UPDATED_EVENT))
}

interface CliArgParserState {
  args: string[]
  current: string
  quote: '"' | "'" | null
  escaping: boolean
}

function pushCurrentCliArg(state: CliArgParserState): void {
  if (state.current.length === 0) {
    return
  }

  state.args.push(state.current)
  state.current = ''
}

function consumeQuotedCliArgChar(state: CliArgParserState, char: string): void {
  if (char === state.quote) {
    state.quote = null
    return
  }

  state.current += char
}

function consumeCliArgChar(state: CliArgParserState, char: string): void {
  if (state.escaping) {
    state.current += char
    state.escaping = false
    return
  }

  if (char === '\\' && state.quote !== "'") {
    state.escaping = true
    return
  }

  if (state.quote !== null) {
    consumeQuotedCliArgChar(state, char)
    return
  }

  if (char === '"' || char === "'") {
    state.quote = char
    return
  }

  if (/\s/.test(char)) {
    pushCurrentCliArg(state)
    return
  }

  state.current += char
}

function parseCliArgsLine(input: string): string[] {
  const state: CliArgParserState = {
    args: [],
    current: '',
    quote: null,
    escaping: false,
  }

  for (const char of input) {
    consumeCliArgChar(state, char)
  }

  if (state.escaping) {
    state.current += '\\'
  }
  pushCurrentCliArg(state)
  return state.args
}

function parseCodexArgsInput(value: string): string[] {
  const args: string[] = []

  for (const line of value.split('\n')) {
    const input = line.trim()
    if (input.length === 0) continue

    args.push(...parseCliArgsLine(input))
  }

  return args
}

const parseCliArgsInput = parseCodexArgsInput

function providerBinaryName(provider: ProviderId): string {
  if (provider === 'claude_code') return 'claude'
  if (provider === 'codex') return 'codex'
  if (provider === 'opencode') return 'opencode'
  return 'cursor-agent'
}

function getProbeStatusClass(status: DesktopCliProbeResult['status'] | undefined): string {
  if (status === 'ready') {
    return 'text-[hsl(var(--primary))]'
  }
  if (status === 'warning') {
    return 'text-amber-600 dark:text-amber-400'
  }
  if (status === 'error') {
    return 'text-red-600 dark:text-red-400'
  }

  return 'text-muted-foreground'
}

function mergeModelOption(
  availableModels: string[],
  model: string,
): string[] {
  if (availableModels.includes(model)) {
    return availableModels
  }

  return [model, ...availableModels]
}

function applySavedModel(setter: ProviderStateSetter, model: string): void {
  if (model.length === 0) {
    return
  }

  setter((prev) => ({
    ...prev,
    model,
    availableModels: mergeModelOption(prev.availableModels, model),
  }))
}

function createSettingsPatch(provider: ProviderId, state: CodingAgentProviderState) {
  switch (provider) {
    case 'claude_code':
      return { claudeCode: { enabled: state.enabled, binaryPath: state.binaryPath } }
    case 'codex':
      return {
        codex: {
          enabled: state.enabled,
          binaryPath: state.binaryPath,
          codexArgs: state.codexArgs,
        },
      }
    case 'opencode':
      return {
        opencode: {
          enabled: state.enabled,
          binaryPath: state.binaryPath,
          opencodeArgs: state.opencodeArgs,
        },
      }
    case 'cursor':
      return { cursor: { enabled: state.enabled, binaryPath: state.binaryPath } }
  }
}

interface ProviderPanelProps {
  meta: ProviderMeta
  state: CodingAgentProviderState
  setState: React.Dispatch<React.SetStateAction<CodingAgentProviderState>>
  isPrimary: boolean
  isPrimarySelectionPending: boolean
  onSetPrimary: () => void
  onSave: (state: CodingAgentProviderState) => Promise<void> | void
  onDetect: () => Promise<string | null>
  onProbe: (state: CodingAgentProviderState) => Promise<void> | void
  onSyncModels: () => Promise<number>
  onModelChange: (model: string) => Promise<void> | void
  autosaveBaselineKey: unknown
}

type SyncState = 'idle' | 'syncing' | 'synced' | 'error'

interface ExtraArgsConfig {
  args: string[]
  placeholder: string
}

function getProbeStatusText(
  t: ReturnType<typeof useTranslation>['t'],
  probe: DesktopCliProbeResult | undefined,
): string | null {
  if (probe === undefined) return null
  if (probe.status === 'ready') {
    if (probe.version !== null && probe.version.length > 0) {
      return t('settings.localCliProviders.readyWithVersion', {
        version: probe.version,
      })
    }

    return t('settings.localCliProviders.ready')
  }
  if (probe.status === 'warning') {
    return probe.message ?? t('settings.localCliProviders.warning')
  }

  return probe.message ?? t('settings.localCliProviders.error')
}

function getExtraArgsConfig(
  provider: ProviderId,
  state: CodingAgentProviderState,
): ExtraArgsConfig {
  if (provider === 'codex') {
    return {
      args: state.codexArgs ?? [],
      placeholder: '--profile personal',
    }
  }

  return {
    args: state.opencodeArgs ?? [],
    placeholder: '--pure',
  }
}

function providerSupportsExtraArgs(provider: ProviderId): boolean {
  return provider === 'codex' || provider === 'opencode'
}

function getSyncButtonText(
  t: ReturnType<typeof useTranslation>['t'],
  syncState: SyncState,
): string {
  if (syncState === 'syncing') {
    return t('common.lLMProviderSettingsPanel.syncing')
  }

  return t('common.lLMProviderSettingsPanel.syncModels')
}

function getSyncMessageClass(syncState: SyncState): string {
  if (syncState === 'error') {
    return 'mt-1 text-[11px] text-[hsl(var(--destructive))]'
  }

  return 'mt-1 text-[11px] text-muted-foreground'
}

function getDetectButtonText(
  t: ReturnType<typeof useTranslation>['t'],
  probing: boolean,
): string {
  if (probing) {
    return t('settings.localCliProviders.testing')
  }

  return t('settings.localCliProviders.detectAndTest')
}

interface ProviderPanelHeaderProps {
  meta: ProviderMeta
  expanded: boolean
  isPrimary: boolean
  onToggle: () => void
}

function ProviderPanelHeader({
  meta,
  expanded,
  isPrimary,
  onToggle,
}: ProviderPanelHeaderProps) {
  const { t } = useTranslation()
  let chevronClass = 'h-4 w-4 text-muted-foreground shrink-0 transition-transform'
  if (expanded) {
    chevronClass = `${chevronClass} rotate-180`
  }

  return (
    <button
      type="button"
      onClick={onToggle}
      className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-accent/50 transition-colors"
    >
      <span className="text-sm font-medium text-foreground truncate">{meta.displayName}</span>
      {isPrimary && (
        <Badge variant="accent">
          {t('common.lLMProviderSettingsPanel.primary')}
        </Badge>
      )}
      <Badge variant="secondary">
        {t('common.providerType.researchLab')}
      </Badge>
      <span className="flex-1" />
      <svg
        className={chevronClass}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
      </svg>
    </button>
  )
}

interface ProviderBinarySettingsProps {
  meta: ProviderMeta
  state: CodingAgentProviderState
  setState: ProviderStateSetter
  onDetectAndProbe: () => Promise<void>
}

function ProviderBinarySettings({
  meta,
  state,
  setState,
  onDetectAndProbe,
}: ProviderBinarySettingsProps) {
  const { t } = useTranslation()
  const probeStatusText = getProbeStatusText(t, state.probe)
  const probeStatusClass = getProbeStatusClass(state.probe?.status)
  const detectButtonText = getDetectButtonText(t, state.probing)

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <label className="block text-sm font-medium text-foreground">
          {t('settings.localCliProviders.binaryPath')}
        </label>
        <a
          href={meta.providerSiteUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          {t('common.lLMProviderSettingsPanel.providerDocs')}
        </a>
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={state.binaryPath}
          onChange={(event) => {
            setState((prev) => ({ ...prev, binaryPath: event.target.value }))
          }}
          placeholder={providerBinaryName(meta.id)}
          className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring transition-colors"
        />
        <Button
          type="button"
          variant="outline"
          disabled={state.probing}
          onClick={() => {
            void onDetectAndProbe()
          }}
          className="shrink-0 whitespace-nowrap"
        >
          {detectButtonText}
        </Button>
      </div>
      {probeStatusText !== null && (
        <p className={`mt-1 text-[11px] ${probeStatusClass}`}>
          {probeStatusText}
        </p>
      )}
    </div>
  )
}

interface ProviderModelSettingsProps {
  state: CodingAgentProviderState
  syncState: SyncState
  syncMessage: string
  onSyncClick: () => Promise<void>
  onModelChange: (model: string) => Promise<void> | void
  setState: ProviderStateSetter
}

function ProviderModelSettings({
  state,
  syncState,
  syncMessage,
  onSyncClick,
  onModelChange,
  setState,
}: ProviderModelSettingsProps) {
  const { t } = useTranslation()
  const syncButtonText = getSyncButtonText(t, syncState)
  const syncMessageClass = getSyncMessageClass(syncState)

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <label className="block text-sm font-medium text-foreground">
          {t('common.lLMProviderSettingsPanel.defaultModel')}
        </label>
        <button
          type="button"
          onClick={() => {
            void onSyncClick()
          }}
          disabled={syncState === 'syncing'}
          className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors disabled:opacity-50 disabled:cursor-wait"
        >
          {syncButtonText}
        </button>
      </div>
      <select
        value={state.model}
        onChange={(event) => {
          const next = event.target.value
          setState((prev) => ({ ...prev, model: next }))
          void onModelChange(next)
        }}
        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring appearance-none transition-colors"
      >
        <option value="">
          {t('common.lLMProviderSettingsPanel.providerDefault')}
        </option>
        {state.availableModels.map((model) => (
          <option key={model} value={model}>
            {model}
          </option>
        ))}
      </select>
      {syncMessage.length > 0 && (
        <p className={syncMessageClass}>
          {syncMessage}
        </p>
      )}
    </div>
  )
}

interface ProviderExtraArgsSettingsProps {
  config: ExtraArgsConfig
  onChange: (value: string) => void
}

function ProviderExtraArgsSettings({
  config,
  onChange,
}: ProviderExtraArgsSettingsProps) {
  const { t } = useTranslation()

  return (
    <div>
      <label className="block text-sm font-medium text-foreground mb-1.5">
        {t('settings.localCliProviders.extraArgs')}{' '}
        <span className="font-normal text-muted-foreground">
          {t('settings.localCliProviders.onePerLine')}
        </span>
      </label>
      <textarea
        value={config.args.join('\n')}
        onChange={(event) => {
          onChange(event.target.value)
        }}
        placeholder={config.placeholder}
        rows={2}
        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-none transition-colors"
      />
    </div>
  )
}

interface ProviderPrimaryActionProps {
  isPrimary: boolean
  isPrimarySelectionPending: boolean
  onSetPrimary: () => void
}

function ProviderPrimaryAction({
  isPrimary,
  isPrimarySelectionPending,
  onSetPrimary,
}: ProviderPrimaryActionProps) {
  const { t } = useTranslation()

  if (isPrimary) {
    return null
  }

  return (
    <div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onSetPrimary}
        disabled={isPrimarySelectionPending}
        data-tour="settings-coding-agent-primary"
      >
        {t('common.lLMProviderSettingsPanel.setAsPrimary')}
      </Button>
    </div>
  )
}

interface ProviderPanelBodyProps {
  meta: ProviderMeta
  state: CodingAgentProviderState
  setState: ProviderStateSetter
  syncState: SyncState
  syncMessage: string
  isPrimary: boolean
  isPrimarySelectionPending: boolean
  onSetPrimary: () => void
  onDetectAndProbe: () => Promise<void>
  onSyncClick: () => Promise<void>
  onModelChange: (model: string) => Promise<void> | void
  onExtraArgsChange: (value: string) => void
}

function ProviderPanelBody({
  meta,
  state,
  setState,
  syncState,
  syncMessage,
  isPrimary,
  isPrimarySelectionPending,
  onSetPrimary,
  onDetectAndProbe,
  onSyncClick,
  onModelChange,
  onExtraArgsChange,
}: ProviderPanelBodyProps) {
  const extraArgsConfig = getExtraArgsConfig(meta.id, state)

  return (
    <div className="border-t border-border px-4 py-4 space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ProviderBinarySettings
          meta={meta}
          state={state}
          setState={setState}
          onDetectAndProbe={onDetectAndProbe}
        />

        <ProviderModelSettings
          state={state}
          syncState={syncState}
          syncMessage={syncMessage}
          onSyncClick={onSyncClick}
          onModelChange={onModelChange}
          setState={setState}
        />
      </div>

      {providerSupportsExtraArgs(meta.id) && (
        <ProviderExtraArgsSettings
          config={extraArgsConfig}
          onChange={onExtraArgsChange}
        />
      )}

      <ProviderPrimaryAction
        isPrimary={isPrimary}
        isPrimarySelectionPending={isPrimarySelectionPending}
        onSetPrimary={onSetPrimary}
      />
    </div>
  )
}

function ProviderPanel({
  meta,
  state,
  setState,
  isPrimary,
  isPrimarySelectionPending,
  onSetPrimary,
  onSave,
  onDetect,
  onProbe,
  onSyncModels,
  onModelChange,
  autosaveBaselineKey,
}: ProviderPanelProps) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const [syncState, setSyncState] = useState<SyncState>('idle')
  const [syncMessage, setSyncMessage] = useState('')

  // Debounced autosave on enabled / binaryPath / provider-specific extra args.
  // We only persist the persistable subset; probing/probe results are not part of the save.
  const persistable = {
    enabled: state.enabled,
    binaryPath: state.binaryPath,
    codexArgs: state.codexArgs,
    opencodeArgs: state.opencodeArgs,
  }
  useDebouncedAutoSave(persistable, async () => {
    await onSave(state)
  }, {
    baselineKey: autosaveBaselineKey,
  })

  async function handleDetectAndProbe(): Promise<void> {
    const detectedPath = await onDetect()
    if (detectedPath !== null && detectedPath.length > 0) {
      await onProbe({ ...state, enabled: true, binaryPath: detectedPath })
      return
    }

    await onProbe(state)
  }

  async function handleSyncClick(): Promise<void> {
    setSyncState('syncing')
    setSyncMessage('')
    try {
      const count = await onSyncModels()
      setSyncState('synced')
      setSyncMessage(
        t('settings.localCliProviders.loadedModels', { count }),
      )
    } catch (error) {
      setSyncState('error')
      setSyncMessage(getErrorMessage(error, t('settings.localCliProviders.syncFailed')))
    }
  }

  function handleExtraArgsChange(value: string): void {
    const parsedArgs = parseCliArgsInput(value)
    setState((prev) => {
      if (meta.id === 'codex') {
        return { ...prev, codexArgs: parsedArgs }
      }

      return { ...prev, opencodeArgs: parsedArgs }
    })
  }

  return (
    <div>
      <ProviderPanelHeader
        meta={meta}
        expanded={expanded}
        isPrimary={isPrimary}
        onToggle={() => {
          setExpanded(!expanded)
        }}
      />

      {expanded && (
        <ProviderPanelBody
          meta={meta}
          state={state}
          setState={setState}
          syncState={syncState}
          syncMessage={syncMessage}
          isPrimary={isPrimary}
          isPrimarySelectionPending={isPrimarySelectionPending}
          onSetPrimary={onSetPrimary}
          onDetectAndProbe={handleDetectAndProbe}
          onSyncClick={handleSyncClick}
          onModelChange={onModelChange}
          onExtraArgsChange={handleExtraArgsChange}
        />
      )}
    </div>
  )
}

export interface CodingAgentProvidersSectionProps {
  primaryAgent: ProviderId | null
  isPrimarySelectionPending: boolean
  onSetPrimaryAgent: (id: ProviderId) => void
  captureDesktopAnalyticsEvent?: CaptureDesktopAnalyticsEvent
  captureRendererException?: CaptureRendererException
}

export function CodingAgentProvidersSection({
  primaryAgent,
  isPrimarySelectionPending,
  onSetPrimaryAgent,
  captureDesktopAnalyticsEvent = () => {},
  captureRendererException = () => {},
}: CodingAgentProvidersSectionProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [claudeCode, setClaudeCode] = useState<CodingAgentProviderState>({
    enabled: true,
    binaryPath: 'claude',
    model: '',
    availableModels: PROVIDER_META.claude_code.defaultModels,
    probing: false,
  })
  const [codex, setCodex] = useState<CodingAgentProviderState>({
    enabled: true,
    binaryPath: 'codex',
    model: '',
    availableModels: [],
    probing: false,
  })
  const [opencode, setOpenCode] = useState<CodingAgentProviderState>({
    enabled: true,
    binaryPath: 'opencode',
    model: '',
    availableModels: PROVIDER_META.opencode.defaultModels,
    probing: false,
  })
  const [cursor, setCursor] = useState<CodingAgentProviderState>({
    enabled: true,
    binaryPath: 'cursor-agent',
    model: '',
    availableModels: PROVIDER_META.cursor.defaultModels,
    probing: false,
  })
  const [autosaveBaselineRevision, setAutosaveBaselineRevision] = useState(0)

  const getProviderSetter = useCallback((provider: ProviderId): ProviderStateSetter => {
    switch (provider) {
      case 'claude_code':
        return setClaudeCode
      case 'codex':
        return setCodex
      case 'opencode':
        return setOpenCode
      case 'cursor':
        return setCursor
    }
  }, [])

  const getProviderModel = useCallback((provider: ProviderId): string => {
    switch (provider) {
      case 'claude_code':
        return claudeCode.model
      case 'codex':
        return codex.model
      case 'opencode':
        return opencode.model
      case 'cursor':
        return cursor.model
    }
  }, [claudeCode.model, codex.model, cursor.model, opencode.model])

  useEffect(() => {
    const llmApi = getDesktopLlmApi()

    void (async () => {
      const settingsResult = await Promise.allSettled([
        llmApi.local.getSettings(),
        llmApi.getProviders(),
      ] as const)

      const localSettings = settingsResult[0]
      if (localSettings.status === 'fulfilled') {
        const settings: DesktopLocalLlmSettings = localSettings.value
        setClaudeCode((prev) => ({
          ...prev,
          enabled: settings.claudeCode.enabled,
          binaryPath: settings.claudeCode.binaryPath,
          probe: settings.claudeCode.lastProbe as DesktopCliProbeResult | undefined,
        }))
        setCodex((prev) => ({
          ...prev,
          enabled: settings.codex.enabled,
          binaryPath: settings.codex.binaryPath,
          codexArgs: settings.codex.codexArgs,
          probe: settings.codex.lastProbe as DesktopCliProbeResult | undefined,
        }))
        setOpenCode((prev) => ({
          ...prev,
          enabled: settings.opencode.enabled,
          binaryPath: settings.opencode.binaryPath,
          opencodeArgs: settings.opencode.opencodeArgs,
          probe: settings.opencode.lastProbe as DesktopCliProbeResult | undefined,
        }))
        setCursor((prev) => ({
          ...prev,
          enabled: settings.cursor.enabled,
          binaryPath: settings.cursor.binaryPath,
          probe: settings.cursor.lastProbe as DesktopCliProbeResult | undefined,
        }))
      }

      const providerSettingsResult = settingsResult[1]
      if (providerSettingsResult.status === 'fulfilled') {
        const providerSettings = providerSettingsResult.value as ProviderSettingsRecord
        applySavedModel(setClaudeCode, providerSettings.claude_code?.model ?? '')
        applySavedModel(setCodex, providerSettings.codex?.model ?? '')
        applySavedModel(setOpenCode, providerSettings.opencode?.model ?? '')
        applySavedModel(setCursor, providerSettings.cursor?.model ?? '')
      }

      if (
        localSettings.status === 'fulfilled' ||
        providerSettingsResult.status === 'fulfilled'
      ) {
        setAutosaveBaselineRevision((current) => current + 1)
      }
    })().catch(() => {
        // Settings not available yet
      })
  }, [])

  const handleSave = useCallback(
    async (provider: ProviderId, state: CodingAgentProviderState) => {
      const llmApi = getDesktopLlmApi()
      await llmApi.local.saveSettings(createSettingsPatch(provider, state))
      notifyLlmProvidersUpdated()
    },
    [],
  )

  const handleDetect = useCallback(
    async (provider: ProviderId, preferredBinaryPath?: string) => {
      const llmApi = getDesktopLlmApi()
      const result = await llmApi.local.detectBinary(
        provider,
        preferredBinaryPath,
      )
      if (result !== null && result.length > 0) {
        // Auto-enable when the binary is detected — no need to make the user
        // tick the checkbox manually.
        const setter = getProviderSetter(provider)
        setter((prev) => ({ ...prev, binaryPath: result, enabled: true }))
        captureDesktopAnalyticsEvent('desktop_coding_agent_detected', {
          provider,
          binary_path_present: true,
        })
        toast({
          title: t('settings.localCliProviders.detected'),
          description: t('settings.localCliProviders.binaryPathDetected'),
        })
        return result
      } else {
        captureDesktopAnalyticsEvent('desktop_coding_agent_detection_failed', {
          provider,
        })
        captureRendererException(
          new Error(`Failed to detect ${provider} binary`),
          {
            provider,
            operation: 'detect',
            preferredBinaryPath: preferredBinaryPath ?? null,
          },
        )
        toast({
          title: t('settings.localCliProviders.notFound'),
          description: t('settings.localCliProviders.binaryNotFoundOnPath', {
            binary: providerBinaryName(provider),
          }),
          variant: 'destructive',
        })
        return null
      }
    },
    [
      captureDesktopAnalyticsEvent,
      captureRendererException,
      getProviderSetter,
      t,
      toast,
    ],
  )

  const handleProbe = useCallback(
    async (provider: ProviderId, state: CodingAgentProviderState) => {
      const setter = getProviderSetter(provider)
      setter((prev) => ({ ...prev, probing: true }))
      try {
        await handleSave(provider, state)
        const llmApi = getDesktopLlmApi()
        const result = await llmApi.local.probe(provider)
        setter((prev) => ({ ...prev, probe: result, probing: false }))
        captureDesktopAnalyticsEvent('desktop_coding_agent_probed', {
          provider,
          status: result.status,
          auth_status: result.auth.status,
          installed: result.installed,
        })
        if (result.status === 'error') {
          captureRendererException(
            new Error(result.message ?? `Probe failed for ${provider}`),
            {
              provider,
              operation: 'probe',
              binaryPath: state.binaryPath,
              errorKind: result.errorKind,
              authStatus: result.auth.status,
            },
          )
          toast({
            title: t('settings.localCliProviders.testFailed'),
            description:
              result.message ?? t('settings.localCliProviders.probeFailed'),
            variant: 'destructive',
          })
        }
      } catch (error) {
        setter((prev) => ({ ...prev, probing: false }))
        captureDesktopAnalyticsEvent('desktop_coding_agent_probe_failed', {
          provider,
        })
        captureRendererException(error, {
          provider,
          operation: 'probe',
          binaryPath: state.binaryPath,
        })
        toast({
          title: t('settings.localCliProviders.error'),
          description: getErrorMessage(error, t('settings.localCliProviders.probeFailed')),
          variant: 'destructive',
        })
      }
    },
    [
      captureDesktopAnalyticsEvent,
      captureRendererException,
      getProviderSetter,
      handleSave,
      t,
      toast,
    ],
  )

  const handleSaveModel = useCallback(
    async (provider: ProviderId, model: string) => {
      const llmApi = getDesktopLlmApi()
      await llmApi.saveProvider(provider, { model })
      notifyLlmProvidersUpdated()
      captureDesktopAnalyticsEvent('desktop_coding_agent_model_selected', {
        provider,
        has_model: model.length > 0,
      })
    },
    [captureDesktopAnalyticsEvent],
  )

  const handleSyncModels = useCallback(
    async (provider: ProviderId): Promise<number> => {
      const setter = getProviderSetter(provider)
      const llmApi = getDesktopLlmApi()
      const detectedModels = await llmApi.local.listModels(provider)
      const currentModel = getProviderModel(provider)
      let baseModels = PROVIDER_META[provider].defaultModels
      if (detectedModels.length > 0) {
        baseModels = detectedModels
      }
      const models = Array.from(
        new Set([
          ...baseModels,
          currentModel,
        ]),
      ).filter((modelId) => modelId.trim().length > 0)
      setter((prev) => ({
        ...prev,
        availableModels: models,
      }))
      await llmApi.saveProvider(provider, { availableModels: models })
      notifyLlmProvidersUpdated()
      captureDesktopAnalyticsEvent('desktop_coding_agent_models_synced', {
        provider,
        model_count: models.length,
      })
      return models.length
    },
    [captureDesktopAnalyticsEvent, getProviderModel, getProviderSetter],
  )

  return (
    <section
      id="coding-agents"
      data-tour="settings-coding-agents"
      className="scroll-mt-24"
    >
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-foreground">
          {t('navigation.navbar.codingAgents')}
        </h2>
        <p className="text-xs text-muted-foreground">
          {t('settings.localCliProviders.connectLocalCodingAgents')}
        </p>
      </div>
      <div className="rounded-lg border border-border divide-y divide-border overflow-hidden">
        <ProviderPanel
          meta={PROVIDER_META.codex}
          state={codex}
          setState={setCodex}
          isPrimary={primaryAgent === 'codex'}
          isPrimarySelectionPending={isPrimarySelectionPending}
          onSetPrimary={() => { onSetPrimaryAgent('codex'); }}
          onSave={(state) => handleSave('codex', state)}
          onDetect={() => handleDetect('codex', codex.binaryPath)}
          onProbe={(state) => handleProbe('codex', state)}
          onSyncModels={() => handleSyncModels('codex')}
          onModelChange={(model) => handleSaveModel('codex', model)}
          autosaveBaselineKey={autosaveBaselineRevision}
        />
        <ProviderPanel
          meta={PROVIDER_META.cursor}
          state={cursor}
          setState={setCursor}
          isPrimary={primaryAgent === 'cursor'}
          isPrimarySelectionPending={isPrimarySelectionPending}
          onSetPrimary={() => { onSetPrimaryAgent('cursor'); }}
          onSave={(state) => handleSave('cursor', state)}
          onDetect={() => handleDetect('cursor', cursor.binaryPath)}
          onProbe={(state) => handleProbe('cursor', state)}
          onSyncModels={() => handleSyncModels('cursor')}
          onModelChange={(model) => handleSaveModel('cursor', model)}
          autosaveBaselineKey={autosaveBaselineRevision}
        />
        <ProviderPanel
          meta={PROVIDER_META.claude_code}
          state={claudeCode}
          setState={setClaudeCode}
          isPrimary={primaryAgent === 'claude_code'}
          isPrimarySelectionPending={isPrimarySelectionPending}
          onSetPrimary={() => { onSetPrimaryAgent('claude_code'); }}
          onSave={(state) => handleSave('claude_code', state)}
          onDetect={() => handleDetect('claude_code', claudeCode.binaryPath)}
          onProbe={(state) => handleProbe('claude_code', state)}
          onSyncModels={() => handleSyncModels('claude_code')}
          onModelChange={(model) => handleSaveModel('claude_code', model)}
          autosaveBaselineKey={autosaveBaselineRevision}
        />
        <ProviderPanel
          meta={PROVIDER_META.opencode}
          state={opencode}
          setState={setOpenCode}
          isPrimary={primaryAgent === 'opencode'}
          isPrimarySelectionPending={isPrimarySelectionPending}
          onSetPrimary={() => { onSetPrimaryAgent('opencode'); }}
          onSave={(state) => handleSave('opencode', state)}
          onDetect={() => handleDetect('opencode', opencode.binaryPath)}
          onProbe={(state) => handleProbe('opencode', state)}
          onSyncModels={() => handleSyncModels('opencode')}
          onModelChange={(model) => handleSaveModel('opencode', model)}
          autosaveBaselineKey={autosaveBaselineRevision}
        />
      </div>
    </section>
  )
}
