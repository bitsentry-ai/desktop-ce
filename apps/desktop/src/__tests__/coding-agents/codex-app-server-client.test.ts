/**
 * Compile-time contract tests for Codex app-server client.
 * Verifies the CodexAppServerClient class has the expected public API.
 */

import { EventEmitter } from 'events'
import { expect, it } from 'vitest'

it('exposes its public client contract', async () => {
  const { CodexAppServerClient } = await import('@bitsentry-ce/coding-agents/codex-app-server-client')

  // Constructor
  const client = new CodexAppServerClient('codex', '/tmp', ['--profile', 'test'])

  // Must extend EventEmitter
  const _isEmitter: EventEmitter = client

  // Public methods
  const _start: () => Promise<void> = client.start.bind(client)
  const _sendRequest: (method: string, params?: unknown) => Promise<unknown> = client.sendRequest.bind(client)
  const _respondToServer: (id: number, result: unknown) => void = client.respondToServerRequest.bind(client)
  const _respondToServerError: (id: number, message: string) => void = client.respondToServerRequestError.bind(client)
  const _getStderrTail: () => string = client.getStderrTail.bind(client)
  const _kill: () => void = client.kill.bind(client)
  const _isRunning: boolean = client.isRunning

  // Event types
  client.on('notification', (_notification: { method: string; params: unknown }) => {})
  client.on('serverRequest', (_request: { id: number; method: string; params: unknown }) => {})
  client.on('closed', (_reason: string) => {})
  client.on('parseError', (_error: { error: string; raw: string }) => {})

  expect([_isEmitter, _start, _sendRequest, _respondToServer, _respondToServerError, _getStderrTail, _kill, _isRunning]).toHaveLength(8)
})
