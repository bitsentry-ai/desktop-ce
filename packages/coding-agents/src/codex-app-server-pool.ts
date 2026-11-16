import { CodexAppServerClient } from './codex-app-server-client.js'
import { createCodingAgentsProcessEnv } from './coding-agents-process-env.js'
import {
  createIsolatedCodexIncidentHome,
  type IsolatedCodexIncidentHome,
} from './codex-incident-home.js'
import { createProcessPool } from './process-pool.js'

export interface CodexAppServerSpec {
  binaryPath: string
  cwd: string
  args: string[] | undefined
  /** Incident session that owns an isolated HOME; undefined runs with the real HOME. */
  isolatedSessionId: string | undefined
}

interface CodexAppServer {
  client: CodexAppServerClient
  home: IsolatedCodexIncidentHome | undefined
}

/** Lends a running `codex app-server` per turn; concurrent turns share it. */
export const borrowCodexAppServer = createProcessPool<CodexAppServerSpec, CodexAppServer>({
  keyFor: (spec) => JSON.stringify([
    spec.binaryPath,
    spec.args ?? [],
    spec.cwd,
    spec.isolatedSessionId ?? null,
    createCodingAgentsProcessEnv(process.env),
  ]),
  create: async (spec) => {
    const home = spec.isolatedSessionId === undefined ? undefined : await createIsolatedCodexIncidentHome()
    return { client: new CodexAppServerClient(spec.binaryPath, spec.cwd, spec.args, { home: home?.home }), home }
  },
  start: async ({ client }, onExit) => {
    client.once('closed', onExit)
    await client.start()
  },
  close: async ({ client, home }) => {
    await client.kill()
    await home?.dispose()
  },
})
