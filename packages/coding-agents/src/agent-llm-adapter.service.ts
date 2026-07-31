/**
 * Agent LLM Adapter Service
 *
 * Main-process LLM client for agentic tool execution.
 * Extracted from electron/index.ts bitsentry:llm:ping helpers.
 *
 * Features:
 * - Resolves primary provider + apiKey/baseUrl/model from settings + local auth store
 * - Runs streaming chat calls with tool support
 * - Supports OpenAI-compatible, Gemini, Anthropic, Ollama providers
 *
 * Guardrails:
 * - API keys are loaded from a dedicated local auth store on demand
 * - Streaming responses for real-time agent feedback
 * - Tool-calling support for agentic workflows
 */

import type {
  LocalAiExecutionResult,
  LocalAiProviderKey,
  LocalAiStreamDelta,
} from './types.js'
import {
  agentToolCallSchema,
  type AgentToolCall,
  type AgentToolProtocol,
  type AgentToolResultEnvelope,
  type HostToolContext,
} from '@bitsentry-ce/core/features/agent-runtime'
import { codingAgentsLogger as log } from './logger.js'
import { getCatalogModelIds } from '@bitsentry-ce/components/llm/modelCatalog'

export type LlmProviderKey = 'groq' | 'kilocode' | 'openai' | 'anthropic' | 'gemini' | 'openrouter' | 'claude_code' | 'codex' | 'opencode' | 'cursor'

// Insertion order decides the winner for the rare model id that appears in
// more than one CLI catalog and is not served by the default provider.
const CLI_PROVIDER_RESOLUTION_ORDER: readonly LlmProviderKey[] = [
  'claude_code',
  'codex',
  'opencode',
  'cursor',
]

// model id -> CLI providers that serve it. A model can belong to several
// providers, so the value is a list, in resolution order. Keys use the model
// catalog's normalization (trim + lowercase). Built once on first use.
let cliProvidersByModelId: Map<string, LlmProviderKey[]> | undefined

function getCliProvidersByModelId(): Map<string, LlmProviderKey[]> {
  if (cliProvidersByModelId === undefined) {
    cliProvidersByModelId = new Map()
    for (const providerKey of CLI_PROVIDER_RESOLUTION_ORDER) {
      for (const modelId of getCatalogModelIds(providerKey)) {
        const key = modelId.trim().toLowerCase()
        const providers = cliProvidersByModelId.get(key) ?? []
        providers.push(providerKey)
        cliProvidersByModelId.set(key, providers)
      }
    }
  }

  return cliProvidersByModelId
}

export type AgentLlmSettingsStore = {
  setting: {
    findUnique(args: { where: { key: string } }): Promise<{ value: string | null } | null>
  }
}

export type RawAgentLlmSettingsStore = {
  setting: {
    findUnique(args: { where: { key: string } }): Promise<unknown>
  }
}

export function createAgentLlmSettingsStore(
  store: RawAgentLlmSettingsStore,
): AgentLlmSettingsStore {
  return {
    setting: {
      async findUnique(args) {
        const row = await store.setting.findUnique(args)
        if (row === null || typeof row !== 'object' || !('value' in row)) {
          return null
        }

        const { value } = row
        if (typeof value === 'string') {
          return { value }
        }

        return { value: null }
      },
    },
  }
}

export function createDesktopAgentLlmAdapter(
  store: RawAgentLlmSettingsStore,
  llmProviderCredentialsStore?: AgentLlmCredentialsStore,
): AgentLlmAdapterService {
  return new AgentLlmAdapterService(
    createAgentLlmSettingsStore(store),
    llmProviderCredentialsStore,
  )
}

export type AgentLlmCredentialsStore = {
  getApiKey(providerKey: LlmProviderKey): Promise<string | null | undefined>
}

const NOOP_LLM_CREDENTIALS_STORE: AgentLlmCredentialsStore = {
  getApiKey() {
    return Promise.resolve(null)
  },
}

export interface LocalAiProviderPort {
  isReady(provider: LocalAiProviderKey): boolean
  listModels(provider: LocalAiProviderKey): Promise<string[]>
  execute(
    provider: LocalAiProviderKey,
    prompt: string,
    abortController: AbortController,
    onDelta?: (delta: LocalAiStreamDelta) => void,
    cwd?: string,
    model?: string,
    accessLevel?: 'auto-accept-edits' | 'full-access',
    traitValues?: Record<string, string | boolean>,
    hostToolContext?: HostToolContext,
    systemPrompt?: string,
  ): Promise<LocalAiExecutionResult>
}

type LocalAiAccessLevel = Parameters<LocalAiProviderPort['execute']>[6]

