import { describe, expect, it } from 'vitest'
import { FakeHost } from '../../src/host/dsh-adapter'
import { maskSecret } from '../../src/host/types'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('FakeHost credentials', () => {
  it('put/get round-trips a secret', async () => {
    const host = new FakeHost()
    const handle = await host.credentials.put({ providerId: 'glm', kind: 'api-key' }, 'sk-abc123def456')
    expect(handle.credentialId).toBeTruthy()
    expect(handle.enabled).toBe(true)
    await expect(host.credentials.get(handle)).resolves.toBe('sk-abc123def456')
  })

  it('mask outputs form like sk-***abc', async () => {
    const host = new FakeHost()
    const handle = await host.credentials.put({ providerId: 'deepseek', kind: 'api-key' }, 'sk-abcdefgh')
    expect(host.credentials.mask(handle)).toBe('sk***fgh')
  })

  it('mask keeps same shape as maskSecret for short secrets', () => {
    expect(maskSecret('short')).toBe('*****')
    expect(maskSecret('12345678')).toBe('12***678')
  })

  it('api key and plan token are two independent records for same account', async () => {
    const host = new FakeHost()
    const apiKey = await host.credentials.put({ providerId: 'glm', kind: 'api-key', label: 'glm pay' }, 'sk-key-111')
    const plan = await host.credentials.put({ providerId: 'glm', kind: 'plan-token', label: 'glm plan cn' }, 'plan-token-222')
    expect(apiKey.credentialId).not.toBe(plan.credentialId)
    const list = await host.credentials.list()
    expect(list).toHaveLength(2)
    const disabled = await host.credentials.setEnabled(apiKey, false)
    expect(disabled.enabled).toBe(false)
    const after = await host.credentials.list()
    expect(after.find((h) => h.credentialId === plan.credentialId)?.enabled).toBe(true)
    expect(after.find((h) => h.credentialId === apiKey.credentialId)?.enabled).toBe(false)
  })

  it('events publish collects events and ui registers panels', async () => {
    const host = new FakeHost()
    host.events.publish({ type: 'model.fallback', timestamp: Date.now() })
    host.ui.registerPanel({ panelId: 'progress', title: '进度', kind: 'progress' })
    expect(host.publishedEvents()).toHaveLength(1)
    expect(host.registeredPanels()).toHaveLength(1)
  })

  it('dataRoot returns stable temp dir when unspecified', async () => {
    const host = new FakeHost()
    const root1 = await host.storage.dataRoot()
    const root2 = await host.storage.dataRoot()
    expect(root1).toBe(root2)
  })

  it('dataRoot respects explicit directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'novel-host-'))
    const host = new FakeHost(dir)
    await expect(host.storage.dataRoot()).resolves.toBe(dir)
  })
})