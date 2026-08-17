import { randomUUID } from 'node:crypto'
import { atomicWriteJson, readJsonValidated } from '../storage/atomic.js'
import { AuditLog } from '../storage/audit.js'
import { projectPaths } from '../storage/layout.js'

export type GuidanceStage = 'outline' | 'content'
export type GuidanceStatus = 'pending' | 'consumed' | 'revoked'

export interface GuidanceTarget {
  chapters: number[]
  stage: GuidanceStage
}

export interface GuidanceNote {
  noteId: string
  target: GuidanceTarget
  content: string
  status: GuidanceStatus
  createdAt: string
  updatedAt: string
  operator: string
  consumedBy?: { requestId: string; consumedAt: string; operator: string }
}

export interface GuidanceFile {
  notes: GuidanceNote[]
}

export class GuidanceError extends Error {
  constructor(
    readonly code: 'NOT_PAUSED' | 'CONTENT_LENGTH' | 'NOT_FOUND' | 'NOT_REVOKABLE',
    message: string,
  ) {
    super(message)
    this.name = 'GuidanceError'
  }
}

export interface GuidanceDeps {
  isProjectPaused(projectId: string): Promise<boolean>
  hasArtifactsFor(projectId: string, target: GuidanceTarget): Promise<boolean>
  projectRoot(projectId: string): Promise<{ guidanceFile: string; auditFile: string }>
}

export class GuidanceService {
  constructor(private readonly deps: GuidanceDeps) {}

  private async loadFile(projectId: string): Promise<GuidanceFile> {
    const { guidanceFile } = await this.deps.projectRoot(projectId)
    const raw = await readJsonValidated<GuidanceFile>(guidanceFile)
    return raw?.notes ? raw : { notes: [] }
  }

  private async persist(projectId: string, file: GuidanceFile): Promise<void> {
    const { guidanceFile } = await this.deps.projectRoot(projectId)
    await atomicWriteJson(guidanceFile, file)
  }

  private async audit(projectId: string, operator: string, action: string, detail: Record<string, unknown>): Promise<void> {
    const { auditFile } = await this.deps.projectRoot(projectId)
    await new AuditLog(auditFile).append(operator, action, detail)
  }

  async attach(
    projectId: string,
    target: GuidanceTarget,
    content: string,
    operator = 'creator',
  ): Promise<{ note: GuidanceNote; warning?: string }> {
    if (!(await this.deps.isProjectPaused(projectId))) {
      throw new GuidanceError('NOT_PAUSED', '请先暂停项目后再附加指导意见')
    }
    if (content.length < 1 || content.length > 2000) {
      throw new GuidanceError('CONTENT_LENGTH', '指导意见长度须为 1~2000 字')
    }
    const file = await this.loadFile(projectId)
    const now = new Date().toISOString()
    for (const note of file.notes) {
      if (
        note.status === 'pending' &&
        note.target.stage === target.stage &&
        note.target.chapters.join(',') === target.chapters.join(',')
      ) {
        note.status = 'revoked'
        note.updatedAt = now
      }
    }
    const note: GuidanceNote = {
      noteId: `G-${randomUUID().slice(0, 8)}`,
      target,
      content,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      operator,
    }
    file.notes.push(note)
    await this.persist(projectId, file)
    await this.audit(projectId, operator, 'guidance.attach', { noteId: note.noteId, target, length: content.length })

    const latestChapter = Math.max(...target.chapters)
    let warning: string | undefined
    if (!(await this.deps.hasArtifactsFor(projectId, target))) {
      warning = `第 ${latestChapter} 章尚未生成，指导意见已保存`
    }
    return { note, warning }
  }

  async list(projectId: string, filter?: { status?: GuidanceStatus; chapter?: number; stage?: GuidanceStage }): Promise<GuidanceNote[]> {
    const file = await this.loadFile(projectId)
    return file.notes.filter((n) => {
      if (filter?.status && n.status !== filter.status) return false
      if (filter?.stage && n.target.stage !== filter.stage) return false
      if (filter?.chapter && !n.target.chapters.includes(filter.chapter)) return false
      return true
    })
  }

  async revoke(projectId: string, noteId: string, operator = 'creator'): Promise<void> {
    const file = await this.loadFile(projectId)
    const note = file.notes.find((n) => n.noteId === noteId)
    if (!note) throw new GuidanceError('NOT_FOUND', `指导意见不存在：${noteId}`)
    if (note.status !== 'pending') throw new GuidanceError('NOT_REVOKABLE', `仅待消费意见可撤销，当前状态：${note.status}`)
    note.status = 'revoked'
    note.updatedAt = new Date().toISOString()
    await this.persist(projectId, file)
    await this.audit(projectId, operator, 'guidance.revoke', { noteId })
  }

  async consume(projectId: string, chapter: number, stage: GuidanceStage, requestId: string, operator = 'system'): Promise<GuidanceNote | null> {
    const file = await this.loadFile(projectId)
    const note = file.notes.find(
      (n) => n.status === 'pending' && n.target.stage === stage && n.target.chapters.includes(chapter),
    )
    if (!note) return null
    note.status = 'consumed'
    note.consumedBy = { requestId, consumedAt: new Date().toISOString(), operator }
    note.updatedAt = new Date().toISOString()
    await this.persist(projectId, file)
    await this.audit(projectId, operator, 'guidance.consume', { noteId: note.noteId, chapter, stage, requestId })
    return note
  }
}