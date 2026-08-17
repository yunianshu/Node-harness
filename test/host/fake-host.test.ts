import { describe, expect, it } from 'vitest'
import { FakeHost } from '../../src/host/dsh-adapter'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('FakeHost credentials', () => {
  it('put/get round-trips a secret', async () => {
    const host = new FakeHost()
    const handle = await host.credentials.put(
      { providerId: 'glm', kind: 'api-key', channel: 'cn' },
      'sk-abcdef123456',
    )
    expect(handle.credentialId).toMatch(/^cred-\d+$/)
    expect(handle.enabled).toBe(true)
    await expect(host.credentials.get(handle)).resolves.toBe('sk-abcdef123456')
  })

  it('mask outputs form like sk-***abc', async () => {
    const host = new FakeHost()
    const handle = await host.credentials.put({ providerId: 'glm', kind: 'api-key' }, 'sk-abcdefgh')
    await expect(host.credentials.mask(handle)).resolves.toBe('sk***fgh')
  })

  it('list returns handles and setEnabled toggles', async () => {
    const host = new FakeHost()
    const a = await host.credentials.put({ providerId: 'glm', kind: 'api-key' }, 'sk-aaaaaaaa')
    const b = await host.credentials.put({ providerId: 'glm', kind: 'plan-token', channel: 'intl' }, 'tok-bbbbbbbb')
    const list = await host.credentials.list()
    expect(list).toHaveLength(2)
    const disabled = await host.credentials.setEnabled(b, false)
    expect(disabled.enabled).toBe(false)
    expect((await host.credentials.list()).find((h) => h.credentialId === a.credentialId)?.enabled).toBe(true)
  })

  it('events publish collects events', () => {
    const host = new FakeHost()
    host.events.publish({ type: 'model.fallback', timestamp: Date.now() })
    expect(host.publishedEvents()).toHaveLength(1)
  })

  it('dataRoot returns the configured root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fake-host-'))
    const host = new FakeHost(root)
    await expect(host.storage.dataRoot()).resolves.toBe(root)
  })
})
