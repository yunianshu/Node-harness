import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Credentials, type CredentialInfo, type CredentialRef, type ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { DshHostAdapter } from '../../src/host/dsh-adapter'
import type { HostEvent } from '../../src/host/types'

/** 内存实现 dsh 凭据服务：POSIX ref → 值，与真实底座同语义。 */
class MemoryCredentials extends Credentials {
  private readonly store = new Map<string, string>()

  async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.store.get(ref)
    return value === undefined || value.length === 0 ? undefined : { value, source: 'test' }
  }

  async describe(ref: CredentialRef): Promise<CredentialInfo> {
    return { configured: this.store.has(ref), source: this.store.has(ref) ? 'test' : undefined, writable: true }
  }

  async set(ref: CredentialRef, value: string): Promise<void> {
    this.store.set(ref, value)
  }

  async unset(ref: CredentialRef): Promise<void> {
    this.store.delete(ref)
  }
}

const contexts: Context[] = []
const roots: string[] = []

async function bootAdapter() {
  const ctx = new Context()
  contexts.push(ctx)
  const dataRoot = await mkdtemp(join(tmpdir(), 'dsh-adapter-'))
  roots.push(dataRoot)
  new MemoryCredentials(ctx)
  const adapter = new DshHostAdapter(ctx, { dataRoot })
  return { ctx, dataRoot, adapter }
}

afterEach(() => {
  for (const ctx of contexts.splice(0)) void ctx.root.fiber.dispose()
  for (const root of roots.splice(0)) void rm(root, { recursive: true, force: true })
})

describe('DshHostAdapter（对接真实 cordis Context + 凭据服务）', () => {
  it('put encodes provider meta into a POSIX credential ref and round-trips', async () => {
    const { adapter } = await bootAdapter()
    const handle = await adapter.credentials.put(
      { providerId: 'glm', kind: 'plan-token', channel: 'cn' },
      'tok-1234567890',
    )
    expect(handle.credentialId).toBe('NOVEL_GLM_PLAN_TOKEN_CN')
    await expect(adapter.credentials.get(handle)).resolves.toBe('tok-1234567890')
  })

  it('mask returns masked value and marks unconfigured refs', async () => {
    const { adapter } = await bootAdapter()
    const handle = await adapter.credentials.put({ providerId: 'minimax', kind: 'api-key' }, 'sk-abcdefgh')
    await expect(adapter.credentials.mask(handle)).resolves.toBe('sk***fgh')
    await expect(adapter.credentials.mask({ ...handle, credentialId: 'NOVEL_MINIMAX_API_KEY_2' })).resolves.toContain('未配置')
  })

  it('persists provider index under dataRoot and restarts with list', async () => {
    const { ctx, dataRoot, adapter } = await bootAdapter()
    await adapter.credentials.put({ providerId: 'deepseek', kind: 'api-key' }, 'sk-111111111')
    const raw = JSON.parse(await readFile(join(dataRoot, 'providers.json'), 'utf-8'))
    expect(raw.providers).toHaveLength(1)
    expect(raw.providers[0].credentialId).toBe('NOVEL_DEEPSEEK_API_KEY')
    // 模拟重启：同底座新适配器实例从索引恢复
    const reborn = new DshHostAdapter(ctx, { dataRoot })
    const list = await reborn.credentials.list()
    expect(list.map((h) => h.credentialId)).toContain('NOVEL_DEEPSEEK_API_KEY')
  })

  it('setEnabled toggles without touching the underlying credential store', async () => {
    const { adapter } = await bootAdapter()
    const handle = await adapter.credentials.put({ providerId: 'glm', kind: 'api-key', channel: 'intl' }, 'sk-222222222')
    const disabled = await adapter.credentials.setEnabled(handle, false)
    expect(disabled.enabled).toBe(false)
    // 底座值仍在：get 可用（启停仅约束插件侧路由）
    await expect(adapter.credentials.get(handle)).resolves.toBe('sk-222222222')
  })

  it('publishes domain events on the cordis bus as novel/event', async () => {
    const { ctx, adapter } = await bootAdapter()
    const seen: HostEvent[] = []
    const off = ctx.on('novel/event', (event) => seen.push(event))
    adapter.events.publish({ type: 'model.fallback', timestamp: 12345, channel: 'glm::cn' })
    expect(seen).toHaveLength(1)
    expect(seen[0].type).toBe('model.fallback')
    off()
  })

  it('dataRoot honors the explicit option', async () => {
    const { dataRoot, adapter } = await bootAdapter()
    await expect(adapter.storage.dataRoot()).resolves.toBe(dataRoot)
  })
})