function resolveAgentLocalAiAccessLevel(
  providerKey: LocalAiProviderKey,
  accessLevel: LocalAiAccessLevel,
): LocalAiAccessLevel {
  void providerKey
  return accessLevel ?? 'auto-accept-edits'
}

export interface ChatImageAttachment {
  type: 'image'
  name: string
  mimeType: string
  dataUrl: string
}

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; image: ChatImageAttachment }

export interface LlmSelection {
  providerKey?: LlmProviderKey
  model?: string
  thinkingEnabled?: boolean
}

/**
 * Chat message for LLM conversation.
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ChatContentPart[]
  toolCallId?: string
  toolCalls?: ToolCall[]
  toolResult?: AgentToolResultEnvelope
}

/**
 * Tool call from LLM response.
 */
export type ToolCall = AgentToolCall

/**
 * Tool definition for LLM consumption.
 */
export interface LlmToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/**
 * Streaming delta callback.
 */
export type OnDelta = (delta: {
  type: 'text' | 'tool_call' | 'reasoning' | 'command_output'
  text?: string
  toolCall?: { id: string; name: string; args: Record<string, unknown> }
} | {
  type: 'token_usage'
  tokenUsage: NonNullable<ChatResponse['tokenUsage']>
}) => void

/**
 * LLM chat request with tools.
 */
export interface ChatWithToolsInput {
  messages: ChatMessage[]
  tools?: LlmToolDefinition[]
  signal: AbortSignal
  onDelta?: OnDelta
  llm?: LlmSelection
  accessLevel?: 'auto-accept-edits' | 'full-access'
  traitValues?: Record<string, string | boolean>
  hostToolContext?: HostToolContext
}

/**
 * LLM chat response.
 */
export interface ChatResponse {
  content: string
  toolCalls?: ToolCall[]
  toolProtocol: AgentToolProtocol
  tokenUsage?: {
    inputTokens: number
    outputTokens: number
    contextTokens?: number
    contextLimit?: number
  }
}

/**
 * Default models per provider.
 */
const DEFAULT_MODELS: Record<LlmProviderKey, string> = {
  groq: 'openai/gpt-oss-120b',
  kilocode: 'kilo-auto/frontier',
  openai: 'gpt-4.1-mini',
  anthropic: 'claude-sonnet-4-20250514',
  gemini: 'gemini-2.5-flash',
  openrouter: 'openai/gpt-4.1',
  claude_code: 'claude-sonnet-4-6',
  codex: 'gpt-5.4',
  opencode: 'openai/gpt-5',
  cursor: 'composer-2.5',
}

function isLlmProviderKey(value: string): value is LlmProviderKey {
  return value in DEFAULT_MODELS
}

function isLocalAiProviderKey(providerKey: LlmProviderKey): providerKey is LocalAiProviderKey {
  switch (providerKey) {
    case 'claude_code':
    case 'codex':
    case 'opencode':
    case 'cursor':
      return true
    default:
      return false
  }
}

function isUsableOpenCodeFreeModel(model: string): boolean {
  return /^opencode\/.+(?:free|pickle)/i.test(model.trim())
}

function isOpenAiProvider(providerKey: LlmProviderKey): boolean {
  return providerKey === 'openai'
}

function isOpenAiGpt5FamilyModel(model: string): boolean {
  return /^gpt-5(?:[.-]|$)/i.test(model.trim())
}

function isOpenAiOFamilyModel(model: string): boolean {
  return /^o[134](?:[.-]|$)/i.test(model.trim())
}

function isOpenAiReasoningFamilyModel(model: string): boolean {
  return isOpenAiGpt5FamilyModel(model) || isOpenAiOFamilyModel(model)
}

function isOpenAiGpt51FamilyModel(model: string): boolean {
  return /^gpt-5\.1(?:[.-]|$)/i.test(model.trim())
}

function getOpenAiCompletionLimitParams(
  providerKey: LlmProviderKey,
  maxOutputTokens: number,
): Record<string, number> {
  if (isOpenAiProvider(providerKey)) {
    return { max_completion_tokens: maxOutputTokens }
  }
  return { max_tokens: maxOutputTokens }
}

function getOpenAiSamplingParams(
  providerKey: LlmProviderKey,
  model: string,
): Record<string, number> {
  if (isOpenAiProvider(providerKey) && isOpenAiReasoningFamilyModel(model)) {
    return {}
  }
  return { temperature: 0.2 }
}

// All values the OpenAI API accepts for reasoning_effort. 'xhigh' is a catalog alias
// for 'high' (OpenAI doesn't have xhigh, so we cap at high).
const OPENAI_EFFORT_MAP: Record<string, string> = {
  none: 'none', minimal: 'minimal', low: 'low', medium: 'medium',
  high: 'high', xhigh: 'high', max: 'high', ultrathink: 'high',
}

