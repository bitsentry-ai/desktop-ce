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
  _providerKey: LocalAiProviderKey,
  accessLevel: LocalAiAccessLevel,
): LocalAiAccessLevel {
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

function isOpenAiCompatibleReasoningProvider(providerKey: LlmProviderKey): boolean {
  return providerKey === 'openai'
    || providerKey === 'groq'
    || providerKey === 'kilocode'
    || providerKey === 'openrouter'
}

function normalizeRoutedModelId(model: string): string {
  return model.trim().toLowerCase()
}

function isOpenAiGpt5FamilyModel(model: string): boolean {
  return /^gpt-5(?:[.-]|$)/i.test(model.trim())
}

function isOpenAiGpt56FamilyModel(model: string): boolean {
  return /^gpt-5\.6(?:[.-]|$)/i.test(model.trim())
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

function getRoutedReasoningEffort(
  providerKey: LlmProviderKey,
  model: string,
  effortLevel?: string,
): string | null {
  if (effortLevel === undefined || effortLevel.length === 0) {
    return null
  }

  const modelId = normalizeRoutedModelId(model)
  let supportedEfforts: readonly string[] | undefined

  if (providerKey === 'groq' && /^openai\/gpt-oss-(?:20b|120b)$/.test(modelId)) {
    supportedEfforts = ['low', 'medium', 'high']
  } else if (
    providerKey === 'kilocode'
    && (modelId === 'anthropic/claude-opus-4.6' || modelId === 'openai/gpt-5.2')
  ) {
    supportedEfforts = modelId.startsWith('anthropic/')
      ? ['low', 'medium', 'high', 'max']
      : ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']
  } else if (providerKey === 'openrouter') {
    if (modelId === 'openai/gpt-5.2') {
      supportedEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']
    } else if (modelId === 'openai/o3') {
      supportedEfforts = ['low', 'medium', 'high']
    } else if (modelId === 'anthropic/claude-opus-4') {
      supportedEfforts = ['low', 'medium', 'high', 'max']
    }
  }

  return supportedEfforts?.includes(effortLevel) === true ? effortLevel : null
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
  if (!isOpenAiCompatibleReasoningProvider(providerKey)) {
    return {}
  }

  // Prefer an explicit effort level from composer traitValues.
  // OpenAI keeps its API-specific clamp; routed providers pass through only
  // values advertised by the selected model.
  const explicitEffort = isOpenAiProvider(providerKey)
    ? getExplicitOpenAiReasoningEffort(effortLevel)
    : getRoutedReasoningEffort(providerKey, model, effortLevel)
  if (explicitEffort !== null) {
    return { reasoning_effort: explicitEffort }
  }

  if (!isOpenAiProvider(providerKey)) {
    return {}
  }

  const thinkingEffort = getOpenAiThinkingEffort(model, thinkingEnabled)
  if (thinkingEffort !== null) {
    return { reasoning_effort: thinkingEffort }
  }

  return {}
}

function shouldUseOpenAiResponsesApi(
  providerKey: LlmProviderKey,
  model: string,
  tools: LlmToolDefinition[] | undefined,
  reasoningParams: Record<string, string>,
): boolean {
  return providerKey === 'openai'
    && isOpenAiGpt56FamilyModel(model)
    && (tools?.length ?? 0) > 0
    && reasoningParams.reasoning_effort !== undefined
    && reasoningParams.reasoning_effort !== 'none'
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

function toOpenAiResponsesInput(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.flatMap((message): Array<Record<string, unknown>> => {
    if (message.role === 'tool') {
      return [{
        type: 'function_call_output',
        call_id: getRequiredToolCallId(message, 'OpenAI Responses'),
        output: normalizeTextContent(message.content),
      }]
    }

    if (message.role === 'assistant' && message.toolCalls !== undefined && message.toolCalls.length > 0) {
      const text = normalizeTextContent(message.content)
      return [
        ...(text.length > 0 ? [{ role: 'assistant', content: text }] : []),
        ...message.toolCalls.map((toolCall) => ({
          type: 'function_call',
          call_id: toolCall.id,
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.args),
        })),
      ]
    }

    return [{
      role: message.role,
      content: toOpenAiMessageContent(message.content),
    }]
  })
}

function toAnthropicContent(content: string | ChatContentPart[]): string | Array<Record<string, unknown>> {
  if (typeof content === 'string') return content.length > 0 ? content : []
  return content.flatMap((part): Array<Record<string, unknown>> => {
    if (part.type === 'text') {
      return part.text.length > 0 ? [{ type: 'text', text: part.text }] : []
    }
    const { mediaType, base64 } = parseDataUrl(part.image.dataUrl)
    return [{
      type: 'image',
      source: {
        type: 'base64',
        media_type: mediaType,
        data: base64,
      },
    }]
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

type OpenAiStreamingDelta = {
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

type OpenAiStreamingChunk = {
  choices?: Array<{ delta?: OpenAiStreamingDelta }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

type OpenAiCompletionPayload = {
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

type OpenAiResponsesPayload = {
  output?: Array<{
    type?: string
    id?: string
    call_id?: string
    name?: string
    arguments?: string
    content?: Array<{ type?: string; text?: string }>
  }>
  output_text?: string | null
  usage?: { input_tokens?: number; output_tokens?: number }
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

function getRequestEndpoint(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return url.split('?')[0] ?? url
  }
}

function getNestedValue(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const key of path) {
    if (current === null || typeof current !== 'object') {
      return undefined
    }
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function logEffortEvidence(
  provider: string,
  model: string,
  endpoint: string,
  serializedRequestBody: string,
): void {
  let requestBody: unknown
  try {
    requestBody = JSON.parse(serializedRequestBody) as unknown
  } catch {
    requestBody = undefined
  }

  const effortParameters: Array<{ name: string; path: readonly string[] }> = [
    { name: 'reasoning_effort', path: ['reasoning_effort'] },
    { name: 'reasoning.effort', path: ['reasoning', 'effort'] },
    { name: 'output_config.effort', path: ['output_config', 'effort'] },
    { name: 'thinking.budget_tokens', path: ['thinking', 'budget_tokens'] },
    { name: 'generationConfig.thinkingConfig.thinkingLevel', path: ['generationConfig', 'thinkingConfig', 'thinkingLevel'] },
  ]
  const matchedParameter = effortParameters.find(({ path }) => getNestedValue(requestBody, path) !== undefined)
  const effort = matchedParameter === undefined
    ? null
    : getNestedValue(requestBody, matchedParameter.path)

  // Deliberately log only provider-safe routing metadata. Never include the prompt, API key, headers, or response content.
  log.info('[effort-evidence]', {
    provider,
    model,
    endpoint,
    effort,
    parameter: matchedParameter?.name ?? null,
  })
}

function logCliEffortEvidence(
  provider: string,
  model: string,
  traitValues: Record<string, string | boolean> | undefined,
): void {
  const effort = traitValues?.effort
  log.info('[effort-evidence]', {
    provider,
    model,
    endpoint: 'cli',
    effort: typeof effort === 'string' ? effort : null,
    parameter: typeof effort === 'string' ? 'traitValues.effort' : null,
  })
}

function getGeminiRole(role: ChatMessage['role']): 'model' | 'user' {
  if (role === 'assistant') {
    return 'model'
  }
  return 'user'
}

const ANTHROPIC_MANUAL_THINKING_BUDGETS = {
  low: 1024,
  medium: 1536,
  high: 2048,
  max: 3072,
} as const

type AnthropicEffort = keyof typeof ANTHROPIC_MANUAL_THINKING_BUDGETS

function getAnthropicEffort(effortLevel: string | undefined): AnthropicEffort {
  if (effortLevel === 'xhigh' || effortLevel === 'ultrathink') {
    return 'max'
  }

  if (effortLevel !== undefined && effortLevel in ANTHROPIC_MANUAL_THINKING_BUDGETS) {
    return effortLevel as AnthropicEffort
  }

  return 'high'
}

function usesAdaptiveAnthropicThinking(model: string): boolean {
  return /^claude-(?:opus|sonnet|haiku|fable|mythos)-(?:4[-.](?:[6-9]|[1-9]\d)|[5-9]\d*)(?:-|$)/.test(model)
}

function getAnthropicThinkingConfig(
  model: string,
  thinkingEnabled: boolean | undefined,
  effortLevel: string | undefined,
): Record<string, unknown> {
  if (thinkingEnabled !== true) {
    return {}
  }

  const effort = getAnthropicEffort(effortLevel)
  if (usesAdaptiveAnthropicThinking(model)) {
    return {
      thinking: { type: 'adaptive' },
      output_config: { effort },
    }
  }

  const budgetTokens = ANTHROPIC_MANUAL_THINKING_BUDGETS[effort]

  return {
    thinking: {
      type: 'enabled',
      budget_tokens: budgetTokens,
    },
  }
}

function getGeminiSystemInstruction(systemInstruction: string): Record<string, unknown> | undefined {
  if (systemInstruction.length === 0) {
    return undefined
  }

  return { parts: [{ text: systemInstruction }] }
}

const GEMINI_SCHEMA_ALLOWED_KEYS = new Set([
  'type',
  'format',
  'title',
  'description',
  'nullable',
  'enum',
  'items',
  'properties',
  'required',
  'propertyOrdering',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'pattern',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function decodeJsonPointerPart(part: string): string {
  return part.replaceAll('~1', '/').replaceAll('~0', '~')
}

function resolveGeminiSchemaReference(
  root: Record<string, unknown>,
  reference: string,
): unknown {
  if (!reference.startsWith('#/')) {
    return undefined
  }

  return reference
    .slice(2)
    .split('/')
    .map(decodeJsonPointerPart)
    .reduce<unknown>((value, part) => {
      if (!isRecord(value)) {
        return undefined
      }

      return value[part]
    }, root)
}

function sanitizeGeminiSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const visit = (
    value: unknown,
    resolvingReferences: Set<string>,
    preserveObjectKeys = false,
  ): unknown => {
    if (Array.isArray(value)) {
      return value.map((item) => visit(item, resolvingReferences))
    }

    if (!isRecord(value)) {
      return value
    }

    const reference = value.$ref
    if (typeof reference === 'string') {
      const siblings = Object.fromEntries(
        Object.entries(value).filter(([key]) => key !== '$ref'),
      )
      if (resolvingReferences.has(reference)) {
        return visit({ type: 'object', ...siblings }, resolvingReferences)
      }

      const resolved = resolveGeminiSchemaReference(schema, reference)
      if (resolved !== undefined) {
        const nextReferences = new Set(resolvingReferences)
        nextReferences.add(reference)
        return visit(
          isRecord(resolved) ? { ...resolved, ...siblings } : siblings,
          nextReferences,
        )
      }
    }

    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => preserveObjectKeys || GEMINI_SCHEMA_ALLOWED_KEYS.has(key))
        .map(([key, child]) => [
          key,
          visit(child, resolvingReferences, key === 'properties'),
        ]),
    )
  }

  return visit(schema, new Set()) as Record<string, unknown>
}

function getGeminiTools(
  functionDeclarations: Array<Record<string, unknown>> | undefined,
): Array<Record<string, unknown>> | undefined {
  if (functionDeclarations === undefined) {
    return undefined
  }

  return [{ functionDeclarations }]
}

const GEMINI_3_THINKING_LEVELS = new Set(['minimal', 'low', 'medium', 'high'])

function getGeminiGenerationConfig(
  model: string,
  thinkingEnabled: boolean | undefined,
  traitValues?: Record<string, string | boolean>,
): Record<string, unknown> | undefined {
  if (model.startsWith('gemini-3')) {
    const selectedLevel = traitValues?.thinkingLevel
    const thinkingLevel = typeof selectedLevel === 'string'
      && GEMINI_3_THINKING_LEVELS.has(selectedLevel)
      ? selectedLevel
      : 'high'

    return {
      thinkingConfig: { thinkingLevel },
    }
  }

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
    logCliEffortEvidence(providerKey, model, input.traitValues)

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
    const reasoningParams = getOpenAiReasoningParams(
      input.providerKey,
      model,
      input.llm?.thinkingEnabled,
      getEffortTrait(input.traitValues),
    )
    if (shouldUseOpenAiResponsesApi(input.providerKey, model, tools, reasoningParams)) {
      return await this.chatOpenAiResponses({
        ...input,
        apiKey,
        baseUrl,
        model,
        reasoningEffort: reasoningParams.reasoning_effort,
      })
    }
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

    const endpoint = getRequestEndpoint(`${baseUrl}/chat/completions`)
    const requestBody = {
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
      ...reasoningParams,
    }
    const serializedRequestBody = JSON.stringify(requestBody)
    logEffortEvidence(input.providerKey, model, endpoint, serializedRequestBody)

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: serializedRequestBody,
      signal,
    })

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(formatProviderHttpError('LLM', response, body))
    }

    if (response.body !== null && hasEventStreamContentType(response)) {
      return this.readOpenAiStreamingResponse(response.body, onDelta)
    }

    return this.readOpenAiCompletionResponse(response)
  }

  private async chatOpenAiResponses(input: ChatWithToolsInput & {
    providerKey: LlmProviderKey
    apiKey: string
    baseUrl: string
    model: string
    reasoningEffort: string
  }): Promise<ChatResponse> {
    const { messages, tools, signal, apiKey, baseUrl, model, reasoningEffort } = input
    const endpoint = getRequestEndpoint(`${baseUrl}/responses`)
    const requestBody = {
      model,
      stream: false,
      input: toOpenAiResponsesInput(messages),
      tools: tools?.map((tool) => ({
        type: 'function' as const,
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      })),
      reasoning: { effort: reasoningEffort },
      max_output_tokens: 4096,
    }
    const serializedRequestBody = JSON.stringify(requestBody)
    logEffortEvidence(input.providerKey, model, endpoint, serializedRequestBody)
    const response = await fetch(`${baseUrl}/responses`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: serializedRequestBody,
      signal,
    })

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(formatProviderHttpError('LLM', response, body))
    }

    return this.readOpenAiResponsesResponse(response)
  }

  private async readOpenAiStreamingResponse(body: ReadableStream<Uint8Array>, onDelta: OnDelta | undefined): Promise<ChatResponse> {
    const state: {
      content: string
      tokenUsage: ChatResponse['tokenUsage']
      toolCallsByIndex: Map<number, OpenAiStreamingToolCallFragment>
    } = { content: '', tokenUsage: undefined, toolCallsByIndex: new Map() }
    for await (const event of iterateSseEvents(body)) {
      if (event.data === '[DONE]') break
      this.applyOpenAiStreamEvent(event, state, onDelta)
    }
    return {
      content: state.content,
      toolCalls: this.buildOpenAiStreamingToolCalls(state.toolCallsByIndex),
      toolProtocol: 'native_function_calling',
      tokenUsage: state.tokenUsage,
    }
  }

  private applyOpenAiStreamEvent(
    event: SseEvent,
    state: { content: string; tokenUsage: ChatResponse['tokenUsage']; toolCallsByIndex: Map<number, OpenAiStreamingToolCallFragment> },
    onDelta: OnDelta | undefined,
  ): void {
    let chunk: OpenAiStreamingChunk
    try {
      chunk = JSON.parse(event.data) as OpenAiStreamingChunk
    } catch {
      return
    }
    const usage = chunk.usage
    if (usage?.prompt_tokens != null) {
      state.tokenUsage = { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens ?? 0 }
    }
    for (const choice of chunk.choices ?? []) {
      this.applyOpenAiStreamDelta(choice.delta, state, onDelta)
    }
  }

  private applyOpenAiStreamDelta(
    delta: OpenAiStreamingDelta | undefined,
    state: { content: string; toolCallsByIndex: Map<number, OpenAiStreamingToolCallFragment> },
    onDelta: OnDelta | undefined,
  ): void {
    const deltaContent = delta?.content
    if (deltaContent !== undefined && deltaContent !== null && deltaContent.length > 0) {
      state.content += deltaContent
      onDelta?.({ type: 'text', text: deltaContent })
    }
    for (const partialToolCall of delta?.tool_calls ?? []) {
      const index = partialToolCall.index ?? 0
      const existing = state.toolCallsByIndex.get(index) ?? { argumentsText: '' }
      if (partialToolCall.id !== undefined && partialToolCall.id.length > 0) existing.id = partialToolCall.id
      if (partialToolCall.function?.name !== undefined && partialToolCall.function.name.length > 0) existing.name = partialToolCall.function.name
      if (partialToolCall.function?.arguments !== undefined && partialToolCall.function.arguments.length > 0) existing.argumentsText += partialToolCall.function.arguments
      state.toolCallsByIndex.set(index, existing)
    }
  }

  private buildOpenAiStreamingToolCalls(toolCallsByIndex: Map<number, OpenAiStreamingToolCallFragment>): ToolCall[] {
    return [...toolCallsByIndex.entries()]
      .sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
      .flatMap(([index, toolCall]) => {
        if (toolCall.name === undefined || toolCall.name.length === 0) return []
        const parsed = createNativeToolCall({
          id: toolCall.id ?? `openai_${String(Date.now())}_${String(index)}`,
          name: toolCall.name,
          args: parseJsonObject(toolCall.argumentsText, `OpenAI tool arguments for ${toolCall.name}`),
        }, 'OpenAI')
        return parsed === null ? [] : [parsed]
      })
  }

  private async readOpenAiCompletionResponse(response: Response): Promise<ChatResponse> {
    const data = await response.json() as OpenAiCompletionPayload

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

  private async readOpenAiResponsesResponse(response: Response): Promise<ChatResponse> {
    const data = await response.json() as OpenAiResponsesPayload
    const output = data.output ?? []
    const toolCalls = output
      .filter((item) => item.type === 'function_call' && item.name !== undefined)
      .map((item, index) => createNativeToolCall({
        id: item.call_id ?? item.id ?? `openai_response_${String(index)}`,
        name: item.name,
        args: parseJsonObject(item.arguments ?? '', `OpenAI Responses tool arguments for ${item.name}`),
      }, 'OpenAI Responses'))
      .filter((toolCall): toolCall is ToolCall => toolCall !== null)

    const outputText = data.output_text ?? output
      .filter((item) => item.type === 'message')
      .flatMap((item) => item.content ?? [])
      .filter((item) => item.type === 'output_text')
      .map((item) => item.text ?? '')
      .join('')

    return {
      content: outputText,
      toolCalls,
      toolProtocol: 'native_function_calling',
      tokenUsage: toTokenUsage(data.usage?.input_tokens, data.usage?.output_tokens),
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

    const endpoint = getRequestEndpoint(`${baseUrl}/v1/messages`)
    const requestBody = {
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
          const text = normalizeTextContent(m.content)
          return {
            role: m.role,
            content: [
              ...(text.length > 0 ? [{ type: 'text', text }] : []),
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
      ...getAnthropicThinkingConfig(
        model,
        input.llm?.thinkingEnabled,
        getEffortTrait(input.traitValues),
      ),
    }
    const serializedRequestBody = JSON.stringify(requestBody)
    logEffortEvidence('anthropic', model, endpoint, serializedRequestBody)

    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: serializedRequestBody,
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
          const text = normalizeTextContent(m.content)
          const parts: Array<Record<string, unknown>> = []
          if (text.length > 0) {
            parts.push({ text })
          }
          parts.push(...m.toolCalls.map(tc => ({
            functionCall: {
              name: tc.name,
              args: tc.args,
            },
            ...(tc.thoughtSignature !== undefined
              ? { thoughtSignature: tc.thoughtSignature }
              : {}),
          })))
          return {
            role: 'model' as const,
            parts,
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
      parameters: sanitizeGeminiSchema(tool.inputSchema),
    }))

    const endpoint = `/v1beta/models/${model}:generateContent`
    const requestBody = {
      systemInstruction: getGeminiSystemInstruction(systemInstruction),
      contents,
      tools: getGeminiTools(functionDeclarations),
      generationConfig: getGeminiGenerationConfig(
        model,
        input.llm?.thinkingEnabled,
        input.traitValues,
      ),
    }
    const serializedRequestBody = JSON.stringify(requestBody)
    logEffortEvidence('gemini', model, endpoint, serializedRequestBody)

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: serializedRequestBody,
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
            thoughtSignature?: string
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
          thoughtSignature: part.thoughtSignature,
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
