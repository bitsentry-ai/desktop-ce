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

if (!url || !token) {
  process.stderr.write('BITSENTRY_MCP_URL and BITSENTRY_MCP_TOKEN are required.\\n')
  process.exitCode = 1
} else {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  input.on('line', async (line) => {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: \`Bearer \${token}\`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: line,
      })
      const body = await response.text()
      const messages = response.headers.get('content-type')?.includes('text/event-stream')
        ? body.split('\\n').filter((entry) => entry.startsWith('data:')).map((entry) => entry.slice('data:'.length).trim())
        : [body]
      for (const message of messages) {
        if (message.length > 0) process.stdout.write(\`\${message}\\n\`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      process.stdout.write(\`\${JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null })}\\n\`)
    }
  })
}
`