function getExplicitOpenAiReasoningEffort(effortLevel?: string): string | null {
  if (effortLevel === undefined || effortLevel.length === 0) {
    return null
  }

  return OPENAI_EFFORT_MAP[effortLevel] ?? null
}

function getOpenAiThinkingEffort(
  model: string,
  thinkingEnabled: boolean | undefined,
): string | null {
  if (thinkingEnabled === undefined || isOpenAiOFamilyModel(model)) {
    return null
  }

  if (!isOpenAiGpt5FamilyModel(model) || isOpenAiGpt51FamilyModel(model)) {
    if (thinkingEnabled) {
      return 'medium'
    }
    return 'none'
  }

  if (thinkingEnabled) {
    return 'medium'
  }
  return 'minimal'
}

function getOpenAiReasoningParams(
  providerKey: LlmProviderKey,
  model: string,
  thinkingEnabled: boolean | undefined,
  effortLevel?: string,
): Record<string, string> {
  if (!isOpenAiProvider(providerKey)) {
    return {}
  }

  // Prefer explicit effort level from composer traitValues (only if explicitly set by user)
  const explicitEffort = getExplicitOpenAiReasoningEffort(effortLevel)
  if (explicitEffort !== null) {
    return { reasoning_effort: explicitEffort }
  }

  const thinkingEffort = getOpenAiThinkingEffort(model, thinkingEnabled)
  if (thinkingEffort !== null) {
    return { reasoning_effort: thinkingEffort }
  }

  return {}
}

function parseDataUrl(dataUrl: string): { mediaType: string; base64: string } {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (match === null) {
    throw new Error('Invalid image attachment format. Expected base64 data URL.')
  }
  return { mediaType: match[1], base64: match[2] }
}

function normalizeTextContent(content: string | ChatContentPart[]): string {
  if (typeof content === 'string') return content
  return content
    .filter((part): part is Extract<ChatContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
}

function toOpenAiMessageContent(content: string | ChatContentPart[]): string | Array<Record<string, unknown>> {
  if (typeof content === 'string') return content
  return content.map((part) => {
    if (part.type === 'text') {
      return { type: 'text', text: part.text }
    }
    return {
      type: 'image_url',
      image_url: {
        url: part.image.dataUrl,
      },
    }
  })
}

function toAnthropicContent(content: string | ChatContentPart[]): string | Array<Record<string, unknown>> {
  if (typeof content === 'string') return content
  return content.map((part) => {
    if (part.type === 'text') {
      return { type: 'text', text: part.text }
    }
    const { mediaType, base64 } = parseDataUrl(part.image.dataUrl)
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: mediaType,
        data: base64,
      },
    }
  })
}

function toGeminiParts(content: string | ChatContentPart[]): Array<Record<string, unknown>> {
  if (typeof content === 'string') {
    return [{ text: content }]
  }

  return content.map((part) => {
    if (part.type === 'text') {
      return { text: part.text }
    }
    const { mediaType, base64 } = parseDataUrl(part.image.dataUrl)
    return {
      inlineData: {
        mimeType: mediaType,
        data: base64,
      },
    }
  })
}

function flattenMessageText(m: ChatMessage): string {
  if (typeof m.content === 'string') return `[${m.role}]: ${m.content}`
  if (Array.isArray(m.content)) {
    const text = m.content
      .filter((part): part is Extract<ChatContentPart, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
    return `[${m.role}]: ${text}`
  }
  return `[${m.role}]: `
}

function createNativeToolCall(value: unknown, providerLabel: string): ToolCall | null {
  const parsed = agentToolCallSchema.safeParse(value)
  if (parsed.success) return parsed.data
  log.warn(`[agent-llm] Ignoring invalid ${providerLabel} native tool call`)
  return null
}

interface SseEvent {
  event?: string
  data: string
}

interface OpenAiStreamingToolCallFragment {
  id?: string
  name?: string
  argumentsText: string
}

function hasEventStreamContentType(response: Response): boolean {
  return response.headers.get('content-type')?.includes('text/event-stream') ?? false
}

function parseSseEvent(rawEvent: string): SseEvent | null {
  const dataLines: string[] = []
  let event: string | undefined

  for (const line of rawEvent.split('\n')) {
    if (line.length === 0 || line.startsWith(':')) {
      continue
    }
    if (line.startsWith('event:')) {
      event = line.slice(6).trim()
      continue
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart())
    }
  }

  if (dataLines.length === 0) {
    return null
  }

  return { event, data: dataLines.join('\n') }
}

