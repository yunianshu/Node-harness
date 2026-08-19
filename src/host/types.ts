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

/** dsh 底座暴露的一个可用模型（provider route + model id）。 */
export interface HostLlmModel {
  /** dsh provider route（如 zai-coding-cn / hprt），传给 generateOptions.provider。 */
  provider: string
  /** 模型 id（如 glm-5.2 / deepseek-v4-flash），传给 generateOptions.model。 */
  model: string
  /** 展示名（可选）。 */
  name?: string
}

/** 经 dsh 底座 LLM 服务发起的一次单轮流式调用。 */
export interface HostLlmRequest {
  provider: string
  model: string
  system?: string
  user: string
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
}

/** 流式增量（正文 / 思考段分开上报）。 */
export interface HostLlmDelta {
  text?: string
  reasoning?: string
  /** 流结束标记：stop=正常收束；length=max-tokens 截断；error/aborted=失败（伴随 error）。 */
  finish?: 'stop' | 'length' | 'error' | 'aborted'
  /** 失败/中止时的诊断信息。 */
  error?: string
}

export interface HostProvider {
  credentials: {
    put(meta: CredentialMeta, secret: string): Promise<CredentialHandle>
    get(handle: CredentialHandle): Promise<string>
    mask(handle: CredentialHandle): Promise<string>
    list(): Promise<CredentialHandle[]>
    setEnabled(handle: CredentialHandle, enabled: boolean): Promise<CredentialHandle>
  }
  events: {
    publish<T extends HostEvent>(event: T): void
  }
  storage: {
    dataRoot(): Promise<string>
  }
  /**
   * dsh 底座模型执行面：列出可用模型 + 流式调用。
   * 凭据由底座自身管理（settings.yaml apiKeyEnv），harness 不经由此面接触密钥。
   */
  llm: {
    listModels(): Promise<HostLlmModel[]>
    stream(req: HostLlmRequest): AsyncIterable<HostLlmDelta>
  }
}

export function maskSecret(secret: string): string {
  if (secret.length < 8) return '*'.repeat(secret.length)
  return `${secret.slice(0, 2)}***${secret.slice(-3)}`
}
