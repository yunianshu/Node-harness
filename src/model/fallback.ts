import { atomicWriteJson, readJsonValidated } from '../storage/atomic.js'
import {
  AuthError,
  FallbackHop,
  ModelCallError,
  ModelExhaustedError,
  PlanLimitError,
} from './errors.js'

export type ChannelState = 'normal' | 'retrying' | 'degraded' | 'circuit-open' | 'limit-wait'

export interface ChannelKey {
  providerId: string
  accessMode: string
}

export interface ChannelStatusSnapshot {
  key: string
  state: ChannelState
  consecutiveFailures: number
  lastError: string | null
  enteredAt: string
}

export class FallbackNeededError extends Error {
  constructor(
    readonly channel: ChannelKey,
    readonly cause: ModelCallError,
  ) {
    super(`通道 ${channel.providerId}/${channel.accessMode} 需要降级：${cause.message}`)
    this.name = 'FallbackNeededError'
  }
}

export interface ChannelManagerOptions {
  maxRetries?: number
  initialDelayMs?: number
  fallbackThreshold?: number
  stateFile?: string
  onEvent?: (event: { type: string; channel: ChannelKey; detail?: Record<string, unknown> }) => void
  sleep?: (ms: number) => Promise<void>
}

interface ChannelRuntime {
  state: ChannelState
  consecutiveFailures: number
  lastError: string | null
  enteredAt: string
  circuitUntil: number
}

export class ChannelManager {
  private readonly channels = new Map<string, ChannelRuntime>()
  private readonly maxRetries: number
  private readonly initialDelayMs: number
  private readonly fallbackThreshold: number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly options: ChannelManagerOptions = {}) {
    this.maxRetries = options.maxRetries ?? 3
    this.initialDelayMs = options.initialDelayMs ?? 5000
    this.fallbackThreshold = options.fallbackThreshold ?? 5
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  private static keyOf(channel: ChannelKey): string {
    return `${channel.providerId}::${channel.accessMode}`
  }

  private runtime(channel: ChannelKey): ChannelRuntime {
    const key = ChannelManager.keyOf(channel)
    let rt = this.channels.get(key)
    if (!rt) {
      rt = { state: 'normal', consecutiveFailures: 0, lastError: null, enteredAt: new Date().toISOString(), circuitUntil: 0 }
      this.channels.set(key, rt)
    }
    return rt
  }

  private setState(channel: ChannelKey, rt: ChannelRuntime, state: ChannelState): void {
    if (rt.state !== state) {
      rt.state = state
      rt.enteredAt = new Date().toISOString()
    }
  }

  isAvailable(channel: ChannelKey): boolean {
    const rt = this.channels.get(ChannelManager.keyOf(channel))
    if (!rt) return true
    if (rt.state === 'circuit-open') return false
    return rt.state !== 'limit-wait'
  }

  async execute<T>(channel: ChannelKey, task: () => Promise<T>): Promise<T> {
    const rt = this.runtime(channel)
    if (rt.state === 'circuit-open' && Date.now() < rt.circuitUntil) {
      throw new FallbackNeededError(channel, new ModelCallError(`服务商已熔断：${rt.lastError ?? ''}`, 'auth'))
    }
    let attempt = 0
    let lastError: ModelCallError | null = null
    while (attempt <= this.maxRetries) {
      try {
        const result = await task()
        rt.consecutiveFailures = 0
        rt.lastError = null
        if (rt.state !== 'limit-wait') this.setState(channel, rt, 'normal')
        return result
      } catch (err) {
        if (!(err instanceof ModelCallError)) throw err
        lastError = err
        if (err instanceof AuthError) {
          rt.consecutiveFailures++
          rt.lastError = err.message
          rt.circuitUntil = Number.MAX_SAFE_INTEGER
          this.setState(channel, rt, 'circuit-open')
          this.options.onEvent?.({ type: 'model.circuit-open', channel, detail: { error: err.message } })
          throw new FallbackNeededError(channel, err)
        }
        if (err instanceof PlanLimitError) {
          rt.lastError = err.message
          this.setState(channel, rt, 'limit-wait')
          this.options.onEvent?.({ type: 'model.plan-limit', channel, detail: { error: err.message } })
          throw new FallbackNeededError(channel, err)
        }
        attempt++
        rt.consecutiveFailures++
        rt.lastError = err.message
        this.setState(channel, rt, 'retrying')
        this.options.onEvent?.({
          type: 'model.retry',
          channel,
          detail: { attempt, error: err.message },
        })
        if (rt.consecutiveFailures >= this.fallbackThreshold) {
          this.setState(channel, rt, 'degraded')
          this.options.onEvent?.({
            type: 'model.fallback',
            channel,
            detail: { consecutiveFailures: rt.consecutiveFailures, error: err.message },
          })
          throw new FallbackNeededError(channel, err)
        }
        if (attempt <= this.maxRetries) {
          const delay = this.initialDelayMs * Math.pow(2, attempt - 1)
          await this.sleep(delay)
        }
      }
    }
    throw new FallbackNeededError(channel, lastError ?? new ModelCallError('未知错误', 'unknown'))
  }

  markLimitWait(channel: ChannelKey): void {
    const rt = this.runtime(channel)
    rt.state = 'limit-wait'
    rt.enteredAt = new Date().toISOString()
  }

  markRecovered(channel: ChannelKey): void {
    const rt = this.runtime(channel)
    rt.consecutiveFailures = 0
    rt.lastError = null
    rt.circuitUntil = 0
    this.setState(channel, rt, 'normal')
  }

  manualRecover(channel: ChannelKey): void {
    this.markRecovered(channel)
  }

  status(): ChannelStatusSnapshot[] {
    return [...this.channels.entries()].map(([key, rt]) => ({
      key,
      state: rt.state,
      consecutiveFailures: rt.consecutiveFailures,
      lastError: rt.lastError,
      enteredAt: rt.enteredAt,
    }))
  }

  async persist(): Promise<void> {
    if (!this.options.stateFile) return
    await atomicWriteJson(this.options.stateFile, {
      channels: this.status(),
      savedAt: new Date().toISOString(),
    })
  }

  async restore(): Promise<void> {
    if (!this.options.stateFile) return
    const raw = await readJsonValidated<{ channels?: ChannelStatusSnapshot[] }>(this.options.stateFile)
    if (!raw?.channels) return
    for (const snap of raw.channels) {
      const [providerId, accessMode] = snap.key.split('::')
      const rt = this.runtime({ providerId, accessMode })
      rt.state = snap.state
      rt.consecutiveFailures = snap.consecutiveFailures
      rt.lastError = snap.lastError
      rt.enteredAt = snap.enteredAt
      rt.circuitUntil = snap.state === 'circuit-open' ? Number.MAX_SAFE_INTEGER : 0
    }
  }
}

export function trailOf(hops: FallbackHop[]): string {
  return hops.map((h) => `${h.providerId}/${h.model}(${h.attempts}次:${h.lastError})`).join(' → ')
}

export { ModelExhaustedError }