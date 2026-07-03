import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'

import { createDesktopNodePluginRuntimeService } from '@bitsentry-ce/core/features/plugins/node'
import { afterEach, describe, expect, it } from 'vitest'

describe('desktop plugin installation boundaries', () => {
  const tempRoots: string[] = []
  const originalResourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath

  afterEach(async () => {
    if (originalResourcesPath === undefined) {
      Reflect.deleteProperty(process, 'resourcesPath')
    } else {
      Object.defineProperty(process, 'resourcesPath', {
        configurable: true,
        value: originalResourcesPath,
      })
    }

    await Promise.all(
      tempRoots.map((tempRoot) => rm(tempRoot, { recursive: true, force: true })),
    )
    tempRoots.length = 0
  })

  it('does not load plugins from Electron resources by default', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'bitsentry-plugin-resources-'))
    tempRoots.push(tempRoot)

    const resourcesPath = path.join(tempRoot, 'resources')
    const pluginRoot = path.join(resourcesPath, 'plugins', 'bundled-code-plugin')
    await mkdir(pluginRoot, { recursive: true })
    await writeFile(
      path.join(pluginRoot, 'plugin.js'),
      `
exports.plugin = {
  id: 'bundled-code-plugin',
  name: 'Bundled Code Plugin',
  version: '1.0.0',
  description: 'This should not load from Electron resources in v1.',
  auth: { fields: [] },
  actions: [],
}
`,
    )

    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: resourcesPath,
    })

    const runtime = createDesktopNodePluginRuntimeService()
    expect(runtime.getPlugin('bundled-code-plugin')).toBeNull()
  })
})
