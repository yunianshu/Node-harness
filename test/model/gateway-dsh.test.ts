import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeHost } from '../../src/host/dsh-adapter'
import type { HostLlmDelta, HostLlmRequest } from '../../src/host/types'
import { ChannelManager } from '../../src/model/fallback'
import { ModelExhaustedError } from '../../src/model/errors'
import { ModelGateway, parseDshModel, stripDshReasoning, stripDshReasoningDelta } from '../../src/model/gateway'
import { DSL_PROVIDER, ProviderRegistry } from '../../src/model/registry'
import { GlobalRateLimiter } from '../../src/model/rate-limiter'
import { defaultDshBindings } from '../../src/project/service'
import type { ModelBinding } from '../../src/project/schema'

/** 模拟 dsh 底座 LLM 流式面：每次 stream() 调用按序消费一组增量（支持失败/截断）。 */
function fakeDshLlm(responses: HostLlmDelta[][]) {
  const requests: HostLlmRequest[] = []
  const queue = [...responses]
  const stream = async function* (req: HostLlmRequest): AsyncIterable<HostLlmDelta> {
    requests.push(req)
    const deltas = queue.shift() ?? []
    for (const d of deltas) yield d
  }
  return { requests, stream }
}

async function setup(dsh: { requests: HostLlmRequest[]; stream: (req: HostLlmRequest) => AsyncIterable<HostLlmDelta> }) {
  const root = await mkdtemp(join(tmpdir(), 'gw-dsh-'))
  const host = new FakeHost(root, {
    listModels: async () => [{ provider: 'zai-coding-cn', model: 'glm-5.2' }],
    stream: dsh.stream,
  })
  const registry = new ProviderRegistry()
  const gateway = new ModelGateway({
    registry,
    limiter: new GlobalRateLimiter(1000),
    channels: new ChannelManager({ maxRetries: 0, initialDelayMs: 1, fallbackThreshold: 1, sleep: async () => {} }),
    host,
    dataRoot: root,
  })
  return { gateway, dsh }
}

const dshBinding: ModelBinding = {
  role: 'writer',
  primary: { providerId: DSL_PROVIDER, model: 'zai-coding-cn/glm-5.2', accessMode: 'pay-as-you-go' },
  fallbacks: [],
  temperature: 0.9,
  maxOutputTokens: 16384,
  fallbackThreshold: 5,
}

describe('dsh 模型执行器（gateway dsh 分支）', () => {
  it('parseDshModel 解析 route/model；格式非法返回 null', () => {
    expect(parseDshModel('zai-coding-cn/glm-5.2')).toEqual({ provider: 'zai-coding-cn', model: 'glm-5.2' })
    expect(parseDshModel('no-slash')).toBeNull()
    expect(parseDshModel('/leading')).toBeNull()
    expect(parseDshModel('trailing/')).toBeNull()
  })

  it('invoke 聚合 host.llm 流式增量，透传 system/temperature/maxTokens', async () => {
    const dsh = fakeDshLlm([[{ text: '第一章' }, { text: '正文', finish: 'stop' }]])
    const { gateway } = await setup(dsh)
    gateway.setBindings([dshBinding])
    const res = await gateway.invoke('writer', { system: '你是作家', user: '写第一章', params: { temperature: 0.5, maxOutputTokens: 8000 } }, { projectId: 'p1', chapter: 1 })
    expect(res.content).toBe('第一章正文')
    expect(res.finishReason).toBe('stop')
    expect(dsh.requests).toHaveLength(1)
    expect(dsh.requests[0]).toMatchObject({
      provider: 'zai-coding-cn',
      model: 'glm-5.2',
      system: '你是作家',
      user: '写第一章',
      temperature: 0.5,
      maxTokens: 8000,
    })
  })

  it('invokeStream 逐 delta 增量回调剥离后的正文段（正文流式 Task #8）', async () => {
    const dsh = fakeDshLlm([[{ text: '第' }, { text: '一' }, { text: '章', finish: 'stop' }]])
    const { gateway } = await setup(dsh)
    gateway.setBindings([dshBinding])
    const chunks: string[] = []
    const res = await gateway.invokeStream('writer', { user: '写' }, { projectId: 'p1' }, (t) => chunks.push(t))
    expect(chunks).toEqual(['第', '一', '章'])
    expect(res.content).toBe('第一章')
  })

  it('max-tokens 截断 → finishReason length（writer 重试依据）', async () => {
    const dsh = fakeDshLlm([[{ text: '半截正文', finish: 'length' }]])
    const { gateway } = await setup(dsh)
    gateway.setBindings([dshBinding])
    const res = await gateway.invoke('writer', { user: '写' }, { projectId: 'p1' })
    expect(res.content).toBe('半截正文')
    expect(res.finishReason).toBe('length')
  })

  it('主模型失败 → 降级到 fallback dsh 端点', async () => {
    const dsh = fakeDshLlm([[{ finish: 'error' }], [{ text: '备选内容', finish: 'stop' }]])
    const { gateway } = await setup(dsh)
    gateway.setBindings([{ ...dshBinding, fallbacks: [{ providerId: DSL_PROVIDER, model: 'hprt/glm-5.1', accessMode: 'pay-as-you-go' }] }])
    const res = await gateway.invoke('writer', { user: '写' }, { projectId: 'p1' })
    expect(res.content).toBe('备选内容')
    expect(dsh.requests.map((r) => `${r.provider}/${r.model}`)).toEqual(['zai-coding-cn/glm-5.2', 'hprt/glm-5.1'])
  })

  it('全部 dsh 模型失败 → ModelExhaustedError 携带 trail', async () => {
    const dsh = fakeDshLlm([[{ finish: 'error' }], [{ finish: 'aborted' }]])
    const { gateway } = await setup(dsh)
    gateway.setBindings([{ ...dshBinding, fallbacks: [{ providerId: DSL_PROVIDER, model: 'hprt/glm-5.1', accessMode: 'pay-as-you-go' }] }])
    const err = await gateway.invoke('writer', { user: '写' }, { projectId: 'p1' }).catch((e) => e)
    expect(err).toBeInstanceOf(ModelExhaustedError)
    expect(err.trail).toHaveLength(2)
  })

  it('invokeStream 推理流三分段逐 delta：只回调答案增量，不泄漏推理块', async () => {
    // zai-coding-cn 推理流把每个推理 token 包裹为 [思考]tok[思考]，答案在末尾
    const dsh = fakeDshLlm([[
      { text: '[思考] 拆' },
      { text: '[思考]' },
      { text: '[思考] 解' },
      { text: '[思考]' },
      { text: '  。我是' },
      { text: '答案。', finish: 'stop' },
    ]])
    const { gateway } = await setup(dsh)
    gateway.setBindings([dshBinding])
    const chunks: string[] = []
    const res = await gateway.invokeStream('writer', { user: '写' }, { projectId: 'p1' }, (t) => chunks.push(t))
    expect(chunks).toEqual(['我是', '答案。'])
    expect(res.content).toBe('我是答案。')
  })

  it('invokeStream <think> 块兼容：未闭合不输出，闭合后增量回调', async () => {
    const dsh = fakeDshLlm([[{ text: '<think>推理过程' }, { text: '</think>正文' }, { text: '内容', finish: 'stop' }]])
    const { gateway } = await setup(dsh)
    gateway.setBindings([dshBinding])
    const chunks: string[] = []
    const res = await gateway.invokeStream('writer', { user: '写' }, { projectId: 'p1' }, (t) => chunks.push(t))
    expect(chunks).toEqual(['正文', '内容'])
    expect(res.content).toBe('正文内容')
  })

  it('invokeStream 全部为推理无答案：聚合为空、不回调', async () => {
    const dsh = fakeDshLlm([[{ text: '[思考] 拆[思考] [思考] 解[思考]', finish: 'stop' }]])
    const { gateway } = await setup(dsh)
    gateway.setBindings([dshBinding])
    const chunks: string[] = []
    const res = await gateway.invokeStream('writer', { user: '写' }, { projectId: 'p1' }, (t) => chunks.push(t))
    expect(chunks).toEqual([])
    expect(res.content).toBe('')
  })

  it('invoke 非流式路径仍聚合剥离（不回归）', async () => {
    const dsh = fakeDshLlm([[{ text: '[思考] 拆[思考]  。我是答案。', finish: 'stop' }]])
    const { gateway } = await setup(dsh)
    gateway.setBindings([dshBinding])
    const res = await gateway.invoke('writer', { user: '写' }, { projectId: 'p1' })
    expect(res.content).toBe('我是答案。')
  })
})

