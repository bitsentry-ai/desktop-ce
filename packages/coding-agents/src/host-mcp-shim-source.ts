// Source of the stdio-to-HTTP MCP shim spawned by CLI providers (Codex,
// Cursor, OpenCode). Kept as an embedded string because the desktop app's
// main bundle cannot ship adjacent script files: electron-vite folds this
// package into out/main and a packaged app serves code from an asar archive,
// which external CLI processes cannot spawn from. The endpoint writes this
// source to a real file on disk at session start and hands CLIs that path.
export const HOST_MCP_SHIM_FILE_NAME = 'bitsentry-host-mcp-shim.cjs'

export const HOST_MCP_SHIM_SOURCE = `#!/usr/bin/env node

const readline = require('node:readline')

const url = process.env.BITSENTRY_MCP_URL
const token = process.env.BITSENTRY_MCP_TOKEN
const contextId = process.env.BITSENTRY_MCP_CONTEXT_ID
const protocolVersion = '2026-07-28'
const legacyProtocolVersion = '2025-11-25'
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
    ? Object.fromEntries(Object.entries(legacyMeta).filter(([key]) => key === 'traceparent' || key === 'tracestate' || key === 'baggage'))
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

async function sendModernRequest(message) {
  const translated = modernRequest(message)
  const response = await fetch(url, { method: 'POST', ...translated })
  const body = await response.text()
  return parseResponse(response, body)
}

let discovery

async function discover() {
  discovery ??= (async () => {
    const [response] = await sendModernRequest({ jsonrpc: '2.0', id: 'bitsentry-discover', method: 'server/discover' })
    if (response?.error !== undefined || response?.result === undefined) {
      throw new Error(response?.error?.message ?? 'Stateless MCP discovery failed')
    }
    return response.result
  })()
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
        protocolVersion: legacyProtocolVersion,
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
    for await (const line of input) {
      if (line.trim().length === 0) continue
    try {
      const messages = await handleLegacyRequest(JSON.parse(line))
      for (const message of messages) {
        process.stdout.write(\`\${JSON.stringify(message)}\\n\`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      process.stdout.write(\`\${JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null })}\\n\`)
    }
    }
  })()
}
`
