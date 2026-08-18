import { describe, expect, it, vi } from 'vitest'
import { invokeRetryOnTruncation, StageContext } from '../../src/pipeline/stages/stage'
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
  const ctxWithGateway = (invoke: ModelGateway['invoke']): StageContext => ({ projectId: 'p', gateway: { invoke } as ModelGateway, log: () => {} })

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
