export type FailureClass =
  | 'auth'
  | 'quota'
  | 'plan-limit'
  | 'empty'
  | 'timeout'
  | 'server'
  | 'network'
  | 'unknown'

export class ModelCallError extends Error {
  constructor(
    message: string,
    readonly failure: FailureClass,
    readonly status?: number,
    readonly bodySnippet?: string,
  ) {
    super(message)
    this.name = 'ModelCallError'
  }
}

export class AuthError extends ModelCallError {
  constructor(message: string, status = 401, bodySnippet?: string) {
    super(message, 'auth', status, bodySnippet)
    this.name = 'AuthError'
  }
}

export class QuotaError extends ModelCallError {
  constructor(message: string, status = 429, bodySnippet?: string) {
    super(message, 'quota', status, bodySnippet)
    this.name = 'QuotaError'
  }
}

export class PlanLimitError extends ModelCallError {
  constructor(message: string, status?: number, bodySnippet?: string) {
    super(message, 'plan-limit', status, bodySnippet)
    this.name = 'PlanLimitError'
  }
}

export class EmptyResponseError extends ModelCallError {
  constructor(message = 'model returned empty content') {
    super(message, 'empty')
    this.name = 'EmptyResponseError'
  }
}

export class TimeoutError extends ModelCallError {
  constructor(message = 'model call timed out') {
    super(message, 'timeout')
    this.name = 'TimeoutError'
  }
}

export class RetryableServerError extends ModelCallError {
  constructor(message: string, status: number, bodySnippet?: string) {
    super(message, 'server', status, bodySnippet)
    this.name = 'RetryableServerError'
  }
}

export class NetworkError extends ModelCallError {
  constructor(message: string) {
    super(message, 'network')
    this.name = 'NetworkError'
  }
}

export interface FallbackHop {
  providerId: string
  model: string
  accessMode: string
  attempts: number
  lastError: string
}

export class ModelExhaustedError extends Error {
  readonly code = 'MODEL_EXHAUSTED'
  constructor(
    message: string,
    readonly trail: FallbackHop[],
  ) {
    super(message)
    this.name = 'ModelExhaustedError'
  }
}

export class EndpointTokenMismatchError extends Error {
  readonly code = 'ENDPOINT_TOKEN_MISMATCH'
  constructor(message = '端点与订阅 token 版本不匹配') {
    super(message)
    this.name = 'EndpointTokenMismatchError'
  }
}

const PLAN_LIMIT_MARKERS = ['insufficient_balance', 'quota_exceeded', 'plan_limit', 'coding_plan_limit', 'arrear']

export function detectPlanLimit(_status: number | undefined, bodyText: string | undefined): boolean {
  if (bodyText === undefined) return false
  const lower = bodyText.toLowerCase()
  return PLAN_LIMIT_MARKERS.some((m) => lower.includes(m))
}

export function classifyHttpError(status: number, bodyText: string): ModelCallError {
  const snippet = bodyText.slice(0, 200)
  if (status === 401 || status === 403) return new AuthError(`鉴权失败（${status}）`, status, snippet)
  if (status === 429) {
    if (detectPlanLimit(status, bodyText)) return new PlanLimitError('订阅额度受限', status, snippet)
    return new QuotaError('触发限流（429）', status, snippet)
  }
  if (status >= 500) return new RetryableServerError(`服务端错误（${status}）`, status, snippet)
  if (status === 400 && detectPlanLimit(undefined, bodyText)) return new PlanLimitError('订阅额度受限', status, snippet)
  return new RetryableServerError(`请求失败（${status}）`, status, snippet)
}