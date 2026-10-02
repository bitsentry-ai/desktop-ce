import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plugin as itop } from '../../plugins/itop/src/plugin'
import { plugin as outline } from '../../plugins/outline/src/plugin'

type RunnablePlugin = { actions: Array<{ id: string; execute(context: never): Promise<unknown> }> }
const run = (plugin: unknown, actionId: string, context: Record<string, unknown>) => {
  const action = (plugin as RunnablePlugin).actions.find((row) => row.id === actionId)
  if (action === undefined) throw new Error(`No action ${actionId}`)
  return action.execute({ actionId, pluginId: 'plugin', ...context } as never)
}
const SECRET = 'credential-that-must-stay-home'
const itopRead = (baseUrl: string) => run(itop, 'get_object', { input: { class: 'UserRequest', id: 17 }, auth: { baseUrl, authToken: SECRET } })
const outlineRead = (apiBase: string) => run(outline, 'get_document', { input: { id: 'doc-1' }, auth: { apiBase, accessToken: SECRET } })

const originalItop = process.env.ITOP_ALLOWED_BASE_URLS
const originalOutline = process.env.OUTLINE_ALLOWED_API_BASES
const sent = vi.fn()
beforeEach(() => {
  delete process.env.ITOP_ALLOWED_BASE_URLS
  delete process.env.OUTLINE_ALLOWED_API_BASES
  sent.mockReset()
  sent.mockResolvedValue(new Response(JSON.stringify({ code: 0, objects: {}, data: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', sent)
})
afterEach(() => {
  vi.unstubAllGlobals()
  if (originalItop === undefined) delete process.env.ITOP_ALLOWED_BASE_URLS; else process.env.ITOP_ALLOWED_BASE_URLS = originalItop
  if (originalOutline === undefined) delete process.env.OUTLINE_ALLOWED_API_BASES; else process.env.OUTLINE_ALLOWED_API_BASES = originalOutline
})

describe('a destination the host does not allow', () => {
  it('is refused by iTop before any request is made, so no credential leaves the host', async () => {
    await expect(itopRead('https://itop.not-allowed.example/')).rejects.toThrow('ITOP_ALLOWED_BASE_URLS')

    expect(sent).not.toHaveBeenCalled()
  })

  it('is refused by iTop when only a different instance is allowed', async () => {
    process.env.ITOP_ALLOWED_BASE_URLS = 'https://itop.allowed.example/'

    await expect(itopRead('https://itop.not-allowed.example/')).rejects.toThrow('ITOP_ALLOWED_BASE_URLS')

    expect(sent).not.toHaveBeenCalled()
  })

  it('is refused by Outline before any request is made, so no credential leaves the host', async () => {
    await expect(outlineRead('https://wiki.not-allowed.example/api')).rejects.toThrow('OUTLINE_ALLOWED_API_BASES')

    expect(sent).not.toHaveBeenCalled()
  })

  it('is refused by Outline when only a different instance is allowed', async () => {
    process.env.OUTLINE_ALLOWED_API_BASES = 'https://wiki.allowed.example/api'

    await expect(outlineRead('https://wiki.not-allowed.example/api')).rejects.toThrow('OUTLINE_ALLOWED_API_BASES')

    expect(sent).not.toHaveBeenCalled()
  })
})

describe('the destination the host does allow', () => {
  const hostsOf = () => sent.mock.calls.map(([url]) => new URL(String(url)).host)

  it('is the only host an iTop read reaches', async () => {
    process.env.ITOP_ALLOWED_BASE_URLS = 'https://itop.allowed.example/'

    await itopRead('https://itop.allowed.example/')

    expect(hostsOf()).toEqual(['itop.allowed.example'])
  })

  it('is the only host an Outline read reaches', async () => {
    process.env.OUTLINE_ALLOWED_API_BASES = 'https://wiki.allowed.example/api'

    await outlineRead('https://wiki.allowed.example/api')

    expect(hostsOf()).toEqual(['wiki.allowed.example'])
  })
})
