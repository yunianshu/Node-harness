import type { CredentialHandle } from '../host/types.js'
import type { AccessMode, ModelBinding, PipelineRole } from '../project/schema.js'
import { EndpointTokenMismatchError } from './errors.js'

export const GLM_PAY_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4'
export const GLM_PLAN_CN_BASE_URL = 'https://open.bigmodel.cn/api/coding/paas/v4'
export const GLM_PLAN_INTL_BASE_URL = 'https://api.z.ai/api/coding/paas/v4'

export type ProviderKind = 'openai-compat' | 'glm-plan-cn' | 'glm-plan-intl'

export interface ProviderDef {
  providerId: string
  kind: ProviderKind
  baseURL: string
  qps?: number
}

export interface RegisteredProvider extends ProviderDef {
  qps: number
  credential: CredentialHandle | null
}

export interface BindingValidation {
  ok: boolean
  warnings: string[]
  errors: string[]
}

export class ProviderRegistry {
  private readonly providers = new Map<string, RegisteredProvider>()
  private readonly kindEndpoints: Record<ProviderKind, string> = {
    'openai-compat': '',
    'glm-plan-cn': GLM_PLAN_CN_BASE_URL,
    'glm-plan-intl': GLM_PLAN_INTL_BASE_URL,
  }

  register(def: ProviderDef): string {
    if (this.providers.has(def.providerId)) {
      throw new Error(`服务商已注册：${def.providerId}`)
    }
    const expected = this.kindEndpoints[def.kind]
    if (expected && def.baseURL !== expected) {
      throw new EndpointTokenMismatchError(
        `接入方式 ${def.kind} 要求端点 ${expected}，实际配置 ${def.baseURL}`,
      )
    }
    if (def.kind === 'openai-compat' && (def.baseURL === GLM_PLAN_CN_BASE_URL || def.baseURL === GLM_PLAN_INTL_BASE_URL)) {
      throw new EndpointTokenMismatchError('订阅端点必须以 glm-plan-cn / glm-plan-intl 接入方式注册')
    }
    this.providers.set(def.providerId, { ...def, qps: def.qps ?? 2, credential: null })
    return def.providerId
  }

  attachCredential(providerId: string, handle: CredentialHandle): void {
    const provider = this.require(providerId)
    if (provider.kind === 'openai-compat') {
      if (handle.kind !== 'api-key') {
        throw new EndpointTokenMismatchError(
          `按量计费端点 ${provider.baseURL} 仅接受 API Key 凭据，收到 ${handle.kind}`,
        )
      }
    } else {
      if (handle.kind !== 'plan-token') {
        throw new EndpointTokenMismatchError(
          `订阅端点 ${provider.baseURL} 仅接受订阅 token 凭据，收到 ${handle.kind}`,
        )
      }
      const requiredChannel = provider.kind === 'glm-plan-cn' ? 'cn' : 'intl'
      if (handle.channel && handle.channel !== requiredChannel) {
        throw new EndpointTokenMismatchError(
          `端点与订阅 token 版本不匹配：${provider.baseURL} 需要 ${requiredChannel === 'cn' ? '国内版' : '国际版'} token`,
        )
      }
    }
    this.providers.set(providerId, { ...provider, credential: handle })
  }

  get(providerId: string): RegisteredProvider | undefined {
    return this.providers.get(providerId)
  }

  require(providerId: string): RegisteredProvider {
    const p = this.providers.get(providerId)
    if (!p) throw new Error(`服务商未注册：${providerId}`)
    return p
  }

  list(): RegisteredProvider[] {
    return [...this.providers.values()]
  }

  accessModeOfProvider(provider: RegisteredProvider): AccessMode {
    if (provider.kind === 'glm-plan-cn') return 'glm-plan-cn'
    if (provider.kind === 'glm-plan-intl') return 'glm-plan-intl'
    return 'pay-as-you-go'
  }

  validateBindings(bindings: ModelBinding[]): BindingValidation {
    const warnings: string[] = []
    const errors: string[] = []
    for (const binding of bindings) {
      const refs = [binding.primary, ...binding.fallbacks]
      for (const ref of refs) {
        const provider = this.providers.get(ref.providerId)
        if (!provider) {
          errors.push(`角色 ${binding.role}：服务商未注册 ${ref.providerId}`)
          continue
        }
        if (!provider.credential) {
          errors.push(`角色 ${binding.role}：服务商 ${ref.providerId} 未附加凭据`)
        }
        const providerMode = this.accessModeOfProvider(provider)
        if (ref.accessMode !== providerMode) {
          errors.push(
            `角色 ${binding.role}：模型 ${ref.model} 的接入方式 ${ref.accessMode} 与服务商 ${ref.providerId} 实际通道 ${providerMode} 不匹配`,
          )
        }
      }
    }
    const writer = bindings.find((b) => b.role === 'writer')
    const reviewer = bindings.find((b) => b.role === 'reviewer')
    if (writer && reviewer) {
      const samePrimary =
        writer.primary.providerId === reviewer.primary.providerId && writer.primary.model === reviewer.primary.model
      const sameParams = writer.temperature === reviewer.temperature && writer.maxOutputTokens === reviewer.maxOutputTokens
      if (samePrimary && sameParams) {
        warnings.push('SELF_REVIEW_WARNING：写作与审查建议使用不同模型或参数')
      }
    }
    return { ok: errors.length === 0, warnings, errors }
  }
}

export type RoleBindings = Map<PipelineRole, ModelBinding>