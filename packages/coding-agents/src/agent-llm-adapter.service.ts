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
  structuredCliToolResponseSchema,
  type AgentToolCall,
  type AgentToolProtocol,
  type AgentToolResultEnvelope,
} from '@bitsentry-ce/core/features/agent-runtime'
import log from 'electron-log'

export type LlmProviderKey = 'groq' | 'kilocode' | 'openai' | 'anthropic' | 'gemini' | 'openrouter' | 'claude_code' | 'codex' | 'opencode' | 'cursor'

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
  /**
   * An opt-in capability boundary. A CLI may return native structured calls in
   * LocalAiExecutionResult.toolCalls; otherwise its complete JSON compatibility
   * envelope is validated before the runtime sees a host operation.
   */
  getHostToolProtocol?(provider: LocalAiProviderKey): 'structured_cli'
  execute(
    provider: LocalAiProviderKey,
    prompt: string,
    abortController: AbortController,
    onDelta?: (delta: LocalAiStreamDelta) => void,
    cwd?: string,
    model?: string,
    accessLevel?: 'supervised' | 'auto-accept-edits' | 'full-access',
    traitValues?: Record<string, string | boolean>,
  ): Promise<LocalAiExecutionResult>
}

type LocalAiAccessLevel = Parameters<LocalAiProviderPort['execute']>[6]

function resolveAgentLocalAiAccessLevel(
  providerKey: LocalAiProviderKey,
  accessLevel: LocalAiAccessLevel,
): LocalAiAccessLevel {
  if (
    (providerKey === 'codex' ||
      providerKey === 'opencode' ||
      providerKey === 'cursor') &&
    (accessLevel === undefined || accessLevel === 'supervised')
  ) {
    return 'auto-accept-edits'
  }

  return accessLevel
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
  accessLevel?: 'supervised' | 'auto-accept-edits' | 'full-access'
  traitValues?: Record<string, string | boolean>
}

/**
 * LLM chat response.
 */
