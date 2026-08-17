export interface IsolatedChapter {
  chapter: number
  reason: string
  kind: 'consecutive-failures' | 'review-limit' | 'quality-hard-fail'
  rewriteSummary: string
  isolatedAt: string
}

export interface IsolationLedgerData {
  isolated: IsolatedChapter[]
}

export class IsolationLedger {
  private data: IsolationLedgerData = { isolated: [] }

  constructor(private readonly stateFile: string) {}

  async load(): Promise<IsolatedChapter[]> {
    const { readJsonValidated } = await import('../storage/atomic.js')
    const raw = await readJsonValidated<IsolationLedgerData>(this.stateFile)
    this.data = raw?.isolated ? raw : { isolated: [] }
    return this.data.isolated
  }

  private async persist(): Promise<void> {
    const { atomicWriteJson } = await import('../storage/atomic.js')
    const { mkdir } = await import('node:fs/promises')
    const { dirname } = await import('node:path')
    await mkdir(dirname(this.stateFile), { recursive: true })
    await atomicWriteJson(this.stateFile, this.data)
  }

  isIsolated(chapter: number): boolean {
    return this.data.isolated.some((i) => i.chapter === chapter)
  }

  list(): IsolatedChapter[] {
    return [...this.data.isolated]
  }

  async isolate(entry: Omit<IsolatedChapter, 'isolatedAt'>): Promise<void> {
    if (this.isIsolated(entry.chapter)) return
    this.data.isolated.push({ ...entry, isolatedAt: new Date().toISOString() })
    await this.persist()
  }

  async release(chapter: number): Promise<boolean> {
    const before = this.data.isolated.length
    this.data.isolated = this.data.isolated.filter((i) => i.chapter !== chapter)
    if (this.data.isolated.length === before) return false
    await this.persist()
    return true
  }
}