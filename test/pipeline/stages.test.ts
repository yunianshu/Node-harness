import { describe, expect, it, vi } from 'vitest'
import { invokeRetryOnTruncation, Stage, StageContext } from '../../src/pipeline/stages/stage'
import { WriterStage, WriterInput } from '../../src/pipeline/stages/writer'
import { ChapterOutlineSchema } from '../../src/pipeline/schemas'
import { StylePackSchema } from '../../src/quality/style-pack-loader'
import type { ChatResponse } from '../../src/model/providers/openai-compat'
import type { ModelGateway } from '../../src/model/gateway'

function resp(finishReason: string | null, content: string): ChatResponse {
  return { content, finishReason, usage: null, raw: {} }
}

describe('invokeRetryOnTruncation（推理模型截断重试）', () => {
  it('正常完成（非 length）不重试', async () => {
    const invoke = vi.fn().mockResolvedValue(resp('stop', '{"score":8}'))
    const out = await invokeRetryOnTruncation(invoke)
    expect(out.finishReason).toBe('stop')
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('finish_reason=length 时重试一次，第二次成功即返回', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(resp('length', '{"score":7'))
      .mockResolvedValueOnce(resp('stop', '{"score":8}'))
    const out = await invokeRetryOnTruncation(invoke)
    expect(out.finishReason).toBe('stop')
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('重试仍 length 时返回最后一次结果（由调用方决定如何处置）', async () => {
    const invoke = vi.fn().mockResolvedValue(resp('length', '{"score":7'))
    const out = await invokeRetryOnTruncation(invoke)
    expect(out.finishReason).toBe('length')
    expect(invoke).toHaveBeenCalledTimes(2)
  })
})

const outline = ChapterOutlineSchema.parse({
  chapter: 1,
  title: '第1章',
  summary: '摘要',
  keyEvents: ['事件'],
  scenes: [{ seq: 1, locationRef: '某地', timeAdvance: '黄昏', purpose: '推进' }],
})
const stylePack = StylePackSchema.parse({
  packId: 'test',
  displayName: '测试',
  anchors: [{ anchorId: 'a', rule: '短句' }],
  exemplars: [
    { plain: '他来了。', styled: '他来了。' },
    { plain: '他说。', styled: '他说。' },
    { plain: '天冷了。', styled: '天冷了。' },
  ],
  checklist: [{ anchorId: 'a', question: '是否短句？' }],
})
const writerInput: WriterInput = {
  chapter: 1,
  outline,
  world: { worldview: '漠北' },
  charactersDigest: '',
  injection: null,
  previousChapterEnding: null,
  mode: 'first',
  reviewFeedback: null,
  aiFlavorHits: [],
  guidanceNote: null,
  stylePack,
  wordRange: { min: 2000, max: 3000 },
}

describe('WriterStage（正文截断守卫）', () => {
  const ctxWithGateway = (invoke: ModelGateway['invoke']): StageContext => ({
  projectId: 'p',
  gateway: {
    invoke,
    // Task #10 后 writer 首轮流式面：委托同一 invoke mock，length 截断重试仍走直接 invoke
    async invokeStream(role, request, ctx, onDelta) {
      const res = await invoke(role, request, ctx)
      onDelta?.(res.content)
      return res
    },
  } as ModelGateway,
  log: () => {},
})

  it('finish_reason=length 时重试一次，第二次完整即返回正文', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(resp('length', '正文……精神了'))
      .mockResolvedValueOnce(resp('stop', '正文……精神了。\n\n他翻身上车，走了。'))
    const out = await new WriterStage().execute(writerInput, ctxWithGateway(invoke as unknown as ModelGateway['invoke']))
    expect(out.endsWith('走了。')).toBe(true)
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('重试仍 length 时抛错，不让半截正文流入终稿', async () => {
    const invoke = vi.fn().mockResolvedValue(resp('length', '正文……精神了'))
    const stage = new WriterStage()
    await expect(stage.execute(writerInput, ctxWithGateway(invoke as unknown as ModelGateway['invoke']))).rejects.toThrow(/token 预算截断/)
    expect(invoke).toHaveBeenCalledTimes(2)
  })
})

describe('Stage.execute 补全原因提取（detail）', () => {
  const baseCtx = (log: (e: unknown) => void): StageContext => ({
    projectId: 'p',
    gateway: {
      setBindings: () => {},
      channelStatus: () => [],
      invoke: async () => ({ content: '', finishReason: 'stop' as const, usage: null, raw: {} }),
      invokeStream: async () => ({ content: '', finishReason: 'stop' as const, usage: null, raw: {} }),
    } as unknown as ModelGateway,
    log,
  })

  class ThrowingStage extends Stage<unknown, unknown> {
    constructor(private readonly err: unknown) {
      super('planner')
    }
    protected async run(): Promise<unknown> {
      throw this.err
    }
  }

  it('带 problems 数组的错误：detail 合并写入 failed 日志', async () => {
    const logged: Array<Record<string, unknown>> = []
    const err = new Error('x') as Error & { problems?: string[] }
    err.problems = ['人物关系未闭合', '地点缺氛围基调']
    await expect(new ThrowingStage(err).execute(null, baseCtx((e) => logged.push(e as Record<string, unknown>)))).rejects.toBe(err)
    expect(logged[0].result).toBe('failed')
    expect(logged[0].errorClass).toBe('Error')
    expect(logged[0].detail).toBe('人物关系未闭合；地点缺氛围基调')
  })

  it('无 problems 的错误：detail 缺省', async () => {
    const logged: Array<Record<string, unknown>> = []
    await expect(
      new ThrowingStage(new Error('普通错误')).execute(null, baseCtx((e) => logged.push(e as Record<string, unknown>))),
    ).rejects.toThrow('普通错误')
    expect(logged[0].result).toBe('failed')
    expect(logged[0].detail).toBeUndefined()
  })

  it('problems 非字符串数组时不上 detail（结构化守卫，防异常载荷泄漏）', async () => {
    const logged: Array<Record<string, unknown>> = []
    const err = new Error('x') as Error & { problems?: unknown }
    err.problems = [42, 'str']
    await expect(new ThrowingStage(err).execute(null, baseCtx((e) => logged.push(e as Record<string, unknown>)))).rejects.toBe(err)
    expect(logged[0].detail).toBeUndefined()
  })
})
