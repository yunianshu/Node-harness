import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CredentialHandle,
  CredentialMeta,
  HostProvider,
  maskSecret,
} from './types.js'

export interface DshCredentialStore {
  put(meta: CredentialMeta, secret: string): Promise<{ credentialId: string }>
  get(credentialId: string): Promise<string>
  list(): Promise<Array<{ credentialId: string } & CredentialMeta & { enabled?: boolean }>>
  setEnabled(credentialId: string, enabled: boolean): Promise<void>
}

export interface DshEventBus {
  publish(event: unknown): void
}

export interface DshUiRegistry {
  registerPanel(panel: unknown): void
}

export interface DshHostRuntime {
  credentials?: DshCredentialStore
  events?: DshEventBus
  ui?: DshUiRegistry
  dataRoot?: string
}

function dshError(method: string): never {
  throw new Error(`dsh host runtime does not provide "${method}"; check plugin loading profile`)
}

export class DshHostAdapter implements HostProvider {
  constructor(private readonly runtime: DshHostRuntime) {}

  private cred(): DshCredentialStore {
    if (!this.runtime.credentials) dshError('credentials')
    return this.runtime.credentials
  }

  get credentials() {
    const store = this.runtime.credentials
    return {
      put: async (meta: CredentialMeta, secret: string) => {
        const { credentialId } = await this.cred().put(meta, secret)
        return {
          credentialId,
          providerId: meta.providerId,
          kind: meta.kind,
          channel: meta.channel,
          label: meta.label,
          enabled: true,
        } satisfies CredentialHandle
      },
      get: async (handle: CredentialHandle) => store?.get(handle.credentialId) ?? dshError('credentials.get'),
      mask: (handle: CredentialHandle) => handle.label ?? maskSecret(handle.credentialId),
      list: async () => {
        const rows = await this.cred().list()
        return rows.map((r) => ({
          credentialId: r.credentialId,
          providerId: r.providerId,
          kind: r.kind,
          label: r.label,
          enabled: r.enabled ?? true,
        }))
      },
      setEnabled: async (handle: CredentialHandle, enabled: boolean) => {
        await this.cred().setEnabled(handle.credentialId, enabled)
        return { ...handle, enabled }
      },
    }
  }

  get events() {
    const bus = this.runtime.events
    return {
      publish: (event: unknown) => {
        if (!bus) dshError('events')
        bus.publish(event)
      },
    }
  }

  get ui() {
    const registry = this.runtime.ui
    return {
      registerPanel: (panel: unknown) => {
        if (!registry) dshError('ui')
        registry.registerPanel(panel)
      },
    }
  }

  get storage() {
    const root = this.runtime.dataRoot
    return {
      dataRoot: async () => {
        if (!root) dshError('storage.dataRoot')
        return root
      },
    }
  }
}

export class FakeHost implements HostProvider {
  private readonly secrets = new Map<string, string>()
  private readonly handles = new Map<string, CredentialHandle>()
  private readonly panels: unknown[] = []
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
      mask: (handle: CredentialHandle) => {
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

  get ui() {
    return {
      registerPanel: (panel: unknown): void => {
        this.panels.push(panel)
      },
    }
  }

  get storage() {
    return { dataRoot: () => this.dataRoot() }
  }

  publishedEvents(): readonly unknown[] {
    return this.published
  }

  registeredPanels(): readonly unknown[] {
    return this.panels
  }
}