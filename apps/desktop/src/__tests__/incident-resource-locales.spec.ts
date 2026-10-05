import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const locales = ['en-US', 'en-GB', 'en-AU', 'fr-FR', 'zh-CN', 'id-ID']
const load = (locale: string) => JSON.parse(readFileSync(resolve(process.cwd(), `../../packages/i18n/src/locales/${locale}/incidents.json`), 'utf8')) as Record<string, string>
const placeholders = (text: string) => [...text.matchAll(/{{(\w+)}}/g)].map((match) => match[1]).sort()
const cardKeys = (data: Record<string, string>) => Object.keys(data).filter((key) => key.startsWith('incidents.integrationResources.') || key.startsWith('incidents.integrationRail.') || key.startsWith('incidents.knowledge.') || key.startsWith('incidents.deliveries.') || key.startsWith('incidents.integrationRecovery.') || key.startsWith('incidents.artifactsPanel.'))

describe('linked resource, integrations rail, artifacts panel, delivery and knowledge execution labels', () => {
  const english = load('en-US')

  it.each(locales.slice(1))('%s has exactly the same keys as en-US', (locale) => {
    expect(cardKeys(load(locale)).sort()).toEqual(cardKeys(english).sort())
  })

  it.each(locales)('%s fills the placeholders the panels pass', (locale) => {
    const data = load(locale)
    for (const key of cardKeys(english)) {
      expect(placeholders(data[key] ?? ''), `${locale} ${key}`).toEqual(placeholders(english[key] ?? ''))
    }
  })

  it('uses the placeholder names the panels fill', () => {
    expect(placeholders(english['incidents.integrationResources.selectedCount']!)).toEqual(['selected'])
    expect(placeholders(english['incidents.integrationResources.observedAt']!)).toEqual(['time'])
    expect(placeholders(english['incidents.knowledge.revision']!)).toEqual(['revision'])
    expect(placeholders(english['incidents.knowledge.duration']!)).toEqual(['time'])
  })

  it('has no empty label', () => {
    for (const locale of locales) {
      const data = load(locale)
      for (const key of cardKeys(data)) expect(data[key]!.trim(), `${locale} ${key}`).not.toBe('')
    }
  })
})
