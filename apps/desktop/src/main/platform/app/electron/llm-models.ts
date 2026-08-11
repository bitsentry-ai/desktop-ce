export type DesktopManagedLlmProviderKey =
  | 'groq'
  | 'kilocode'
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'openrouter'

export interface DesktopManagedLlmListModelsConfig {
  apiKey?: string
  baseUrl?: string
}

export interface DesktopManagedLlmListModelsResult {
  providerKey: DesktopManagedLlmProviderKey
  models: string[]
  count: number
  fetchedAt: string
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function trimTrailingSlash(value: string): string {
  let end = value.length
  while (end > 0 && value[end - 1] === '/') end -= 1
  return value.slice(0, end)
}

function dedupeModels(models: string[]): string[] {
  return Array.from(new Set(models.map((model) => model.trim()).filter(Boolean)))
    .sort((left, right) => left.localeCompare(right))
}

function normalizeProviderKey(value: string): DesktopManagedLlmProviderKey | null {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'grok') return 'groq'
  if (
    normalized === 'groq' ||
    normalized === 'kilocode' ||
    normalized === 'openai' ||
    normalized === 'anthropic' ||
    normalized === 'gemini' ||
    normalized === 'openrouter'
  ) {
    return normalized
  }
  return null
}

function readErrorMessage(rawBody: string, fallback: string): string {
  if (rawBody.length === 0) return fallback
  try {
    const payload = readRecord(JSON.parse(rawBody))
    const error = readRecord(payload?.error)
    return readString(error?.message) || readString(payload?.message) || fallback
  } catch {
    return fallback
  }
}

async function fetchJson(
  url: string,
  init: RequestInit,
  fallbackError: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(20_000),
  })
  const rawBody = await response.text().catch(() => '')
  if (!response.ok) throw new Error(readErrorMessage(rawBody, fallbackError))
  if (rawBody.length === 0) return {}
  try {
    return readRecord(JSON.parse(rawBody)) ?? {}
  } catch {
    throw new Error('Provider returned invalid JSON')
  }
}

async function listOpenAiCompatibleModels(
  url: string,
  headers: Record<string, string>,
): Promise<string[]> {
  const payload = await fetchJson(url, { method: 'GET', headers }, 'Failed to load model list')
  return readArray(payload.data)
    .map((entry) => readString(readRecord(entry)?.id))
    .filter(Boolean)
}

