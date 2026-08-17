import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeHost } from '../../src/host/dsh-adapter'
import { ChannelManager } from '../../src/model/fallback'
import { ModelExhaustedError } from '../../src/model/errors'
import { ModelGateway } from '../../src/model/gateway'
import { ProviderRegistry } from '../../src/model/registry'
import { GlobalRateLimiter } from '../../src/model/rate-limiter'
import type { ModelBinding } from '../../src/project/schema'

interface Recorded {
  url: string
  auth: string
  body: any
}

async function setup(responses: Array<(rec: Recorded) => Response>) {
  const root = await mkdtemp(join(tmpdir(), 'gw-'))
  const host = new FakeHost(root)
  const registry = new ProviderRegistry()
  registry.register({ providerId: 'glm', kind: 'openai-compat', baseURL: 'http://glm.mock/v4', qps: 1000 })
  registry.register({ providerId: 'minimax', kind: 'openai-compat', baseURL: 'http://mmx.mock/v1', qps: 1000 })
  const glmKey = await host.credentials.put({ providerId: 'glm', kind: 'api-key' }, 'sk-glm-secret')
  const mmxKey = await host.credentials.put({ providerId: 'minimax', kind: 'api-key' }, 'sk-mmx-secret')
  registry.attachCredential('glm', glmKey)
  registry.attachCredential('minimax', mmxKey)

  const recorded: Recorded[] = []
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    const rec: Recorded = { url, auth: String(init.headers && (init.headers as Record<string, string>)['authorization']), body: JSON.parse(String(init.body)) }
    recorded.push(rec)
    const responder = responses[recorded.length - 1] ?? (() => okResponse())
    return responder(rec)
  }

  const gateway = new ModelGateway({
    registry,
    limiter: new GlobalRateLimiter(1000),
    channels: new ChannelManager({ maxRetries: 0, initialDelayMs: 1, fallbackThreshold: 1, sleep: async () => {} }),
    host,
    dataRoot: root,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  })
  return { gateway, recorded, root }
}

function okResponse(content = '好的，这是内容。'): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
}

const bindings: ModelBinding[] = [
  {
    role: 'writer',
    primary: { providerId: 'glm', model: 'glm-4.6', accessMode: 'pay-as-you-go' },
    fallbacks: [{ providerId: 'minimax', model: 'MiniMax-M2.7', accessMode: 'pay-as-you-go' }],
    temperature: 0.7,
  },
  {
    role: 'reviewer',
    primary: { providerId: 'minimax', model: 'MiniMax-M2.7', accessMode: 'pay-as-you-go' },
    fallbacks: [],
    temperature: 0.3,
  },
]

describe('model gateway', () => {
  it('routes writer→GLM and reviewer→MiniMax, distinguishable in logs (spec 5.2.1 rule 1)', async () => {
    const { gateway, recorded } = await setup([() => okResponse(), () => okResponse()])
    gateway.setBindings(bindings)
    const ctx = { projectId: 'p1' }
    const w = await gateway.invoke('writer', { user: '写第一章' }, ctx)
    const r = await gateway.invoke('reviewer', { user: '审查' }, ctx)
    expect(w.content).toBeTruthy()
    expect(r.content).toBeTruthy()
    expect(recorded[0].url).toContain('http://glm.mock/v4/chat/completions')
    expect(recorded[0].body.model).toBe('glm-4.6')
    expect(recorded[0].body.temperature).toBe(0.7)
    expect(recorded[1].url).toContain('http://mmx.mock/v1/chat/completions')
    expect(recorded[1].body.temperature).toBe(0.3)
  })

  it('falls back to minimax after glm auth failure (spec 5.2.1 rule 4 acceptance)', async () => {
    const { gateway, recorded } = await setup([
      () => new Response('{"error":"unauthorized"}', { status: 401 }),
      () => okResponse('备选模型内容'),
    ])
    gateway.setBindings(bindings)
    const res = await gateway.invoke('writer', { user: '写' }, { projectId: 'p1' })
    expect(res.content).toBe('备选模型内容')
    expect(recorded).toHaveLength(2)
    expect(recorded[1].url).toContain('mmx.mock')
    expect(gateway.channelStatus().some((s) => s.state === 'circuit-open' && s.key.startsWith('glm'))).toBe(true)
  })

  it('all models exhausted → ModelExhaustedError with trail', async () => {
    const { gateway } = await setup([
      () => new Response('{"error":"unauthorized"}', { status: 401 }),
      () => new Response('{"error":"unauthorized"}', { status: 403 }),
    ])
    gateway.setBindings(bindings)
    const err = await gateway.invoke('writer', { user: '写' }, { projectId: 'p1' }).catch((e) => e)
    expect(err).toBeInstanceOf(ModelExhaustedError)
    expect(err.trail).toHaveLength(2)
  })

  it('role without binding throws NO_BINDING', async () => {
    const { gateway } = await setup([])
    await expect(gateway.invoke('planner', { user: '规划' }, { projectId: 'p1' })).rejects.toMatchObject({
      code: 'NO_BINDING',
    })
  })
})