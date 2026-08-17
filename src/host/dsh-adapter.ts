import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { atomicWriteJson, readJsonValidated } from '../storage/atomic.js'
import {
  CredentialHandle,
  CredentialMeta,
  HostEvent,
  HostProvider,
  maskSecret,
} from './types.js'

/**
 * 全仓唯一允许依赖 dsh 底座具体 API 的文件（design 2.1.2 集成方式第 6 条）：
 * - 凭据 → ctx.credentials（POSIX 环境变量名式引用，按次解析不缓存）
 * - 事件 → cordis 事件总线的 novel/event 域
 * - 数据根目录 → $DSH_HOME/novels（dshHomePath 模式）
 * 真实 dsh 无动态 UI 面板扩展点（web 为固定编译产物），
 * 进度呈现经 novel-* 命令与 webhook 通知（spec 5.7）落地。
 */

/** 服务商索引条目：凭据本体在底座，这里只保存句柄与启停状态。 */
interface ProviderIndexEntry {
  credentialId: string
  providerId: string
  kind: CredentialMeta['kind']
  channel?: 'cn' | 'intl'
  label?: string
  enabled: boolean
}

interface ProviderIndex {
  providers: ProviderIndexEntry[]
}

const INDEX_FILE = 'providers.json'

function isProviderIndex(raw: unknown): raw is ProviderIndex {
  if (typeof raw !== 'object' || raw === null) return false
  const providers = (raw as { providers?: unknown }).providers
  return Array.isArray(providers)
}

/** providerId/kind/channel 编码进 ref 名，如 NOVEL_GLM_PLAN_TOKEN_CN。 */
function refOf(meta: CredentialMeta): CredentialRef {
  const provider = meta.providerId.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  const kind = meta.kind === 'api-key' ? 'API_KEY' : 'PLAN_TOKEN'
  const channel = meta.channel ? `_${meta.channel.toUpperCase()}` : ''
  return credentialRef(`NOVEL_${provider}_${kind}${channel}`)
}

export interface DshHostAdapterOptions {
  /** 覆盖默认数据根目录（$DSH_HOME/novels），供测试与离线开发。 */
  dataRoot?: string
}

export class DshHostAdapter implements HostProvider {
  private readonly rootDir: string
  private readonly indexPath: string

  constructor(
    private readonly ctx: Context,
    options: DshHostAdapterOptions = {},
  ) {
    this.rootDir = options.dataRoot ?? dshHomePath('novels')
    this.indexPath = join(this.rootDir, INDEX_FILE)
  }

  private async loadIndex(): Promise<ProviderIndex> {
    const loaded = await readJsonValidated(this.indexPath, isProviderIndex)
    return loaded ?? { providers: [] }
  }

  private async saveIndex(index: ProviderIndex): Promise<void> {
    await mkdir(dirname(this.indexPath), { recursive: true })
    await atomicWriteJson(this.indexPath, index)
  }