async function listGeminiModels(baseUrl: string, apiKey: string): Promise<string[]> {
  const root = trimTrailingSlash(
    baseUrl.length > 0 ? baseUrl : 'https://generativelanguage.googleapis.com',
  ).replace(/\/v1beta$/i, '')
  const models: string[] = []
  let nextPageToken = ''
  let attempts = 0

  while (attempts < 20) {
    attempts += 1
    const query = new URLSearchParams({ pageSize: '1000', key: apiKey })
    if (nextPageToken.length > 0) query.set('pageToken', nextPageToken)
    const payload = await fetchJson(
      `${root}/v1beta/models?${query.toString()}`,
      { method: 'GET' },
      'Failed to load Gemini models',
    )
    for (const entry of readArray(payload.models)) {
      const model = readRecord(entry)
      const methods = readArray(model?.supportedGenerationMethods).map(readString)
      if (!methods.includes('generateContent') && !methods.includes('streamGenerateContent')) continue
      const name = readString(model?.name)
      if (name.length > 0) models.push(name.replace(/^models\//, ''))
    }
    nextPageToken = readString(payload.nextPageToken)
    if (nextPageToken.length === 0) break
  }

  return models
}

async function listAnthropicModels(baseUrl: string, apiKey: string): Promise<string[]> {
  const root = trimTrailingSlash(
    baseUrl.length > 0 ? baseUrl : 'https://api.anthropic.com',
  ).replace(/\/v1$/i, '')
  const models: string[] = []
  let afterId = ''
  let attempts = 0

  while (attempts < 20) {
    attempts += 1
    const query = new URLSearchParams({ limit: '1000' })
    if (afterId.length > 0) query.set('after_id', afterId)
    const payload = await fetchJson(
      `${root}/v1/models?${query.toString()}`,
      {
        method: 'GET',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
      },
      'Failed to load Anthropic models',
    )
    for (const entry of readArray(payload.data)) {
      const modelId = readString(readRecord(entry)?.id)
      if (modelId.length > 0) models.push(modelId)
    }
    const lastId = readString(payload.last_id)
    if (payload.has_more !== true || lastId.length === 0 || readArray(payload.data).length === 0) break
    afterId = lastId
  }

  return models
}

export async function listDesktopManagedModels(
  rawProviderKey: string,
  config: DesktopManagedLlmListModelsConfig = {},
): Promise<DesktopManagedLlmListModelsResult> {
  const providerKey = normalizeProviderKey(rawProviderKey)
  if (providerKey === null) throw new Error(`Unknown provider: ${rawProviderKey}`)

  const apiKey = config.apiKey?.trim() ?? ''
  const baseUrl = config.baseUrl?.trim() ?? ''
  let models: string[]

  switch (providerKey) {
    case 'kilocode': {
      const root = trimTrailingSlash(baseUrl || 'https://api.kilo.ai/api/gateway')
      const headers: Record<string, string> = {}
      if (apiKey.length > 0) headers.Authorization = `Bearer ${apiKey}`
      models = await listOpenAiCompatibleModels(`${root}/models`, headers)
      break
    }
    case 'openai': {
      if (apiKey.length === 0) throw new Error('OpenAI API key is required')
      const root = trimTrailingSlash(baseUrl || 'https://api.openai.com/v1')
      models = await listOpenAiCompatibleModels(`${root}/models`, { Authorization: `Bearer ${apiKey}` })
      break
    }
    case 'groq': {
      if (apiKey.length === 0) throw new Error('Groq API key is required')
      const root = trimTrailingSlash(baseUrl || 'https://api.groq.com/openai/v1')
      models = await listOpenAiCompatibleModels(`${root}/models`, { Authorization: `Bearer ${apiKey}` })
      break
    }
    case 'openrouter': {
      const root = trimTrailingSlash(baseUrl || 'https://openrouter.ai/api/v1')
      const headers: Record<string, string> = {}
      if (apiKey.length > 0) {
        headers.Authorization = `Bearer ${apiKey}`
        headers['HTTP-Referer'] = 'https://desktop.bitsentry.ai'
        headers['X-Title'] = 'BitSentry Desktop'
      }
      models = await listOpenAiCompatibleModels(`${root}/models`, headers)
      break
    }
    case 'gemini': {
      if (apiKey.length === 0) throw new Error('Gemini API key is required')
      models = await listGeminiModels(baseUrl, apiKey)
      break
    }
    case 'anthropic': {
      if (apiKey.length === 0) throw new Error('Anthropic API key is required')
      models = await listAnthropicModels(baseUrl, apiKey)
      break
    }
  }

  const normalizedModels = dedupeModels(models)
  return {
    providerKey,
    models: normalizedModels,
    count: normalizedModels.length,
    fetchedAt: new Date().toISOString(),
  }
}

export interface DesktopManagedLlmIpcMain {
  handle(channel: string, listener: (...args: unknown[]) => unknown): void
}

export function registerDesktopManagedLlmModelHandler(ipcMain: DesktopManagedLlmIpcMain): void {
  ipcMain.handle(
    'bitsentry:llm:listModels',
    async (_event, rawProviderKey: unknown, config: unknown = {}) => {
      if (typeof rawProviderKey !== 'string') {
        throw new Error('Provider key is required')
      }
      const input = readRecord(config)
      return listDesktopManagedModels(rawProviderKey, {
        apiKey: readString(input?.apiKey),
        baseUrl: readString(input?.baseUrl),
      })
    },
  )
}