export interface ChatResponse {
  content: string
  toolCalls?: ToolCall[]
  toolProtocol: AgentToolProtocol
  hasForeignToolCallMarkup?: boolean
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

const CLI_TRANSCRIPT_BLOCK_START_PREFIXES = [
  'Internal tool result for ',
  'Internal tool result:',
] as const
const CLI_TRANSCRIPT_BLOCK_END_LINES = new Set([
  'Do not repeat raw JSON, wrapper tags, or transcript labels unless the user explicitly asks for raw output.',
  'Do not echo raw JSON, transcript labels, or internal wrapper syntax unless the user explicitly asks for raw output.',
])
const CLI_TRANSCRIPT_STANDALONE_LINES = new Set([
  'Internal execution result:',
  'Use this result as internal context.',
  'Summarize the useful findings for the user in clean Markdown.',
  'Summarize the important findings for the user in clean Markdown.',
  ...CLI_TRANSCRIPT_BLOCK_END_LINES,
])
const HIDDEN_HOST_BLOCKS = [
  {
    openPrefix: '<bitsentry_tool_result',
    closeTag: '</bitsentry_tool_result>',
  },
  {
    openPrefix: '<bitsentry_host_instruction',
    closeTag: '</bitsentry_host_instruction>',
  },
  {
    openPrefix: '<bitsentry_host_protocol',
    closeTag: '</bitsentry_host_protocol>',
  },
  {
    openPrefix: '<function_calls',
    closeTag: '</function_calls>',
  },
  {
    openPrefix: '<invoke',
    closeTag: '</invoke>',
  },
  {
    openPrefix: '<tool_use',
    closeTag: '</tool_use>',
  },
] as const

const FOREIGN_TOOL_CALL_MARKUP = /<\s*(?:function_calls|invoke|tool_use)\b/i

function stripInternalHostMarkup(value: string): string {
  let sanitized = value
  for (const block of HIDDEN_HOST_BLOCKS) {
    const escapedOpenPrefix = block.openPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const escapedCloseTag = block.closeTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    sanitized = sanitized.replace(
      new RegExp(`${escapedOpenPrefix}[^>]*>[\\s\\S]*?${escapedCloseTag}\\s*`, 'gi'),
      '\n\n',
    )
    sanitized = sanitized.replace(
      new RegExp(`${escapedOpenPrefix}\\b[\\s\\S]*$`, 'gi'),
      '\n\n',
    )
  }
  return sanitized
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function shouldStartCliTranscriptBlock(line: string): boolean {
  return CLI_TRANSCRIPT_BLOCK_START_PREFIXES.some((prefix) => line.startsWith(prefix))
}

function shouldStripCliTranscriptStandaloneLine(line: string): boolean {
  return CLI_TRANSCRIPT_STANDALONE_LINES.has(line)
}

function normalizeVisibleCliText(value: string): string {
  return value
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
}

function createCliTranscriptBoilerplateSanitizer(): {
  push(chunk: string): string
  flush(): string
} {
  let buffer = ''
  let skippingTranscriptBlock = false
  let pendingLineBreak = false

  const processLine = (line: string): string | null => {
    if (skippingTranscriptBlock) {
      if (CLI_TRANSCRIPT_BLOCK_END_LINES.has(line)) {
        skippingTranscriptBlock = false
      }
      return null
    }

    if (shouldStartCliTranscriptBlock(line)) {
      skippingTranscriptBlock = true
      return null
    }

    if (shouldStripCliTranscriptStandaloneLine(line)) {
      return null
    }

    return line
  }

  const couldBeCliTranscriptPartialLine = (line: string): boolean => {
    if (line.length === 0) return false
    if (shouldStartCliTranscriptBlock(line)) return true

    for (const prefix of CLI_TRANSCRIPT_BLOCK_START_PREFIXES) {
      if (prefix.startsWith(line)) return true
    }

    for (const transcriptLine of CLI_TRANSCRIPT_STANDALONE_LINES) {
      if (transcriptLine.startsWith(line) || line.startsWith(transcriptLine)) {
        return true
      }
    }

    return false
  }

  const appendVisibleSegment = (current: string, segment: string): string => {
    if (pendingLineBreak) {
      current += '\n'
      pendingLineBreak = false
    }

    if (segment.length === 0) {
      return current
    }

    return current + segment
  }

  const drain = (flush: boolean): string => {
    let visible = ''

    for (;;) {
      const newlineIndex = buffer.indexOf('\n')
      if (newlineIndex === -1) break

      const line = buffer.slice(0, newlineIndex)
      buffer = buffer.slice(newlineIndex + 1)

      const nextLine = processLine(line)
      if (nextLine !== null) {
        visible = appendVisibleSegment(visible, nextLine)
        pendingLineBreak = true
      }
    }

    if (flush) {
      if (buffer.length > 0) {
        const finalLine = processLine(buffer)
        if (finalLine !== null) {
          visible = appendVisibleSegment(visible, finalLine)
        }
      }
      buffer = ''
      return normalizeVisibleCliText(visible).trim()
    }

    if (!skippingTranscriptBlock && buffer.length > 0 && !couldBeCliTranscriptPartialLine(buffer)) {
      visible = appendVisibleSegment(visible, buffer)
      buffer = ''
    }

    return normalizeVisibleCliText(visible)
  }

  return {
    push(chunk: string): string {
      buffer += chunk
      return drain(false)
    },
    flush(): string {
      return drain(true)
    },
  }
}

function stripCliTranscriptBoilerplate(value: string): string {
  const sanitizer = createCliTranscriptBoilerplateSanitizer()
  const visible = sanitizer.push(value) + sanitizer.flush()
  return normalizeVisibleCliText(visible).trim()
}
function formatToolResultTranscript(m: ChatMessage): string {
  let content = stripInternalHostMarkup(normalizeTextContent(m.content))
  if (content.length === 0) {
    content = normalizeTextContent(m.content).trim()
  }
  if (content.length === 0) {
    content = 'Tool execution completed'
  }

  let toolLabel = 'Internal tool result:'
  if (m.toolCallId !== undefined && m.toolCallId.length > 0) {
    toolLabel = `Internal tool result for ${m.toolCallId}:`
  }
  return [
    toolLabel,
    content,
    'Use this result as internal context.',
    'Summarize the important findings for the user in clean Markdown.',
    'Do not repeat raw JSON, wrapper tags, or transcript labels unless the user explicitly asks for raw output.',
  ].join('\n')
}

function formatAssistantToolCallTranscript(m: ChatMessage): string {
  let body = ''
  if (typeof m.content === 'string') {
    body = stripInternalHostMarkup(m.content)
  }
  const toolRequests = (m.toolCalls ?? [])
    .map((tc) => `Assistant requested host tool ${tc.name} (${tc.id}) with args: ${JSON.stringify(tc.args)}`)
    .join('\n')
  let separator = ''
  if (body.length > 0 && toolRequests.length > 0) {
    separator = '\n'
  }
  return `[${m.role}]: ${body}${separator}${toolRequests}`.trim()
}

function buildStructuredCliToolsPrompt(tools: LlmToolDefinition[]): string {
  if (tools.length === 0) return ''

  const toolDocs = tools.map((tool) => {
    const schemaJson = JSON.stringify(tool.inputSchema, null, 2)
    return `### ${tool.name}\n${tool.description}\nInput schema:\n\`\`\`json\n${schemaJson}\n\`\`\``
  }).join('\n\n')

  return `\n\nBitSentry host tool protocol:
You are running inside BitSentry SuperTerminal, an incident-response desktop application.
You do NOT have these operations available as native tools. Instead, request them through the host.

When you want to call an operation, respond with exactly one JSON document and nothing else:

{"version":1,"type":"tool_calls","toolCalls":[{"id":"<unique_string>","name":"<operation_name>","args":{<args per schema>}}]}

The host will execute the operation and append the result as a later tool message in the conversation.
Treat tool messages as INTERNAL context. Summarize the useful findings for the user.
Do NOT wrap the JSON in Markdown or XML. Do not add prose before or after it.
Never simulate or invent tool results. Never invent runbook titles, runbook IDs, execution IDs, logs, or server output.
If you need real data, call the operation and wait for the returned tool result message.
After receiving the result, you may call another operation or give your final answer.
Call one operation at a time. Do not guess — if you need runbook data, request it first.

AVAILABLE OPERATIONS:

${toolDocs}`
}

function flattenMessageText(m: ChatMessage): string {
  if (m.role === 'tool') {
    return formatToolResultTranscript(m)
  }
  if (m.toolCalls !== undefined && m.toolCalls.length > 0) {
    return formatAssistantToolCallTranscript(m)
  }
  if (typeof m.content === 'string') return `[${m.role}]: ${stripInternalHostMarkup(m.content)}`
  if (Array.isArray(m.content)) {
    const text = m.content
      .filter((part): part is Extract<ChatContentPart, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
    return `[${m.role}]: ${stripInternalHostMarkup(text)}`
  }
  return `[${m.role}]: `
}

function parseStructuredCliToolResponse(text: string): { content: string; toolCalls: ToolCall[] } {
  try {
    const parsed = structuredCliToolResponseSchema.safeParse(JSON.parse(text.trim()) as unknown)
    if (parsed.success) {
      return { content: parsed.data.content ?? '', toolCalls: parsed.data.toolCalls }
    }
  } catch {
    // Natural-language output is a final response, not a host call.
  }
  return { content: text, toolCalls: [] }
}

function parseStructuredToolCalls(toolCalls: ToolCall[] | undefined): ToolCall[] {
  if (toolCalls === undefined) return []

  return toolCalls.flatMap((toolCall) => {
    const parsed = agentToolCallSchema.safeParse(toolCall)
    if (parsed.success) return [parsed.data]
    log.warn('[agent-llm] Ignoring invalid structured CLI host tool call')
    return []
  })
}

function createNativeToolCall(value: unknown, providerLabel: string): ToolCall | null {
  const parsed = agentToolCallSchema.safeParse(value)
  if (parsed.success) return parsed.data
  log.warn(`[agent-llm] Ignoring invalid ${providerLabel} native tool call`)
  return null
}

function createStructuredCliResponseStreamSanitizer(): TextSanitizer {
  let buffered = ''
  let mode: 'undecided' | 'structured_response' | 'text' = 'undecided'
  const hostMarkupSanitizer = createHiddenHostMarkupStreamSanitizer()
  const structuredPrefix = '{"version":'

  return {
    push(chunk: string): string {
      if (mode === 'structured_response') {
        buffered += chunk
        return ''
      }

      if (mode === 'text') {
        return hostMarkupSanitizer.push(chunk)
      }

      buffered += chunk
      const trimmed = buffered.trimStart()
      if (structuredPrefix.startsWith(trimmed)) {
        return ''
      }

      if (trimmed.startsWith(structuredPrefix)) {
        mode = 'structured_response'
        return ''
      }

      mode = 'text'
      const visible = hostMarkupSanitizer.push(buffered)
      buffered = ''
      return visible
    },
    flush(): string {
      if (mode === 'structured_response') {
        const parsed = parseStructuredCliToolResponse(buffered)
        if (parsed.toolCalls.length > 0) {
          return ''
        }
        return hostMarkupSanitizer.push(buffered) + hostMarkupSanitizer.flush()
      }

      if (mode === 'undecided' && buffered.length > 0) {
        hostMarkupSanitizer.push(buffered)
      }
      return hostMarkupSanitizer.flush()
    },
  }
}

function createHiddenHostMarkupStreamSanitizer(): {
  push(chunk: string): string
  flush(): string
} {
  let buffer = ''
  let activeHiddenBlock: (typeof HIDDEN_HOST_BLOCKS)[number] | null = null
  let pendingVisibleBreak = false

  const findPartialTagSuffixStart = (value: string, candidates: string[]): number => {
    let bestStart = value.length
    for (const tag of candidates) {
      const maxLength = Math.min(value.length, tag.length - 1)
      for (let length = maxLength; length > 0; length -= 1) {
        if (tag.startsWith(value.slice(-length))) {
          bestStart = Math.min(bestStart, value.length - length)
          break
        }
      }
    }
    return bestStart
  }

  // eslint-disable-next-line sonarjs/cognitive-complexity -- Host-tool tag stripping needs stateful partial-tag handling.
  const drain = (flush: boolean): string => {
    let visible = ''

    while (buffer.length > 0) {
      if (activeHiddenBlock !== null) {
        const closeIndex = buffer.indexOf(activeHiddenBlock.closeTag)
        if (closeIndex === -1) {
          if (flush) {
            buffer = ''
          } else {
            buffer = buffer.slice(
              findPartialTagSuffixStart(buffer, [activeHiddenBlock.closeTag]),
            )
          }
          break
        }

        buffer = buffer.slice(closeIndex + activeHiddenBlock.closeTag.length)
        activeHiddenBlock = null
        pendingVisibleBreak = true
        continue
      }

      let nextBlock: (typeof HIDDEN_HOST_BLOCKS)[number] | null = null
      let openIndex = -1
      for (const block of HIDDEN_HOST_BLOCKS) {
        const index = buffer.indexOf(block.openPrefix)
        if (index !== -1 && (openIndex === -1 || index < openIndex)) {
          openIndex = index
          nextBlock = block
        }
      }

      if (openIndex === -1 || nextBlock === null) {
        let visiblePrefix = ''
        if (pendingVisibleBreak && buffer.length > 0 && !buffer.startsWith('\n')) {
          visiblePrefix = '\n\n'
        }
        if (flush) {
          visible += visiblePrefix + buffer
          pendingVisibleBreak = false
          buffer = ''
        } else {
          const partialSuffixStart = findPartialTagSuffixStart(
            buffer,
            HIDDEN_HOST_BLOCKS.map(block => block.openPrefix),
          )
          const nextVisibleChunk = buffer.slice(0, partialSuffixStart)
          if (nextVisibleChunk.length > 0) {
            visible += visiblePrefix + nextVisibleChunk
            pendingVisibleBreak = false
          }
          buffer = buffer.slice(partialSuffixStart)
        }
        break
      }

      const nextVisibleChunk = buffer.slice(0, openIndex)
      if (nextVisibleChunk.length > 0) {
        let visiblePrefix = ''
        if (pendingVisibleBreak && !nextVisibleChunk.startsWith('\n')) {
          visiblePrefix = '\n\n'
        }
        visible += visiblePrefix + nextVisibleChunk
        pendingVisibleBreak = false
      }
      const tagEndIndex = buffer.indexOf('>', openIndex)
      if (tagEndIndex === -1) {
        if (flush) {
          buffer = ''
        } else {
          buffer = buffer.slice(openIndex)
        }
        break
      }
      buffer = buffer.slice(tagEndIndex + 1)
      activeHiddenBlock = nextBlock
    }

    return visible
  }

  return {
    push(chunk: string): string {
      buffer += chunk
      return drain(false)
    },
    flush(): string {
      return drain(true)
    },
  }
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

interface TextSanitizer {
  push(chunk: string): string
  flush(): string
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

function sanitizeLocalProviderOutput(providerKey: LocalAiProviderKey, text: string): string {
  const withoutHostMarkup = stripInternalHostMarkup(text)
  if (providerKey === 'claude_code') {
    return stripCliTranscriptBoilerplate(withoutHostMarkup)
  }
  return withoutHostMarkup
}

function hasForeignToolCallMarkup(text: string): boolean {
  return FOREIGN_TOOL_CALL_MARKUP.test(text)
}

function createLocalAiDeltaHandler(
  onDelta: OnDelta | undefined,
  streamSanitizer: TextSanitizer,
  cliTranscriptSanitizer: TextSanitizer | null,
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

    const visibleText = streamSanitizer.push(delta.text)
    if (visibleText.length === 0) {
      return
    }

    let cleanedText = visibleText
    if (cliTranscriptSanitizer !== null) {
      cleanedText = cliTranscriptSanitizer.push(visibleText)
    }
    emitTextDelta(onDelta, cleanedText)
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

    // In supervised mode, omit the host-operation contract altogether so a CLI
    // response cannot request an operation outside the selected access level.
    const isSupervised = accessLevel === 'supervised' || accessLevel === undefined
    const toolProtocol = isSupervised
      ? 'none'
      : this.localAiProvider.getHostToolProtocol?.(providerKey) ?? 'structured_cli'
    const streamSanitizer = toolProtocol === 'structured_cli'
      ? createStructuredCliResponseStreamSanitizer()
      : createHiddenHostMarkupStreamSanitizer()
    let cliTranscriptSanitizer: TextSanitizer | null = null
    if (providerKey === 'claude_code') {
      cliTranscriptSanitizer = createCliTranscriptBoilerplateSanitizer()
    }

    try {
      const result = await this.localAiProvider.execute(
        providerKey,
        this.buildLocalAiPrompt(input, isSupervised),
        abortController,
        createLocalAiDeltaHandler(input.onDelta, streamSanitizer, cliTranscriptSanitizer),
        undefined,
        model,
        accessLevel,
        input.traitValues,
      )

      this.flushLocalAiStream(input.onDelta, streamSanitizer, cliTranscriptSanitizer)
      this.emitLocalAiTokenUsage(input.onDelta, result)
      return this.toLocalAiChatResponse(providerKey, result, toolProtocol)
    } finally {
      input.signal.removeEventListener('abort', onAbort)
    }
  }

  private buildLocalAiPrompt(
    input: ChatWithToolsInput,
    isSupervised: boolean,
  ): string {
    // Each turn runs as a fresh CLI subprocess. The full BitSentry transcript is
    // replayed explicitly so CLI-native session state cannot leak across runs.
    const conversationText = input.messages.map(flattenMessageText).join('\n')
    if (isSupervised) {
      return conversationText
    }
    return conversationText + buildStructuredCliToolsPrompt(input.tools ?? [])
  }

  private flushLocalAiStream(
    onDelta: OnDelta | undefined,
    streamSanitizer: TextSanitizer,
    cliTranscriptSanitizer: TextSanitizer | null,
  ): void {
    const trailingVisibleText = streamSanitizer.flush()
    if (trailingVisibleText.length > 0) {
      let cleanedTrailingText = trailingVisibleText
      if (cliTranscriptSanitizer !== null) {
        cleanedTrailingText = cliTranscriptSanitizer.push(trailingVisibleText)
      }
      emitTextDelta(onDelta, cleanedTrailingText)
    }

    const trailingCleanedTranscriptText = cliTranscriptSanitizer?.flush()
    if (trailingCleanedTranscriptText !== undefined) {
      emitTextDelta(onDelta, trailingCleanedTranscriptText)
    }
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
    providerKey: LocalAiProviderKey,
    result: LocalAiExecutionResult,
    toolProtocol: AgentToolProtocol,
  ): ChatResponse {
    const foreignToolCallMarkup = hasForeignToolCallMarkup(result.output)
    if (toolProtocol === 'none') {
      return {
        content: sanitizeLocalProviderOutput(providerKey, result.output),
        toolCalls: [],
        toolProtocol,
        hasForeignToolCallMarkup: foreignToolCallMarkup,
        tokenUsage: result.tokenUsage,
      }
    }

    if (toolProtocol === 'structured_cli') {
      const structuredResponse = result.toolCalls === undefined
        ? parseStructuredCliToolResponse(result.output)
        : null
      return {
        content: sanitizeLocalProviderOutput(providerKey, structuredResponse?.content ?? result.output),
        toolCalls: structuredResponse?.toolCalls ?? parseStructuredToolCalls(result.toolCalls),
        toolProtocol,
        hasForeignToolCallMarkup: foreignToolCallMarkup,
        tokenUsage: result.tokenUsage,
      }
    }

    throw new Error(`Unsupported local tool protocol: ${toolProtocol}`)
  }

  /**
   * OpenAI-compatible chat (OpenRouter, Groq, OpenAI).
   */
  // eslint-disable-next-line sonarjs/cognitive-complexity -- OpenAI streaming combines text, usage, and incremental tool-call assembly.
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
