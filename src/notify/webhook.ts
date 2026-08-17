import type { DomainEvent } from './events.js'

export interface AggregationPolicy {
  windowMs?: number
  countThreshold?: number
}

export interface WebhookStats {
  sent: number
  failed: number
  dropped: number
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export class WebhookNotifier {
  private url: string | null = null
  private policy: Required<AggregationPolicy>
  private buffer: DomainEvent[] = []
  private timer: NodeJS.Timeout | null = null
  private sending = false
  private readonly stats: WebhookStats = { sent: 0, failed: 0, dropped: 0 }
  private subscribers: Array<(event: DomainEvent) => void> = []

  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    policy: AggregationPolicy = {},
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.policy = { windowMs: policy.windowMs ?? 60_000, countThreshold: policy.countThreshold ?? 10 }
  }

  configure(url: string, policy?: AggregationPolicy): void {
    this.url = url
    if (policy?.windowMs !== undefined) this.policy.windowMs = policy.windowMs
    if (policy?.countThreshold !== undefined) this.policy.countThreshold = policy.countThreshold
  }

  subscribe(listener: (event: DomainEvent) => void): () => void {
    this.subscribers.push(listener)
    return () => {
      this.subscribers = this.subscribers.filter((s) => s !== listener)
    }
  }

  handleEvent(event: DomainEvent): void {
    for (const s of this.subscribers) s(event)
    if (!this.url) return
    if (event.type === 'pipeline.completed' || event.type === 'pipeline.aborted' || event.type === 'pipeline.error') {
      this.buffer.push(event)
      void this.flush('critical')
      return
    }
    this.buffer.push(event)
    if (this.buffer.length >= this.policy.countThreshold) {
      void this.flush('count')
      return
    }
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null
        void this.flush('window')
      }, this.policy.windowMs)
    }
  }

  private sanitize(event: DomainEvent): Record<string, unknown> {
    const clone: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(event)) {
      if (key === 'raw' || key === 'apiKey' || key === 'token' || key === 'credential') continue
      clone[key] = value
    }
    if (typeof clone.message === 'string') {
      clone.message = (clone.message as string).slice(0, 200)
    }
    return clone
  }

  private async flush(reason: string): Promise<void> {
    if (this.sending || this.buffer.length === 0 || !this.url) return
    this.sending = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const events = this.buffer.splice(0)
    const payload = {
      reason,
      count: events.length,
      events: events.map((e) => this.sanitize(e)),
      sentAt: new Date().toISOString(),
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await this.fetchImpl(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
        if (response.ok) {
          this.stats.sent++
          this.sending = false
          return
        }
        this.stats.failed++
      } catch {
        this.stats.failed++
      }
      await this.sleep(1000 * (attempt + 1))
    }
    this.stats.dropped += events.length
    this.sending = false
  }

  getStats(): WebhookStats & { buffered: number } {
    return { ...this.stats, buffered: this.buffer.length }
  }
}