interface ChannelGate {
  nextAllowedAt: number
  suspended: boolean
  queue: Array<() => void>
  timer: NodeJS.Timeout | null
}

export class GlobalRateLimiter {
  private readonly gates = new Map<string, ChannelGate>()

  constructor(private readonly defaultQps = 2) {}

  private gate(key: string): ChannelGate {
    let gate = this.gates.get(key)
    if (!gate) {
      gate = { nextAllowedAt: 0, suspended: false, queue: [], timer: null }
      this.gates.set(key, gate)
    }
    return gate
  }

  acquire(key: string, qps?: number): Promise<void> {
    const rate = Math.max(qps ?? this.defaultQps, 0.01)
    const interval = 1000 / rate
    const gate = this.gate(key)
    return new Promise<void>((resolve) => {
      gate.queue.push(() => resolve())
      this.pump(gate, interval)
    })
  }

  private pump(gate: ChannelGate, interval: number): void {
    if (gate.timer) return
    const tick = () => {
      gate.timer = null
      const now = Date.now()
      while (!gate.suspended && gate.queue.length > 0 && now >= gate.nextAllowedAt) {
        gate.nextAllowedAt = Math.max(gate.nextAllowedAt, now) + interval
        gate.queue.shift()!()
      }
      if (gate.queue.length > 0) {
        const wait = Math.max(gate.nextAllowedAt - Date.now(), 0) + 1
        gate.timer = setTimeout(tick, wait)
      } else {
        gate.nextAllowedAt = Math.max(gate.nextAllowedAt, Date.now())
      }
    }
    tick()
  }

  suspend(key: string): void {
    const gate = this.gate(key)
    gate.suspended = true
    if (gate.timer) {
      clearTimeout(gate.timer)
      gate.timer = null
    }
  }

  resume(key: string): void {
    const gate = this.gates.get(key)
    if (!gate) return
    gate.suspended = false
    gate.nextAllowedAt = Math.min(gate.nextAllowedAt, Date.now())
    if (gate.queue.length > 0) this.pump(gate, 1000 / this.defaultQps)
  }

  isSuspended(key: string): boolean {
    return this.gates.get(key)?.suspended ?? false
  }

  pendingCount(key: string): number {
    return this.gates.get(key)?.queue.length ?? 0
  }
}