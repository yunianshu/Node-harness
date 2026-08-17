import { appendFile, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { mkdir } from 'node:fs/promises'

export type AuditAction =
  | 'project.create'
  | 'project.start'
  | 'project.pause'
  | 'project.resume'
  | 'project.stop'
  | 'project.complete'
  | 'binding.change'
  | 'guidance.attach'
  | 'guidance.revoke'
  | 'guidance.consume'
  | 'guidance.regen'
  | 'chapter.regenerate'
  | 'provider.register'
  | 'credential.put'
  | 'credential.setEnabled'

export interface AuditEntry {
  seq: number
  timestamp: string
  operator: string
  action: AuditAction | string
  detail?: Record<string, unknown>
}

export class AuditLog {
  private cache: AuditEntry[] | null = null

  constructor(private readonly file: string) {}

  async append(
    operator: string,
    action: AuditAction | string,
    detail?: Record<string, unknown>,
  ): Promise<AuditEntry> {
    const entries = await this.readAll()
    const entry: AuditEntry = {
      seq: entries.length + 1,
      timestamp: new Date().toISOString(),
      operator,
      action,
      ...(detail !== undefined ? { detail } : {}),
    }
    await mkdir(dirname(this.file), { recursive: true })
    await appendFile(this.file, `${JSON.stringify(entry)}\n`, 'utf-8')
    if (this.cache) this.cache.push(entry)
    return entry
  }

  async readAll(): Promise<AuditEntry[]> {
    if (this.cache) return this.cache
    let text: string
    try {
      text = await readFile(this.file, 'utf-8')
    } catch {
      this.cache = []
      return this.cache
    }
    const entries: AuditEntry[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        entries.push(JSON.parse(line) as AuditEntry)
      } catch {
        continue
      }
    }
    this.cache = entries
    return entries
  }

  invalidateCache(): void {
    this.cache = null
  }
}