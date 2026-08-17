import { randomUUID } from 'node:crypto'
import type { GuidanceNote, GuidanceStage } from './service.js'

export type RegenScope =
  | { kind: 'content'; chapters: number[] }
  | { kind: 'outline'; chapters: number[] }

export interface RegenChapterOutcome {
  chapter: number
  stage: GuidanceStage
  note: GuidanceNote | null
  success: boolean
  finalReplaced: boolean
  releasedFromIsolation: boolean
  message: string
}

export interface RegenSummary {
  projectId: string
  requestId: string
  results: RegenChapterOutcome[]
}

export class RegenError extends Error {
  constructor(
    readonly code: 'FINAL_REGEN_UNCONFIRMED' | 'NO_ARTIFACT' | 'NOT_PAUSED' | 'CHAPTER_RANGE',
    message: string,
  ) {
    super(message)
    this.name = 'RegenError'
  }
}

export interface RegenChapterRequest {
  chapter: number
  stage: GuidanceStage
  note: GuidanceNote | null
  requestId: string
}

export interface RegenOrchestratorDeps {
  isProjectPaused(projectId: string): Promise<boolean>
  totalChapters(projectId: string): Promise<number>
  hasFinal(projectId: string, chapter: number): Promise<boolean>
  isIsolated(projectId: string, chapter: number): Promise<boolean>
  releaseIsolation(projectId: string, chapter: number): Promise<void>
  consumeNote(projectId: string, chapter: number, stage: GuidanceStage, requestId: string): Promise<GuidanceNote | null>
  acquireSlot(projectId: string, chapter: number, priority: 'guidance' | 'normal'): Promise<() => void>
  regenerateChapter(projectId: string, request: RegenChapterRequest): Promise<boolean>
  audit(projectId: string, operator: string, action: string, detail: Record<string, unknown>): Promise<void>
}

export class RegenOrchestrator {
  constructor(private readonly deps: RegenOrchestratorDeps) {}

  async regenerate(
    projectId: string,
    scope: RegenScope,
    options?: { confirmFinalOverride?: boolean; operator?: string },
  ): Promise<RegenSummary> {
    if (!(await this.deps.isProjectPaused(projectId))) {
      throw new RegenError('NOT_PAUSED', '请先暂停项目后再发起指导重生成')
    }
    const total = await this.deps.totalChapters(projectId)
    const invalid = scope.chapters.filter((c) => c < 1 || c > total)
    if (invalid.length > 0) throw new RegenError('CHAPTER_RANGE', `章节号超出范围：${invalid.join(',')}`)

    const needsConfirm: number[] = []
    for (const chapter of scope.chapters) {
      if (await this.deps.hasFinal(projectId, chapter)) needsConfirm.push(chapter)
    }
    if (needsConfirm.length > 0 && !options?.confirmFinalOverride) {
      throw new RegenError(
        'FINAL_REGEN_UNCONFIRMED',
        `以下章节已有终稿，重生成需显式确认（原稿将保留至新稿过审）：第 ${needsConfirm.join(',')} 章`,
      )
    }

    const requestId = `regen-${randomUUID().slice(0, 8)}`
    const results: RegenChapterOutcome[] = []

    for (const chapter of [...new Set(scope.chapters)].sort((a, b) => a - b)) {
      const note = await this.deps.consumeNote(projectId, chapter, scope.kind, requestId)
      const release = await this.deps.acquireSlot(projectId, chapter, 'guidance')
      try {
        const wasIsolated = await this.deps.isIsolated(projectId, chapter)
        const success = await this.deps.regenerateChapter(projectId, { chapter, stage: scope.kind, note, requestId })
        let releasedFromIsolation = false
        if (success && wasIsolated) {
          await this.deps.releaseIsolation(projectId, chapter)
          releasedFromIsolation = true
        }
        results.push({
          chapter,
          stage: scope.kind,
          note,
          success,
          finalReplaced: success,
          releasedFromIsolation,
          message: success
            ? `第 ${chapter} 章${scope.kind === 'outline' ? '章纲' : '正文'}重生成完成`
            : `第 ${chapter} 章重生成未通过，保留原稿`,
        })
      } finally {
        release()
      }
    }

    await this.deps.audit(projectId, options?.operator ?? 'creator', 'guidance.regen', {
      requestId,
      scope,
      results: results.map((r) => ({ chapter: r.chapter, success: r.success })),
    })

    return { projectId, requestId, results }
  }
}