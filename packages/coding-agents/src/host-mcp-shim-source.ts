// Source of the stdio-to-HTTP MCP shim spawned by CLI providers (Codex,
// Cursor, OpenCode). Kept as an embedded string because the desktop app's
// main bundle cannot ship adjacent script files: electron-vite folds this
// package into out/main and a packaged app serves code from an asar archive,
// which external CLI processes cannot spawn from. The endpoint writes this
// source to a real file on disk at session start and hands CLIs that path.
import { RUNBOOK_COMPLETION_WAIT_TIMEOUT_MS } from '@bitsentry-ce/core/features/agent-runtime'

export const HOST_MCP_SHIM_FILE_NAME = 'bitsentry-host-mcp-shim.cjs'

export const HOST_MCP_SHIM_SOURCE = `#!/usr/bin/env node

const readline = require('node:readline')

const url = process.env.BITSENTRY_MCP_URL
const token = process.env.BITSENTRY_MCP_TOKEN
const contextId = process.env.BITSENTRY_MCP_CONTEXT_ID
const protocolVersion = '2026-07-28'
const legacyProtocolVersion = '2025-11-25'
const shortRequestTimeoutMs = 10_000
const toolCallTimeoutMs = ${RUNBOOK_COMPLETION_WAIT_TIMEOUT_MS + 5_000}
const clientInfo = { name: 'bitsentry-host-mcp-legacy-shim', version: '1.0.0' }
const clientCapabilities = {}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseResponse(response, body) {
  const messages = response.headers.get('content-type')?.includes('text/event-stream')
    ? body.split('\\n').filter((entry) => entry.startsWith('data:')).map((entry) => entry.slice('data:'.length).trim())
    : [body]
  return messages.filter((message) => message.length > 0).map((message) => JSON.parse(message))
}

function modernEnvelope(legacyMeta) {
  const traceMeta = isRecord(legacyMeta)
    ? Object.fromEntries(Object.entries(legacyMeta).filter(([key]) => key === 'traceparent' || key === 'tracestate' || key === 'baggage' || key === 'progressToken'))
    : {}
  return {
    ...traceMeta,
    'io.modelcontextprotocol/protocolVersion': protocolVersion,
    'io.modelcontextprotocol/clientInfo': clientInfo,
    'io.modelcontextprotocol/clientCapabilities': clientCapabilities,
  }
}

function modernRequest(message) {
  const legacyParams = isRecord(message.params) ? message.params : {}
  const params = {
    ...legacyParams,
    _meta: modernEnvelope(legacyParams._meta),
  }
  if (message.method === 'tools/call') {
    const argumentsValue = isRecord(params.arguments) ? params.arguments : {}
    params.arguments = {
      ...argumentsValue,
      ...(argumentsValue.contextId === undefined ? { contextId } : {}),
    }
  }
  const headers = {
    authorization: \`Bearer \${token}\`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': protocolVersion,
    'mcp-method': message.method,
  }
  if (typeof params.name === 'string') headers['mcp-name'] = params.name
  return {
    headers,
    body: JSON.stringify({ ...message, params }),
  }
}

function requestTimeoutFor(message) {
  return message.method === 'tools/call' ? toolCallTimeoutMs : shortRequestTimeoutMs
}

function requestLabel(message) {
  if (message.method !== 'tools/call') return String(message.method)
  return typeof message.params?.name === 'string' ? \`tools/call \${message.params.name}\` : 'tools/call'
}

async function sendModernRequest(message) {
  const translated = modernRequest(message)
  const abortController = new AbortController()
  const timeoutMs = requestTimeoutFor(message)
  const timeout = setTimeout(() => abortController.abort(), timeoutMs)
  try {
    const response = await fetch(url, { method: 'POST', ...translated, signal: abortController.signal })
    const body = await response.text()
    if (!response.ok) {
      throw new Error(\`Host MCP request failed with status \${response.status}: \${body || response.statusText}\`)
    }
    return parseResponse(response, body)
  } catch (error) {
    if (abortController.signal.aborted) {
      throw new Error(\`Host MCP \${requestLabel(message)} exceeded its \${timeoutMs}ms budget and was aborted\`)
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

let discovery

async function discover() {
  if (discovery === undefined) {
    const candidate = (async () => {
      const [response] = await sendModernRequest({ jsonrpc: '2.0', id: 'bitsentry-discover', method: 'server/discover' })
      if (response?.error !== undefined || response?.result === undefined) {
        throw new Error(response?.error?.message ?? 'Stateless MCP discovery failed')
      }
      return response.result
    })()
    discovery = candidate
    try {
      return await candidate
    } catch (error) {
      if (discovery === candidate) discovery = undefined
      throw error
    }
  }
  return await discovery
}

async function handleLegacyRequest(message) {
  if (message.method === 'notifications/initialized') return []
  if (message.method === 'initialize') {
    const result = await discover()
    return [{
      jsonrpc: '2.0',
      id: message.id ?? null,
      result: {
        protocolVersion: typeof message.params?.protocolVersion === 'string'
          ? message.params.protocolVersion
          : legacyProtocolVersion,
        capabilities: result.capabilities,
        serverInfo: { name: 'bitsentry-host-tools', version: '1.0.0' },
        ...(typeof result.instructions === 'string' ? { instructions: result.instructions } : {}),
      },
    }]
  }
  return await sendModernRequest(message)
}

if (!url || !token || !contextId) {
  process.stderr.write('BITSENTRY_MCP_URL, BITSENTRY_MCP_TOKEN, and BITSENTRY_MCP_CONTEXT_ID are required.\\n')
  process.exitCode = 1
} else {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  ;(async () => {
    let stdout = Promise.resolve()
    const pending = new Set()
    const writeMessage = async (message) => {
      stdout = stdout.then(() => new Promise((resolve, reject) => {
        process.stdout.write(\`\${JSON.stringify(message)}\\n\`, (error) => error ? reject(error) : resolve())
      }))
      await stdout
    }
    const handleLine = async (line) => {
      let request
      try {
        request = JSON.parse(line)
        const messages = await handleLegacyRequest(request)
        for (const message of messages) await writeMessage(message)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const id = isRecord(request) && request.id !== undefined ? request.id : null
        await writeMessage({ jsonrpc: '2.0', error: { code: -32000, message }, id })
      }
    }
    for await (const line of input) {
      if (line.trim().length === 0) continue
      const task = handleLine(line).finally(() => pending.delete(task))
      pending.add(task)
    }
    await Promise.allSettled(pending)
  })()
}
`