describe('stripDshReasoning（推理块剥离）', () => {
  it('剥离 GLM [思考] 内联推理块（真实输出形态）', () => {
    const out = stripDshReasoning(
      '[思考] 1[思考] .[思考]  [思考]  **[思考] 拆[思考] 解[思考] 用户[思考] 请求[思考] 。我是一个在庞大文本和代码数据集上训练的大型语言模型，能够理解和生成类人文本，旨在通过回答问题、提供信息和进行创意写作来帮助您。"',
    )
    expect(out).toBe('我是一个在庞大文本和代码数据集上训练的大型语言模型，能够理解和生成类人文本，旨在通过回答问题、提供信息和进行创意写作来帮助您。"')
  })

  it('无推理标记原样返回', () => {
    expect(stripDshReasoning('纯正文，无思考块。')).toBe('纯正文，无思考块。')
  })

  it('剥离通用 <think> 块（含未闭合尾巴）', () => {
    expect(stripDshReasoning('<think>推理过程</think>正文内容')).toBe('正文内容')
    expect(stripDshReasoning('<think>未闭合推理尾巴')).toBe('')
  })

  it('增量剥离：配对块剥掉返回答案，未配对返回 null', () => {
    expect(stripDshReasoningDelta('[思考] 拆[思考]  。答案')).toBe('答案')
    expect(stripDshReasoningDelta('[思考] 拆')).toBeNull()
    expect(stripDshReasoningDelta('<think>推理</think>正文')).toBe('正文')
    expect(stripDshReasoningDelta('<think>未闭合')).toBeNull()
    expect(stripDshReasoningDelta('纯正文，无思考块。')).toBe('纯正文，无思考块。')
  })
})

describe('defaultDshBindings（未显式绑定模型的 dsh 默认值）', () => {
  it('六角色全部绑定 DSL_PROVIDER 且带降级链', () => {
    const bindings = defaultDshBindings()
    expect(bindings.map((b) => b.role)).toEqual(['planner', 'outliner', 'outline-reviewer', 'writer', 'reviewer', 'archivist'])
    for (const b of bindings) {
      expect(b.primary.providerId).toBe(DSL_PROVIDER)
      expect(b.fallbackThreshold).toBe(5)
      expect(b.primary.model).toMatch(/.+\/.+/)
    }
    const writer = bindings.find((b) => b.role === 'writer')!
    expect(writer.maxOutputTokens).toBe(16384)
  })

  it('validateBindings 对 dsh 引用短路（不要求注册/凭据，不报误错）', () => {
    const registry = new ProviderRegistry()
    const result = registry.validateBindings(defaultDshBindings())
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
  })
})