async function* iterateSseEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')

      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        boundary = buffer.indexOf('\n\n')

        const event = parseSseEvent(rawEvent)
        if (event !== null) {
          yield event
        }
      }
    }

    buffer += decoder.decode().replace(/\r\n/g, '\n')
    const rawEvent = buffer.trim()
    if (rawEvent.length === 0) {
      return
    }

    const event = parseSseEvent(rawEvent)
    if (event !== null) {
      yield event
    }
  } finally {
    reader.releaseLock()
  }
}

function parseJsonObject(value: string, context: string): Record<string, unknown> {
  const normalized = value.trim()
  if (normalized.length === 0) {
    return {}
  }

  try {
    const parsed = JSON.parse(normalized) as unknown
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch (error) {
    log.warn(`[agent-llm] Failed to parse ${context}:`, error)
  }

  return {}
}

function emitTextDelta(onDelta: OnDelta | undefined, text: string): void {
  if (text.length === 0) {
    return
  }

  onDelta?.({
    type: 'text',
    text,
  })
}

function createLocalAiDeltaHandler(
  onDelta: OnDelta | undefined,
): (delta: LocalAiStreamDelta) => void {
  return (delta) => {
    if (delta.type === 'token_usage') {
      onDelta?.({
        type: 'token_usage',
        tokenUsage: delta.tokenUsage,
      })
      return
    }

    if (delta.type !== 'text' || delta.text === undefined || delta.text.length === 0) {
      return
    }

    emitTextDelta(onDelta, delta.text)
  }
}

function getEffortTrait(traitValues?: Record<string, string | boolean>): string | undefined {
  const effort = traitValues?.effort
  if (typeof effort === 'string') {
    return effort
  }
  return undefined
}

function toTokenUsage(
  inputTokens: number | undefined,
  outputTokens: number | undefined,
): ChatResponse['tokenUsage'] {
  if (inputTokens === undefined) {
    return undefined
  }

  return {
    inputTokens,
    outputTokens: outputTokens ?? 0,
  }
}

function formatProviderHttpError(providerLabel: string, response: Response, body: string): string {
  let message = `${providerLabel} request failed: ${String(response.status)} ${response.statusText}`
  if (body.length > 0) {
    message += ` - ${body}`
  }
  return message
}

function getRequiredToolCallId(m: ChatMessage, providerLabel: string): string {
  if (m.toolCallId !== undefined && m.toolCallId.length > 0) {
    return m.toolCallId
  }

  throw new Error(`${providerLabel} tool result is missing tool call id`)
}

function getGeminiRole(role: ChatMessage['role']): 'model' | 'user' {
  if (role === 'assistant') {
    return 'model'
  }
  return 'user'
}

function getAnthropicThinkingConfig(thinkingEnabled: boolean | undefined): Record<string, unknown> {
  if (thinkingEnabled !== true) {
    return {}
  }

  return {
    thinking: {
      type: 'enabled',
      budget_tokens: 2048,
    },
  }
}

function getGeminiSystemInstruction(systemInstruction: string): Record<string, unknown> | undefined {
  if (systemInstruction.length === 0) {
    return undefined
  }

  return { parts: [{ text: systemInstruction }] }
}

function getGeminiTools(
  functionDeclarations: Array<Record<string, unknown>> | undefined,
): Array<Record<string, unknown>> | undefined {
  if (functionDeclarations === undefined) {
    return undefined
  }

  return [{ functionDeclarations }]
}

function getGeminiGenerationConfig(thinkingEnabled: boolean | undefined): Record<string, unknown> | undefined {
  if (thinkingEnabled === undefined) {
    return undefined
  }

  let thinkingBudget = 0
  if (thinkingEnabled) {
    thinkingBudget = -1
  }

  return {
    thinkingConfig: {
      thinkingBudget,
    },
  }
}

/**
 * Agent LLM Adapter Service
 *
 * Provides tool-calling LLM capabilities for agent runtime.
 * All provider configuration resolved from settings + the local provider auth store.
 */
export class AgentLlmAdapterService {
  private localAiProvider?: LocalAiProviderPort

  constructor(
    private readonly db: AgentLlmSettingsStore,
    private readonly llmProviderCredentialsStore: AgentLlmCredentialsStore = NOOP_LLM_CREDENTIALS_STORE,
  ) {}

  setLocalAiProvider(provider: LocalAiProviderPort): void {
    this.localAiProvider = provider
  }

  /**
   * Get the primary LLM provider from settings.
   */
  private async getProvider(overrideProviderKey?: LlmProviderKey): Promise<LlmProviderKey | null> {
    if (overrideProviderKey !== undefined) return overrideProviderKey
    const setting = await this.db.setting.findUnique({ where: { key: 'llm.provider' } })
    if (setting === null) return null

    const provider = setting.value?.trim()
    if (provider === undefined || provider.length === 0) return null

    if (isLlmProviderKey(provider)) {
      return provider
    }

    return null
  }

  /**
   * Get API key for a provider from the local provider auth store.
   */
  private async getApiKey(providerKey: LlmProviderKey): Promise<string | undefined> {
    if (isLocalAiProviderKey(providerKey)) return undefined
    const apiKey = await this.llmProviderCredentialsStore.getApiKey(providerKey)
    return apiKey ?? undefined
  }

  /**
   * Get base URL for a provider from settings.
   */
  private async getBaseUrl(providerKey: LlmProviderKey): Promise<string | undefined> {
    const setting = await this.db.setting.findUnique({
      where: { key: `llm.${providerKey}.baseUrl` },
    })
    return setting?.value?.trim() ?? undefined
  }

  /**
   * Get model for a provider from settings.
   */

  private async getModel(providerKey: LlmProviderKey, overrideModel?: string): Promise<string> {
    const trimmedOverrideModel = overrideModel?.trim()
    if (trimmedOverrideModel !== undefined && trimmedOverrideModel.length > 0) {
      return trimmedOverrideModel
    }
    const setting = await this.db.setting.findUnique({
      where: { key: `llm.${providerKey}.model` },
    })
    const savedModel = setting?.value?.trim()
    if (savedModel !== undefined && savedModel.length > 0) return savedModel

    if (providerKey === 'opencode' && this.localAiProvider?.isReady('opencode') === true) {
      try {
        const models = await this.localAiProvider.listModels('opencode')
        const freeModel = models.find(isUsableOpenCodeFreeModel)
        if (freeModel !== undefined) return freeModel
      } catch (error) {
        log.warn('[agent-llm] Failed to resolve OpenCode free default model:', error)
      }
    }

    return DEFAULT_MODELS[providerKey]
  }

  /**
   * Chat with LLM with optional tool calling.
   *
   * This is the main entry point for agent runtime.
   * Handles all provider differences and streaming.
   *
   * @param input - Chat request with messages, tools, signal, and delta callback
   * @returns Chat response with content and optional tool calls
   */

  /**
   * The provider used when a caller does not name one. Runbook actions read
   * this so a provider-less action runs on the same provider as everything else.
   *
   * When the caller has a model, the model identifies the provider first:
   * sending another provider's model to the default (for example
   * claude-sonnet-5 to codex) is always a hard 400 from the CLI.
   */
  async getDefaultProviderKey(model?: string): Promise<LlmProviderKey | null> {
    const defaultProvider = await this.getProvider()

    const normalizedModel = model?.trim().toLowerCase() ?? ''
    if (normalizedModel.length === 0) {
      return defaultProvider
    }

    const matches = getCliProvidersByModelId().get(normalizedModel)
    if (matches === undefined) {
      return defaultProvider
    }
    if (defaultProvider !== null && matches.includes(defaultProvider)) {
      return defaultProvider
    }

    return matches[0]
  }

  async chatWithTools(input: ChatWithToolsInput): Promise<ChatResponse> {
    const providerKey = await this.getProvider(input.llm?.providerKey)

    if (providerKey === null) {
      throw new Error('No LLM provider configured. Please configure a provider in Settings.')
    }

    // CLI providers route through CodingAgentsProviderService with access-level
    // based permission control.
    if (isLocalAiProviderKey(providerKey)) {
      return await this.chatWithLocalAiProvider(input, providerKey)
    }

    const apiKey = await this.getApiKey(providerKey)

    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error(`No API key configured for provider: ${providerKey}. Please configure in Settings.`)
    }

    const baseUrl = await this.getBaseUrl(providerKey)
    const model = await this.getModel(providerKey, input.llm?.model)

    log.info(`[agent-llm] Using provider: ${providerKey}, model: ${model}`)

    switch (providerKey) {
      case 'groq':
      case 'kilocode':
      case 'openai':
      case 'openrouter':
        return await this.chatOpenAiCompatible({
          ...input,
          providerKey,
          apiKey: apiKey,
          baseUrl: baseUrl ?? this.getDefaultBaseUrl(providerKey),
          model,
        })

      case 'anthropic':
        return await this.chatAnthropic({
          ...input,
          apiKey: apiKey,
          baseUrl: baseUrl ?? this.getDefaultBaseUrl(providerKey),
          model,
        })

      case 'gemini':
        return await this.chatGemini({
          ...input,
          apiKey: apiKey,
          model,
        })

      default:
        throw new Error('Unsupported provider')
    }
  }

  private async chatWithLocalAiProvider(
    input: ChatWithToolsInput,
    providerKey: LocalAiProviderKey,
  ): Promise<ChatResponse> {
    if (this.localAiProvider === undefined) {
      throw new Error('Local AI provider service is not available.')
    }

    const model = await this.getModel(providerKey, input.llm?.model)
    log.info(`[agent-llm] Using CLI provider: ${providerKey}, model: ${model}`)

    const abortController = new AbortController()
    const onAbort = (): void => { abortController.abort() }
    if (input.signal.aborted) {
      abortController.abort()
    } else {
      input.signal.addEventListener('abort', onAbort, { once: true })
    }

    const accessLevel = resolveAgentLocalAiAccessLevel(providerKey, input.accessLevel)

    const toolProtocol = input.hostToolContext === undefined ? 'none' : 'mcp'

    try {
      const result = await this.localAiProvider.execute(
        providerKey,
        this.buildLocalAiPrompt(input),
        abortController,
        createLocalAiDeltaHandler(input.onDelta),
        undefined,
        model,
        accessLevel,
        input.traitValues,
        input.hostToolContext,
        this.buildLocalAiSystemPrompt(input),
      )

      this.emitLocalAiTokenUsage(input.onDelta, result)
      return this.toLocalAiChatResponse(result, toolProtocol)
    } finally {
      input.signal.removeEventListener('abort', onAbort)
    }
  }

  private buildLocalAiPrompt(
    input: ChatWithToolsInput,
  ): string {
    // Each turn runs as a fresh CLI subprocess. The full BitSentry transcript is
    // replayed explicitly so CLI-native session state cannot leak across runs.
    // MCP executes host tools inside the current subprocess, so historical tool
    // transcripts are deliberately excluded from this text-only replay.
    return input.messages
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .map((message) => ({ ...message, toolCalls: undefined }))
      .map(flattenMessageText)
      .join('\n')
  }

  private buildLocalAiSystemPrompt(input: ChatWithToolsInput): string | undefined {
    const systemPrompt = input.messages
      .filter((message) => message.role === 'system')
      .map((message) => normalizeTextContent(message.content).trim())
      .filter((message) => message.length > 0)
      .join('\n\n')
    return systemPrompt.length > 0 ? systemPrompt : undefined
  }

  private emitLocalAiTokenUsage(
    onDelta: OnDelta | undefined,
    result: LocalAiExecutionResult,
  ): void {
    if (result.tokenUsage === undefined) {
      return
    }

    onDelta?.({
      type: 'token_usage',
      tokenUsage: result.tokenUsage,
    })
  }

  private toLocalAiChatResponse(
    result: LocalAiExecutionResult,
    toolProtocol: AgentToolProtocol,
  ): ChatResponse {
    return {
      content: result.output,
      toolCalls: [],
      toolProtocol,
      tokenUsage: result.tokenUsage,
    }
  }

  /**
   * OpenAI-compatible chat (OpenRouter, Groq, OpenAI).
   */
  private async chatOpenAiCompatible(input: ChatWithToolsInput & {
    providerKey: LlmProviderKey
    apiKey: string
    baseUrl: string
    model: string
  }): Promise<ChatResponse> {
    const { messages, tools, signal, onDelta, apiKey, baseUrl, model } = input
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    }
    if (input.providerKey === 'openrouter') {
      headers['HTTP-Referer'] = 'https://desktop.bitsentry.ai'
      headers['X-Title'] = 'BitSentry Desktop'
    }

    // Convert our tools to OpenAI format
    const openAiTools = tools?.map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }))

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        stream: true,
        stream_options: {
          include_usage: true,
        },
        messages: messages.map(m => ({
          role: m.role,
          content: toOpenAiMessageContent(m.content),
          tool_call_id: m.toolCallId,
          tool_calls: m.toolCalls?.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.args),
            },
          })),
        })),
        tools: openAiTools,
        ...getOpenAiSamplingParams(input.providerKey, model),
        ...getOpenAiCompletionLimitParams(input.providerKey, 4096),
        ...getOpenAiReasoningParams(input.providerKey, model, input.llm?.thinkingEnabled, getEffortTrait(input.traitValues)),
      }),
      signal,
    })

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(formatProviderHttpError('LLM', response, body))
    }

    if (response.body !== null && hasEventStreamContentType(response)) {
      let content = ''
      let tokenUsage: ChatResponse['tokenUsage']
      const toolCallsByIndex = new Map<number, OpenAiStreamingToolCallFragment>()

      for await (const event of iterateSseEvents(response.body)) {
        if (event.data === '[DONE]') {
          break
        }

        let chunk: {
          choices?: Array<{
            delta?: {
              content?: string | null
              tool_calls?: Array<{
                index?: number
                id?: string
                function?: {
                  name?: string
                  arguments?: string
                }
              }>
            }
          }>
          usage?: { prompt_tokens?: number; completion_tokens?: number }
        }

        try {
          chunk = JSON.parse(event.data) as typeof chunk
        } catch {
          continue
        }

        const usage = chunk.usage
        if (usage?.prompt_tokens != null) {
          tokenUsage = {
            inputTokens: usage.prompt_tokens,
            outputTokens: usage.completion_tokens ?? 0,
          }
        }

        for (const choice of chunk.choices ?? []) {
          const delta = choice.delta
          const deltaContent = delta?.content
          if (deltaContent !== undefined && deltaContent !== null && deltaContent.length > 0) {
            content += deltaContent
            onDelta?.({
              type: 'text',
              text: deltaContent,
            })
          }

          for (const partialToolCall of delta?.tool_calls ?? []) {
            const index = partialToolCall.index ?? 0
            const existing = toolCallsByIndex.get(index) ?? { argumentsText: '' }
            if (partialToolCall.id !== undefined && partialToolCall.id.length > 0) {
              existing.id = partialToolCall.id
            }
            if (partialToolCall.function?.name !== undefined && partialToolCall.function.name.length > 0) {
              existing.name = partialToolCall.function.name
            }
            if (partialToolCall.function?.arguments !== undefined && partialToolCall.function.arguments.length > 0) {
              existing.argumentsText += partialToolCall.function.arguments
            }
            toolCallsByIndex.set(index, existing)
          }
        }
      }

      const toolCalls = [...toolCallsByIndex.entries()]
        .sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
        .map(([index, toolCall]) => {
          if (toolCall.name === undefined || toolCall.name.length === 0) {
            return null
          }

          return createNativeToolCall({
            id: toolCall.id ?? `openai_${String(Date.now())}_${String(index)}`,
            name: toolCall.name,
            args: parseJsonObject(toolCall.argumentsText, `OpenAI tool arguments for ${toolCall.name}`),
          }, 'OpenAI')
        })
        .filter((toolCall): toolCall is ToolCall => toolCall != null)

      return {
        content,
        toolCalls,
        toolProtocol: 'native_function_calling',
        tokenUsage,
      }
    }

    const data = await response.json() as {
      choices?: Array<{
        message?: {
          content?: string | null
          tool_calls?: Array<{
            id: string
            function: {
              name: string
              arguments: string
            }
          }>
        }
      }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }

    const message = data.choices?.[0]?.message
    if (message === undefined) {
      throw new Error('LLM returned empty response')
    }

    const toolCalls = message.tool_calls
      ?.map((toolCall) => createNativeToolCall({
        id: toolCall.id,
        name: toolCall.function.name,
        args: parseJsonObject(
          toolCall.function.arguments,
          `OpenAI tool arguments for ${toolCall.function.name}`,
        ),
      }, 'OpenAI'))
      .filter((toolCall): toolCall is ToolCall => toolCall !== null)

    const usage = data.usage
    return {
      content: message.content ?? '',
      toolCalls,
      toolProtocol: 'native_function_calling',
      tokenUsage: toTokenUsage(usage?.prompt_tokens, usage?.completion_tokens),
    }
  }

  /**
   * Anthropic chat (Claude).
   */

  private async chatAnthropic(input: ChatWithToolsInput & {
    apiKey: string
    baseUrl: string
    model: string
  }): Promise<ChatResponse> {
    const { messages, tools, signal, apiKey, baseUrl, model } = input

    // Anthropic uses a different message format
    // Filter out system messages and tool result messages
    const systemMessages = messages.filter(m => m.role === 'system')
    const chatMessages = messages.filter(m => m.role !== 'system')

    const systemText = systemMessages.map(m => normalizeTextContent(m.content)).join('\n\n')
    let system: string | undefined
    if (systemText.length > 0) {
      system = systemText
    }

    // Convert tools to Anthropic format
    const anthropicTools = tools?.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }))

    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        system,
        messages: chatMessages.map(m => {
          if (m.role === 'tool') {
            return {
              role: 'user' as const,
              content: [{
                type: 'tool_result' as const,
                tool_use_id: getRequiredToolCallId(m, 'Anthropic'),
                content: normalizeTextContent(m.content),
              }],
            }
          }
          if (m.toolCalls !== undefined && m.toolCalls.length > 0) {
            return {
              role: m.role,
              content: [
                { type: 'text', text: normalizeTextContent(m.content) },
                ...m.toolCalls.map(tc => ({
                  type: 'tool_use' as const,
                  id: tc.id,
                  name: tc.name,
                  input: tc.args,
                })),
              ],
            }
          }
          return {
            role: m.role,
            content: toAnthropicContent(m.content),
          }
        }),
        tools: anthropicTools,
        max_tokens: 4096,
        ...getAnthropicThinkingConfig(input.llm?.thinkingEnabled),
      }),
      signal,
    })

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(formatProviderHttpError('Anthropic', response, body))
    }

    const data = await response.json() as {
      content?: Array<{
        type: 'text' | 'tool_use'
        text?: string
        id?: string
        name?: string
        input?: Record<string, unknown>
      }>
      usage?: { input_tokens?: number; output_tokens?: number }
    }

    if (data.content === undefined) {
      throw new Error('Anthropic returned empty response')
    }

    let content = ''
    const toolCalls: ToolCall[] = []

    for (const block of data.content) {
      if (block.type === 'text') {
        content += block.text ?? ''
        continue
      }

      if (block.id !== undefined && block.name !== undefined) {
        const toolCall = createNativeToolCall({
          id: block.id,
          name: block.name,
          args: block.input ?? {},
        }, 'Anthropic')
        if (toolCall !== null) toolCalls.push(toolCall)
      }
    }

    const usage = data.usage
    return {
      content,
      toolCalls,
      toolProtocol: 'native_function_calling',
      tokenUsage: toTokenUsage(usage?.input_tokens, usage?.output_tokens),
    }
  }

  /**
   * Gemini chat.
   */

  private async chatGemini(input: ChatWithToolsInput & {
    apiKey: string
    model: string
  }): Promise<ChatResponse> {
    const { messages, tools, signal, apiKey, model } = input

    // Convert messages to Gemini format
    const systemInstruction = normalizeTextContent(messages.find(m => m.role === 'system')?.content ?? '')

    const contents = messages
      .filter(m => m.role !== 'system')
      .map(m => {
        if (m.role === 'tool') {
          return {
            role: 'user' as const,
            parts: [{
              functionResponse: {
                name: getRequiredToolCallId(m, 'Gemini'),
                response: { result: normalizeTextContent(m.content) },
              },
            }],
          }
        }
        if (m.toolCalls !== undefined && m.toolCalls.length > 0) {
          return {
            role: 'model' as const,
            parts: [
              { text: normalizeTextContent(m.content) },
              ...m.toolCalls.map(tc => ({
                functionCall: {
                  name: tc.name,
                  args: tc.args,
                },
              })),
            ],
          }
        }
        return {
          role: getGeminiRole(m.role),
          parts: toGeminiParts(m.content),
        }
      })

    // Convert tools to Gemini format
    const functionDeclarations = tools?.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    }))

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: getGeminiSystemInstruction(systemInstruction),
          contents,
          tools: getGeminiTools(functionDeclarations),
          generationConfig: getGeminiGenerationConfig(input.llm?.thinkingEnabled),
        }),
        signal,
      },
    )

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(formatProviderHttpError('Gemini', response, body))
    }

    const data = await response.json() as {
      candidates?: Array<{
        content?: {
          parts?: Array<{
            text?: string
            functionCall?: {
              name: string
              args: Record<string, unknown>
            }
          }>
        }
      }>
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
    }

    const parts = data.candidates?.[0]?.content?.parts ?? []
    let content = ''
    const toolCalls: ToolCall[] = []

    for (const part of parts) {
      if (part.text !== undefined && part.text.length > 0) {
        content += part.text
      }
      if (part.functionCall !== undefined) {
        const toolCall = createNativeToolCall({
          id: `gemini_${String(Date.now())}_${String(toolCalls.length)}`,
          name: part.functionCall.name,
          args: part.functionCall.args,
        }, 'Gemini')
        if (toolCall !== null) toolCalls.push(toolCall)
      }
    }

    const meta = data.usageMetadata
    return {
      content,
      toolCalls,
      toolProtocol: 'native_function_calling',
      tokenUsage: toTokenUsage(meta?.promptTokenCount, meta?.candidatesTokenCount),
    }
  }

  /**
   * Get default base URL for a provider.
   */
  private getDefaultBaseUrl(providerKey: LlmProviderKey): string {
    const defaults: Record<LlmProviderKey, string> = {
      groq: 'https://api.groq.com/openai/v1',
      kilocode: 'https://api.kilo.ai/api/gateway',
      openai: 'https://api.openai.com/v1',
      anthropic: 'https://api.anthropic.com',
      gemini: 'https://generativelanguage.googleapis.com',
      openrouter: 'https://openrouter.ai/api/v1',
      claude_code: '',
      codex: '',
      opencode: '',
      cursor: '',
    }
    return defaults[providerKey]
  }
}
