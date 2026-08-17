import { describe, expect, it } from 'vitest'
import {
  AuthError,
  EmptyResponseError,
  QuotaError,
  RetryableServerError,
  TimeoutError,
  classifyHttpError,
  detectPlanLimit,
} from '../../src/model/errors'

describe('failure classification', () => {
  it('401/403 → AuthError', () => {
    expect(classifyHttpError(401, '')).toBeInstanceOf(AuthError)
    expect(classifyHttpError(403, '')).toBeInstanceOf(AuthError)
  })

  it('429 → QuotaError', () => {
    expect(classifyHttpError(429, 'rate limited')).toBeInstanceOf(QuotaError)
  })

  it('5xx → RetryableServerError', () => {
    expect(classifyHttpError(500, 'oops')).toBeInstanceOf(RetryableServerError)
    expect(classifyHttpError(503, 'busy')).toBeInstanceOf(RetryableServerError)
  })

  it('plan-limit markers in 429 body → PlanLimitError', () => {
    const err = classifyHttpError(429, '{"error":{"code":"arrear"}}')
    expect(err.failure).toBe('plan-limit')
  })

  it('empty content constructed via EmptyResponseError', () => {
    expect(new EmptyResponseError().failure).toBe('empty')
    expect(new TimeoutError().failure).toBe('timeout')
  })

  it('detectPlanLimit matches known markers only', () => {
    expect(detectPlanLimit(429, 'Insufficient_Balance')).toBe(true)
    expect(detectPlanLimit(429, 'normal rate limit')).toBe(false)
  })
})