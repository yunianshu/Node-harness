export type SlotPriority = 'guidance' | 'normal'

interface SlotWaiter {
  chapter: number
  priority: SlotPriority
  resolve: () => void
}

export class ChapterSlotManager {
  private readonly busyChapters = new Set<number>()
  private readonly waiters: SlotWaiter[] = []
  private activeCount = 0

  constructor(
    private readonly concurrency: number,
  ) {}

  private tryDispatch(): void {
    while (this.activeCount < this.concurrency && this.waiters.length > 0) {
      const index = this.waiters.findIndex((w) => !this.busyChapters.has(w.chapter))
      if (index === -1) return
      const waiter = this.waiters.splice(index, 1)[0]
      this.busyChapters.add(waiter.chapter)
      this.activeCount++
      waiter.resolve()
    }
  }

  async acquireSlot(chapter: number, priority: SlotPriority = 'normal'): Promise<void> {
    return new Promise<void>((resolve) => {
      const waiter: SlotWaiter = { chapter, priority, resolve }
      if (priority === 'guidance') {
        this.waiters.unshift(waiter)
      } else {
        this.waiters.push(waiter)
      }
      this.tryDispatch()
    })
  }


  releaseSlot(chapter: number): void {
    if (this.busyChapters.has(chapter)) {
      this.busyChapters.delete(chapter)
      this.activeCount--
    }
    this.tryDispatch()
  }

  isBusy(chapter: number): boolean {
    return this.busyChapters.has(chapter)
  }

  activeChapters(): number[] {
    return [...this.busyChapters]
  }

  async runExclusive<T>(chapter: number, priority: SlotPriority, task: () => Promise<T>): Promise<T> {
    await this.acquireSlot(chapter, priority)
    try {
      return await task()
    } finally {
      this.releaseSlot(chapter)
    }
  }
}