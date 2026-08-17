import { describe, expect, it } from 'vitest'
import { ChannelManager, FallbackNeededError } from '../../src/model/fallback'
import { AuthError, EmptyResponseError, PlanLimitError, RetryableServerError } from '../../src/model/errors'

const channel = { providerId: 'glm', accessMode: 'pay-as-you-go' }

function manager(overrides: Partial<ConstructorParameters<typeof ChannelManager>[0]> = {}) {
  return new ChannelManager({
    maxRetries: 2,
    initialDelayMs: 1,
    fallbackThreshold: 3,
    sleep: async () => {},
    ...overrides,
  })
}

describe('channel manager', () => {
  it('retries retryable failures then succeeds (counter reset)', async () => {
    const m = manager()
    let calls = 0
    const result = await m.execute(channel, async () => {
      calls++
      if (calls < 3) throw new EmptyResponseError()
      return 'ok'
    })
    expect(result).toBe('ok')
    expect(m.status()[0].consecutiveFailures).toBe(0)
    expect(m.status()[0].state).toBe('normal')
  })

  it('auth error immediately circuit-opens without retry (spec 5.2.1 rule 5a)', async () => {
    const m = manager()
    let calls = 0
    await expect(
      m.execute(channel, async () => {
        calls++
        throw new AuthError('401')
      }),
    ).rejects.toBeInstanceOf(FallbackNeededError)
    expect(calls).toBe(1)
    expect(m.isAvailable(channel)).toBe(false)
    expect(m.status()[0].state).toBe('circuit-open')
  })

  it('consecutive failures beyond threshold trigger fallback event (spec 5.2.1 rule 4)', async () => {
    const events: string[] = []
    const m = manager({ onEvent: (e) => events.push(e.type) })
    let calls = 0
    await expect(
      m.execute(channel, async () => {
        calls++
        throw new RetryableServerError('500', 500)
      }),
    ).rejects.toBeInstanceOf(FallbackNeededError)
    expect(calls).toBe(3)
    expect(events).toContain('model.fallback')
    expect(m.status()[0].state).toBe('degraded')
  })

  it('plan limit error enters limit-wait state (spec 5.2.3 scenario 4)', async () => {
    const events: string[] = []
    const m = manager({ onEvent: (e) => events.push(e.type) })
    await expect(
      m.execute(channel, async () => {
        throw new PlanLimitError('limit')
      }),
    ).rejects.toBeInstanceOf(FallbackNeededError)
    expect(m.status()[0].state).toBe('limit-wait')
    expect(m.isAvailable(channel)).toBe(false)
    expect(events).toContain('model.plan-limit')
    m.markRecovered(channel)
    expect(m.isAvailable(channel)).toBe(true)
    expect(m.status()[0].state).toBe('normal')
  })

  it('circuit-open channel rejects immediately before calling provider', async () => {
    const m = manager()
    await expect(
      m.execute(channel, async () => {
        throw new AuthError('401')
      }),
    ).rejects.toBeInstanceOf(FallbackNeededError)
    let calls = 0
    await expect(
      m.execute(channel, async () => {
        calls++
        return 'never'
      }),
    ).rejects.toBeInstanceOf(FallbackNeededError)
    expect(calls).toBe(0)
  })
})