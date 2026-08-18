import { describe, expect, it, vi } from 'vitest'
import { invokeRetryOnTruncation } from '../../src/pipeline/stages/stage'
import type { ChatResponse } from '../../src/model/providers/openai-compat'

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
