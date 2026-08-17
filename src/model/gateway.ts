import type { HostProvider } from '../host/types.js'
import type { ModelBinding, PipelineRole } from '../project/schema.js'
import { FallbackNeededError, ChannelManager, ChannelStatusSnapshot } from './fallback.js'
import { FallbackHop, ModelExhaustedError } from './errors.js'
import { ProviderRegistry } from './registry.js'
import { GlobalRateLimiter } from './rate-limiter.js'
import { ChatMessage, ChatParams, ChatResponse, chatCompletion, rawResponseFileName } from './providers/openai-compat.js'
import { join } from 'node:path'

export interface LlmRequest {
  system?: string
  user: string
  params?: ChatParams
}

export interface InvokeContext {
  projectId: string
  chapter?: number
}

export interface ModelGatewayOptions {
  registry: ProviderRegistry
  limiter: GlobalRateLimiter
  channels: ChannelManager
  host: HostProvider
  dataRoot: string
  fetchImpl?: typeof fetch
}

export class NoBindingError extends Error {
  readonly code = 'NO_BINDING'
  constructor(role: string) {
    super(`角色未绑定模型：${role}`)
    this.name = 'NoBindingError'
  }
}

export class ModelGateway {
  constructor(private readonly options: ModelGatewayOptions) {}

  private bindings = new Map<PipelineRole, ModelBinding>()

  setBindings(bindings: ModelBinding[]): void {
    this.bindings = new Map(bindings.map((b) => [b.role, b]))
  }

  async invoke(role: PipelineRole, request: LlmRequest, ctx: InvokeContext): Promise<ChatResponse> {
    const binding = this.bindings.get(role)
    if (!binding) throw new NoBindingError(role)

    const messages: ChatMessage[] = []
    if (request.system) messages.push({ role: 'system', content: request.system })
    messages.push({ role: 'user', content: request.user })

    const chain = [binding.primary, ...binding.fallbacks]
    const trail: FallbackHop[] = []
    let lastFatal: unknown = null

    for (const endpoint of chain) {
      const provider = this.options.registry.get(endpoint.providerId)
      if (!provider) {
        trail.push({
          providerId: endpoint.providerId,
          model: endpoint.model,
          accessMode: endpoint.accessMode,
          attempts: 0,
          lastError: '服务商未注册',
        })
        continue
      }
      if (!provider.credential) {
        trail.push({
          providerId: endpoint.providerId,
          model: endpoint.model,
          accessMode: endpoint.accessMode,
          attempts: 0,
          lastError: '凭据未附加',
        })
        continue
      }
      const channelKey = { providerId: provider.providerId, accessMode: endpoint.accessMode }
      if (!this.options.channels.isAvailable(channelKey)) {
        trail.push({
          providerId: endpoint.providerId,
          model: endpoint.model,
          accessMode: endpoint.accessMode,
          attempts: 0,
          lastError: `通道不可用（${this.options.channels.status().find((s) => s.key === `${channelKey.providerId}::${channelKey.accessMode}`)?.state ?? 'unknown'}）`,
        })
        continue
      }

      const rateKey = `${endpoint.providerId}::${endpoint.accessMode}`
      await this.options.limiter.acquire(rateKey, provider.qps)

      const secret = await this.options.host.credentials.get(provider.credential)
      const logFile = join(
        this.options.dataRoot,
        'novels',
        ctx.projectId,
        'logs',
        'raw_responses',
        rawResponseFileName(role, ctx.chapter),
      )

      let attempts = 0
      try {
        const response = await this.options.channels.execute(channelKey, async () => {
          attempts++
          return chatCompletion(
            {
              baseURL: provider.baseURL,
              apiKey: secret,
              model: endpoint.model,
              messages,
              params: {
                temperature: request.params?.temperature ?? binding.temperature,
                maxOutputTokens: request.params?.maxOutputTokens ?? binding.maxOutputTokens,
              },
              logFile,
            },
            this.options.fetchImpl,
          )
        })
        await this.options.channels.persist()
        return response
      } catch (err) {
        lastFatal = err
        if (err instanceof FallbackNeededError) {
          trail.push({
            providerId: endpoint.providerId,
            model: endpoint.model,
            accessMode: endpoint.accessMode,
            attempts,
            lastError: err.cause.message,
          })
          await this.options.channels.persist()
          continue
        }
        trail.push({
          providerId: endpoint.providerId,
          model: endpoint.model,
          accessMode: endpoint.accessMode,
          attempts,
          lastError: err instanceof Error ? err.message : String(err),
        })
        continue
      }
    }

    throw new ModelExhaustedError(`角色 ${role} 全部模型不可用：${trailOf(trail)}`, trail)
  }

  channelStatus(): ChannelStatusSnapshot[] {
    return this.options.channels.status()
  }
}

function trailOf(hops: FallbackHop[]): string {
  return hops.map((h) => `${h.providerId}/${h.model}(${h.attempts}次:${h.lastError})`).join(' → ')
}