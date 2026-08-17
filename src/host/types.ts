export type CredentialKind = 'api-key' | 'plan-token'

export interface CredentialMeta {
  providerId: string
  kind: CredentialKind
  channel?: 'cn' | 'intl'
  label?: string
}

export interface CredentialHandle {
  credentialId: string
  providerId: string
  kind: CredentialKind
  channel?: 'cn' | 'intl'
  label?: string
  enabled: boolean
}

export interface HostEvent {
  type: string
  timestamp: number
  [key: string]: unknown
}

export type PanelKind = 'progress' | 'project-list' | 'guidance'

export interface PanelDefinition {
  panelId: string
  title: string
  kind: PanelKind
}

export interface HostProvider {
  credentials: {
    put(meta: CredentialMeta, secret: string): Promise<CredentialHandle>
    get(handle: CredentialHandle): Promise<string>
    mask(handle: CredentialHandle): string
    list(): Promise<CredentialHandle[]>
    setEnabled(handle: CredentialHandle, enabled: boolean): Promise<CredentialHandle>
  }
  events: {
    publish<T extends HostEvent>(event: T): void
  }
  ui: {
    registerPanel(panel: PanelDefinition): void
  }
  storage: {
    dataRoot(): Promise<string>
  }
}

export function maskSecret(secret: string): string {
  if (secret.length < 8) return '*'.repeat(secret.length)
  return `${secret.slice(0, 2)}***${secret.slice(-3)}`
}