import { describe, expect, it } from 'vitest'
import { FakeHost } from '../../src/host/dsh-adapter'
import {
  GLM_PAY_BASE_URL,
  GLM_PLAN_CN_BASE_URL,
  GLM_PLAN_INTL_BASE_URL,
  ProviderRegistry,
} from '../../src/model/registry'
import { EndpointTokenMismatchError } from '../../src/model/errors'
import type { ModelBinding } from '../../src/project/schema'

function setup() {
  const registry = new ProviderRegistry()
  const host = new FakeHost()
  return { registry, host }
}

async function setupGlmChannels() {
  const { registry, host } = setup()
  registry.register({ providerId: 'glm', kind: 'openai-compat', baseURL: GLM_PAY_BASE_URL })
  registry.register({ providerId: 'glm-plan-cn', kind: 'glm-plan-cn', baseURL: GLM_PLAN_CN_BASE_URL })
  registry.register({ providerId: 'glm-plan-intl', kind: 'glm-plan-intl', baseURL: GLM_PLAN_INTL_BASE_URL })
  registry.register({ providerId: 'deepseek', kind: 'openai-compat', baseURL: 'https://api.deepseek.com/v1' })
  const apiKey = await host.credentials.put({ providerId: 'glm', kind: 'api-key' }, 'sk-pay-key')
  const cnToken = await host.credentials.put({ providerId: 'glm-plan-cn', kind: 'plan-token', channel: 'cn' }, 'cn-token')
  const intlToken = await host.credentials.put({ providerId: 'glm-plan-intl', kind: 'plan-token', channel: 'intl' }, 'intl-token')
  const dsKey = await host.credentials.put({ providerId: 'deepseek', kind: 'api-key' }, 'sk-ds')
  return { registry, host, apiKey, cnToken, intlToken, dsKey }
}

describe('provider registry', () => {
  it('rejects kind/endpoint mismatch at registration', () => {
    const { registry } = setup()
    expect(() =>
      registry.register({ providerId: 'bad', kind: 'glm-plan-cn', baseURL: GLM_PLAN_INTL_BASE_URL }),
    ).toThrow(EndpointTokenMismatchError)
    expect(() =>
      registry.register({ providerId: 'bad2', kind: 'openai-compat', baseURL: GLM_PLAN_CN_BASE_URL }),
    ).toThrow(EndpointTokenMismatchError)
  })

  it('pay endpoint accepts only api-key credentials', async () => {
    const { registry, host } = await setupGlmChannels()
    const wrong = await host.credentials.put({ providerId: 'glm', kind: 'plan-token', channel: 'cn' }, 'token')
    expect(() => registry.attachCredential('glm', wrong)).toThrow(EndpointTokenMismatchError)
  })

  it('cn plan token attached to intl endpoint is intercepted (spec 5.2.1 rule 5b)', async () => {
    const { registry, cnToken } = await setupGlmChannels()
    expect(() => registry.attachCredential('glm-plan-intl', cnToken)).toThrow(/端点与订阅 token 版本不匹配/)
  })

  it('intl token attached to intl endpoint passes', async () => {
    const { registry, intlToken } = await setupGlmChannels()
    expect(() => registry.attachCredential('glm-plan-intl', intlToken)).not.toThrow()
  })

  it('same account api key and plan token are two independent credentials', async () => {
    const host = new FakeHost()
    const apiKey = await host.credentials.put({ providerId: 'glm', kind: 'api-key' }, 'sk-1')
    const token = await host.credentials.put({ providerId: 'glm', kind: 'plan-token', channel: 'cn' }, 'tk-1')
    expect(apiKey.credentialId).not.toBe(token.credentialId)
    const disabled = await host.credentials.setEnabled(apiKey, false)
    expect(disabled.enabled).toBe(false)
    expect((await host.credentials.list()).find((h) => h.credentialId === token.credentialId)?.enabled).toBe(true)
  })
})

describe('validateBindings', () => {
  it('flags unregistered provider and missing credential', async () => {
    const { registry, apiKey, dsKey } = await setupGlmChannels()
    registry.attachCredential('glm', apiKey)
    registry.attachCredential('deepseek', dsKey)
    const bindings: ModelBinding[] = [
      {
        role: 'writer',
        primary: { providerId: 'glm', model: 'glm-4.6', accessMode: 'pay-as-you-go' },
        fallbacks: [{ providerId: 'unknown-provider', model: 'x', accessMode: 'pay-as-you-go' }],
        temperature: 0.7,
      },
    ]
    const result = registry.validateBindings(bindings)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.includes('unknown-provider'))).toBe(true)
  })

  it('flags accessMode mismatch for GLM binding', async () => {
    const { registry, cnToken } = await setupGlmChannels()
    registry.attachCredential('glm-plan-cn', cnToken)
    const bindings: ModelBinding[] = [
      {
        role: 'writer',
        primary: { providerId: 'glm-plan-cn', model: 'glm-4.6', accessMode: 'pay-as-you-go' },
        fallbacks: [],
        temperature: 0.7,
      },
    ]
    const result = registry.validateBindings(bindings)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.includes('接入方式'))).toBe(true)
  })

  it('emits SELF_REVIEW_WARNING for identical writer/reviewer binding', async () => {
    const { registry, apiKey, dsKey } = await setupGlmChannels()
    registry.attachCredential('glm', apiKey)
    registry.attachCredential('deepseek', dsKey)
    const same = {
      primary: { providerId: 'glm', model: 'glm-4.6', accessMode: 'pay-as-you-go' },
      fallbacks: [],
      temperature: 0.7,
      maxOutputTokens: 8192,
      fallbackThreshold: 5,
    }
    const result = registry.validateBindings([
      { ...same, role: 'writer' },
      { ...same, role: 'reviewer' },
    ])
    expect(result.ok).toBe(true)
    expect(result.warnings.some((w) => w.startsWith('SELF_REVIEW_WARNING'))).toBe(true)
  })
})