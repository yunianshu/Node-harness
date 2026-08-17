import { describe, expect, it } from 'vitest'
import { GlobalRateLimiter } from '../../src/model/rate-limiter'

describe('global rate limiter', () => {
  it('4 concurrent acquires on same provider respect QPS interval (spec 4.1.1)', async () => {
    const limiter = new GlobalRateLimiter(50)
    const stamps: number[] = []
    const started = Date.now()
    await Promise.all(
      Array.from({ length: 4 }, () =>
        limiter.acquire('glm::pay-as-you-go', 50).then(() => stamps.push(Date.now() - started)),
      ),
    )
    stamps.sort((a, b) => a - b)
    const interval = 1000 / 50
    expect(stamps[1] - stamps[0]).toBeGreaterThanOrEqual(interval - 12)
    expect(stamps[2] - stamps[1]).toBeGreaterThanOrEqual(interval - 12)
    expect(stamps[3] - stamps[2]).toBeGreaterThanOrEqual(interval - 12)
  })

  it('different provider keys do not share the bucket', async () => {
    const limiter = new GlobalRateLimiter(50)
    const started = Date.now()
    await Promise.all([limiter.acquire('a::x', 50), limiter.acquire('b::x', 50)])
    expect(Date.now() - started).toBeLessThan(1000 / 50)
  })

  it('suspend blocks new admissions, resume releases them', async () => {
    const limiter = new GlobalRateLimiter(1000)
    limiter.acquire('k', 1000)
    limiter.suspend('k')
    const pending = limiter.acquire('k', 1000)
    await new Promise((r) => setTimeout(r, 30))
    expect(limiter.pendingCount('k')).toBe(1)
    limiter.resume('k')
    await pending
    expect(limiter.pendingCount('k')).toBe(0)
  })
})