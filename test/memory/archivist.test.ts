import { describe, expect, it } from 'vitest'
import { extractSpatiotemporalWithLlm } from '../../src/memory/archivist'
import type { ModelGateway } from '../../src/model/gateway'
import type { LlmRequest } from '../../src/model/gateway'

function gatewayWith(content: string | Error): ModelGateway {
  return {
    setBindings: () => {},
    channelStatus: () => [],
    invoke: async (_role: string, _req: LlmRequest) => {
      if (content instanceof Error) throw content
      return {
        content,
        finishReason: 'stop',
        usage: null,
        raw: {},
      }
    },
  } as unknown as ModelGateway
}

const input = {
  chapter: 9,
  finalText: '……他一路向西，最后停在了雪山山洞的洞口。',
  locationNames: ['雪山山洞', '长街', '渡口'],
  projectId: 'p1',
}

describe('archivist fallback', () => {
  it('extracts spacetime from LLM JSON response', async () => {
    const gw = gatewayWith('{"endLocation":"雪山山洞","endDescription":"洞口风雪","timeline":"三日后"}')
    const outcome = await extractSpatiotemporalWithLlm(gw, input)
    expect(outcome.kind).toBe('extracted')
    if (outcome.kind === 'extracted') {
      expect(outcome.entry.endScene.location).toBe('雪山山洞')
      expect(outcome.entry.timeline).toBe('三日后')
      expect(outcome.entry.status).toBe('valid')
    }
  })

  it('LLM garbage → pending-manual (spec 5.5.3 scenario 2)', async () => {
    const gw = gatewayWith('抱歉我不明白你的意思')
    const outcome = await extractSpatiotemporalWithLlm(gw, input)
    expect(outcome.kind).toBe('pending-manual')
  })

  it('LLM failure (exhausted models) → pending-manual with reason', async () => {
    const gw = gatewayWith(new Error('model exhausted'))
    const outcome = await extractSpatiotemporalWithLlm(gw, input)
    expect(outcome.kind).toBe('pending-manual')
    if (outcome.kind === 'pending-manual') {
      expect(outcome.reason).toContain('model exhausted')
    }
  })

  it('location not in archive list → pending-manual', async () => {
    const gw = gatewayWith('{"endLocation":"不存在的地点","timeline":"次日"}')
    const outcome = await extractSpatiotemporalWithLlm(gw, input)
    expect(outcome.kind).toBe('pending-manual')
  })
})