  get credentials() {
    const ctx = this.ctx
    return {
      put: async (meta: CredentialMeta, secret: string): Promise<CredentialHandle> => {
        const ref = refOf(meta)
        await ctx.credentials.set(ref, secret)
        const index = await this.loadIndex()
        const entry: ProviderIndexEntry = {
          credentialId: ref,
          providerId: meta.providerId,
          kind: meta.kind,
          ...(meta.channel ? { channel: meta.channel } : {}),
          ...(meta.label ? { label: meta.label } : {}),
          enabled: true,
        }
        index.providers = index.providers.filter((e) => e.credentialId !== ref)
        index.providers.push(entry)
        await this.saveIndex(index)
        return { credentialId: ref, providerId: meta.providerId, kind: meta.kind, ...(meta.channel ? { channel: meta.channel } : {}), ...(meta.label ? { label: meta.label } : {}), enabled: true }
      },
      get: async (handle: CredentialHandle): Promise<string> => {
        const resolved = await ctx.credentials.resolve(credentialRef(handle.credentialId))
        if (resolved === undefined) {
          throw new Error(`credential not found: ${handle.credentialId}`)
        }
        return resolved.value
      },
      mask: async (handle: CredentialHandle): Promise<string> => {
        const resolved = await ctx.credentials.resolve(credentialRef(handle.credentialId))
        return resolved === undefined ? `${handle.credentialId}（未配置）` : maskSecret(resolved.value)
      },
      list: async (): Promise<CredentialHandle[]> => {
        const index = await this.loadIndex()
        return index.providers.map((e) => ({
          credentialId: e.credentialId,
          providerId: e.providerId,
          kind: e.kind,
          ...(e.channel ? { channel: e.channel } : {}),
          ...(e.label ? { label: e.label } : {}),
          enabled: e.enabled,
        }))
      },
      setEnabled: async (handle: CredentialHandle, enabled: boolean): Promise<CredentialHandle> => {
        const index = await this.loadIndex()
        const entry = index.providers.find((e) => e.credentialId === handle.credentialId)
        if (!entry) throw new Error(`credential not found: ${handle.credentialId}`)
        entry.enabled = enabled
        await this.saveIndex(index)
        return { ...handle, enabled }
      },
    }
  }

  get events() {
    const ctx = this.ctx
    return {
      publish: <T extends HostEvent>(event: T): void => {
        ctx.emit('novel/event', event)
      },
    }
  }

  get storage() {
    return {
      dataRoot: async () => this.rootDir,
    }
  }
}

export class FakeHost implements HostProvider {
  private readonly secrets = new Map<string, string>()
  private readonly handles = new Map<string, CredentialHandle>()
  private readonly published: unknown[] = []
  private nextId = 1
  private rootDir: string

  constructor(dataRoot?: string) {
    this.rootDir = dataRoot ?? ''
  }

  async dataRoot(): Promise<string> {
    if (!this.rootDir) this.rootDir = await mkdtemp(join(tmpdir(), 'novel-harness-test-'))
    return this.rootDir
  }

  get credentials() {
    return {
      put: async (meta: CredentialMeta, secret: string) => {
        const credentialId = `cred-${this.nextId++}`
        const handle: CredentialHandle = {
          credentialId,
          providerId: meta.providerId,
          kind: meta.kind,
          channel: meta.channel,
          label: meta.label,
          enabled: true,
        }
        this.secrets.set(credentialId, secret)
        this.handles.set(credentialId, handle)
        return handle
      },
      get: async (handle: CredentialHandle) => {
        const secret = this.secrets.get(handle.credentialId)
        if (secret === undefined) throw new Error(`credential not found: ${handle.credentialId}`)
        return secret
      },
      mask: async (handle: CredentialHandle) => {
        const secret = this.secrets.get(handle.credentialId)
        if (secret === undefined) throw new Error(`credential not found: ${handle.credentialId}`)
        return maskSecret(secret)
      },
      list: async () => [...this.handles.values()],
      setEnabled: async (handle: CredentialHandle, enabled: boolean) => {
        const existing = this.handles.get(handle.credentialId)
        if (!existing) throw new Error(`credential not found: ${handle.credentialId}`)
        const updated = { ...existing, enabled }
        this.handles.set(handle.credentialId, updated)
        return updated
      },
    }
  }

  get events() {
    return {
      publish: <T extends { type: string }>(event: T): void => {
        this.published.push(event)
      },
    }
  }

  get storage() {
    return { dataRoot: () => this.dataRoot() }
  }

  publishedEvents(): readonly unknown[] {
    return this.published
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * 插件领域事件（项目状态/章节进度/模型降级/限额/完成/错误），
     * 供底座侧订阅呈现；字段只增不删（spec 8.1）。
     * @mode emit
     */
    'novel/event'(event: HostEvent): void
  }
}
