import type { HostProvider } from '../host/types.js'
import type { ModelBinding, PipelineRole } from '../project/schema.js'
import { FallbackNeededError, ChannelManager, ChannelStatusSnapshot } from './fallback.js'
import { FallbackHop, ModelExhaustedError } from './errors.js'
import { ProviderRegistry, DSL_PROVIDER } from './registry.js'
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

/** 解析 dsh 绑定 model 为 (provider route, model id) 二元组；格式不符返回 null。 */
export function parseDshModel(model: string): { provider: string; model: string } | null {
  const slash = model.indexOf('/')
  if (slash <= 0 || slash === model.length - 1) return null
  const provider = model.slice(0, slash)
  const rest = model.slice(slash + 1)
  if (provider.length === 0 || rest.length === 0) return null
  return { provider, model: rest }
}

/**
 * 剥离 dsh 推理模型（GLM-5.x 等）输出中的思考段。
 * zai-coding-cn 端点把推理流内联进 text-delta，每个推理 token 被 `[思考]` 包裹
 * （`[思考]X[思考]`），真答案在末尾无包裹；故取最后一个 `[思考]` 之后的内容，
 * 再清理推理尾巴残留的标点/空白。兼容通用 `<think>…</think>` 块（未闭合一并丢弃）。
 * 无推理标记时原样返回。
 */
export function stripDshReasoning(content: string): string {
  let out = content
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<think>[\s\S]*$/, '')
  const last = out.lastIndexOf('[思考]')
  if (last >= 0) {
    out = out.slice(last + '[思考]'.length)
  }
  return out.replace(/^[\s。！？；：、，,\.．'’“”"」『』…—-]+/, '')
}

/**
 * 增量版推理剥离：返回「当前确定是真答案」的文本段；推理块未闭合返回 null（调用方不输出）。
 * zai-coding-cn 推理流把每个推理 token 包裹为 `[思考]tok[思考]`，真答案在最后一个闭合
 * `[思考]` 之后。剥掉已配对块后若仍有未配对标记，说明推理仍在进行，等待配对闭合。
 * 与 stripDshReasoning 的差异：后者取「最后一个 [思考] 之后」容忍未闭合尾巴（聚合终值用），
 * 本函数在推理未闭合时不产出任何内容，保证流式 UI 不泄漏推理文本（Task #8 正文流式）。
 */
export function stripDshReasoningDelta(buffer: string): string | null {
  let out = buffer
    .replace(/\[思考\][\s\S]*?\[思考\]/g, '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
  if (out.includes('[思考]') || out.includes('<think>')) return null
  return out.replace(/^[\s。！？；：、，,\.．'’“”"」『』…—-]+/, '')
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

  /**
   * 流式调用入口：dsh 模型逐段回调 delta，外部模型一次性回调全文。
   * writer 阶段用它实现正文实时呈现（Task #8）。返回聚合后的完整响应。
   */
  async invokeStream(
    role: PipelineRole,
    request: LlmRequest,
    ctx: InvokeContext,
    onDelta?: (text: string) => void,
  ): Promise<ChatResponse> {
    const binding = this.bindings.get(role)
    if (!binding) throw new NoBindingError(role)
    if (binding.primary.providerId === DSL_PROVIDER) {
      return await this.invokeDsh(binding, request, ctx, onDelta)
    }
    const response = await this.invoke(role, request, ctx)
    onDelta?.(response.content)
    return response
  }

  async invoke(role: PipelineRole, request: LlmRequest, ctx: InvokeContext): Promise<ChatResponse> {
    const binding = this.bindings.get(role)
    if (!binding) throw new NoBindingError(role)

    // dsh 底座模型走 host.llm 流式面（凭据由底座管理，harness 零接触密钥）
    if (binding.primary.providerId === DSL_PROVIDER) {
      return await this.invokeDsh(binding, request, ctx)
    }

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

  /** dsh 底座模型链式调用：primary → fallbacks，均经 host.llm 流式面。 */
  private async invokeDsh(
    binding: ModelBinding,
    request: LlmRequest,
    _ctx: InvokeContext,
    onDelta?: (text: string) => void,
  ): Promise<ChatResponse> {
    const chain = [binding.primary, ...binding.fallbacks]
    const trail: FallbackHop[] = []
    for (const endpoint of chain) {
      if (endpoint.providerId !== DSL_PROVIDER) {
        trail.push({
          providerId: endpoint.providerId,
          model: endpoint.model,
          accessMode: endpoint.accessMode,
          attempts: 0,
          lastError: 'dsh 绑定含非 dsh 降级端点（混合降级暂不支持）',
        })
        continue
      }
      const parsed = parseDshModel(endpoint.model)
      if (!parsed) {
        trail.push({
          providerId: endpoint.providerId,
          model: endpoint.model,
          accessMode: endpoint.accessMode,
          attempts: 0,
          lastError: 'model 格式应为「provider route / model id」',
        })
        continue
      }
      let attempts = 0
      try {
        attempts++
        return await this.collectDsh(parsed, binding, request, onDelta)
      } catch (err) {
        trail.push({
          providerId: endpoint.providerId,
          model: endpoint.model,
          accessMode: endpoint.accessMode,
          attempts,
          lastError: err instanceof Error ? err.message : String(err),
        })
      }
    }
    throw new ModelExhaustedError(`角色 ${binding.role} 全部 dsh 模型不可用：${trailOf(trail)}`, trail)
  }

  /** 消费 host.llm 流式增量，聚合为完整响应并透传 delta 回调（增量剥离，推理不泄漏）。 */
  private async collectDsh(
    parsed: { provider: string; model: string },
    binding: ModelBinding,
    request: LlmRequest,
    onDelta?: (text: string) => void,
  ): Promise<ChatResponse> {
    let buffer = ''
    let emitted = 0
    let finish: 'stop' | 'length' | 'error' | 'aborted' = 'stop'
    let errorMsg = ''
    for await (const delta of this.options.host.llm.stream({
      provider: parsed.provider,
      model: parsed.model,
      ...(request.system !== undefined ? { system: request.system } : {}),
      user: request.user,
      temperature: request.params?.temperature ?? binding.temperature,
      maxTokens: request.params?.maxOutputTokens ?? binding.maxOutputTokens,
    })) {
      if (delta.text) buffer += delta.text
      if (delta.finish) finish = delta.finish
      if (delta.error) errorMsg = delta.error
      if (onDelta) {
        // 增量剥离：推理未闭合返回 null（不输出），闭合后只推「确定真答案」的新增段，
        // 保证流式 UI 不泄漏 GLM 推理块；推理期间 stripped 为空/回退时 emitted 保持。
        const stripped = stripDshReasoningDelta(buffer)
        if (stripped !== null && stripped.length > emitted) {
          const inc = stripped.slice(emitted)
          if (inc.length > 0) onDelta(inc)
          emitted = stripped.length
        }
      }
    }
    if (finish === 'error' || finish === 'aborted') {
      throw new Error(errorMsg || `dsh 模型调用${finish === 'aborted' ? '中止' : '失败'}`)
    }
    // 聚合终值用 stripDshReasoning（容忍未闭合尾巴），与增量累积一致（流结束时推理必闭合）。
    const content = stripDshReasoning(buffer)
    return { content, finishReason: finish === 'length' ? 'length' : 'stop', usage: null, raw: null }
  }

  channelStatus(): ChannelStatusSnapshot[] {
    return this.options.channels.status()
  }
}

function trailOf(hops: FallbackHop[]): string {
  return hops.map((h) => `${h.providerId}/${h.model}(${h.attempts}次:${h.lastError})`).join(' → ')
}