// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { IntegrationActionPoliciesPort, IntegrationActionPolicy } from '@bitsentry-ce/components/services/contracts'
import { IntegrationPermissions } from '@bitsentry-ce/components/settings/IntegrationPermissions'

const mocks = vi.hoisted(() => ({ t: (key: string, values?: { action?: string }) => values?.action ? `${key}:${values.action}` : key }))
vi.mock('@bitsentry-ce/i18n', () => ({ useTranslation: () => ({ t: mocks.t }) }))
const originalScrollIntoView = Element.prototype.scrollIntoView
beforeAll(() => { Element.prototype.scrollIntoView = vi.fn() })
afterAll(() => { Element.prototype.scrollIntoView = originalScrollIntoView })
afterEach(cleanup)
const key = (suffix: string) => `settings.integrationPermissions.${suffix}`
const policy = (riskLevel: 'read' | 'write', overrides: Partial<IntegrationActionPolicy> = {}): IntegrationActionPolicy => ({
  actionId: 'action', riskLevel, mode: riskLevel === 'read' ? 'allow' : 'approve', approverUserIds: [], hardDenied: false, ...overrides,
})
function port(row: IntegrationActionPolicy, canEdit = true): IntegrationActionPoliciesPort {
  return { canEdit, list: vi.fn(async () => [row]), save: vi.fn(async () => undefined), listUsers: vi.fn(async () => [{ id: 7, name: 'Pat', email: 'pat@example.com' }]) }
}
async function open(service: IntegrationActionPoliciesPort) {
  const view = render(<IntegrationPermissions connectionId="connection" service={service} />)
  const details = view.container.querySelector('details')!
  details.open = true
  fireEvent(details, new Event('toggle'))
  await screen.findByRole('table')
}
async function choices() {
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' })
  return (await screen.findAllByRole('option')).map((item) => item.textContent)
}

describe('connection action permissions', () => {
  it('saves selected approvers and displays the server error on that row', async () => {
    const service = port(policy('write'))
    vi.mocked(service.save).mockRejectedValue(new Error('Approvers must be active users in this organization'))
    await open(service)
    await choices()
    fireEvent.click(screen.getByRole('option', { name: key('restricted') }))
    expect((screen.getByRole('button', { name: key('save') }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: /Pat/ }))
    fireEvent.click(screen.getByRole('button', { name: key('save') }))
    await waitFor(() => { expect(service.save).toHaveBeenCalledWith({ connectionId: 'connection', actionId: 'action', mode: 'restricted', approverUserIds: [7] }) })
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Approvers must be active users in this organization')
  })
})
