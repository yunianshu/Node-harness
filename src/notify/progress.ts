import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chapterFile, ProjectPaths } from '../storage/layout.js'

export interface ProgressView {
  projectId: string
  totalChapters: number
  stages: {
    planning: 'done' | 'pending'
    outline: { done: number; total: number }
    draft: { done: number; total: number }
    final: { done: number; total: number }
  }
  chapters: Array<{
    chapter: number
    currentStage: string
    isolated: boolean
  }>
  projectStatus: string
}

export interface SummaryReport {
  projectId: string
  name: string
  totalChapters: number
  finalCount: number
  isolatedChapters: number[]
  totalWords: number
  averageScore: number | null
  modelCalls: Record<string, number>
  fallbackCount: number
  startedAt: string | null
  finishedAt: string
}

async function listJson(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
}

async function listTxt(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith('.txt'))
  } catch {
    return []
  }
}

export async function queryProgress(
  paths: ProjectPaths,
  totalChapters: number,
  projectStatus: string,
): Promise<ProgressView> {
  const outlines = await listJson(paths.chapters.outline)
  const outlineReviews = await listJson(paths.chapters.outlineReview)
  const drafts = await listTxt(paths.chapters.draft)
  const finals = await listTxt(paths.chapters.final)

  let isolation: { isolated?: Array<{ chapter: number }> } = {}
  try {
    isolation = JSON.parse(await readFile(paths.state.isolationJson, 'utf-8'))
  } catch {
    /* no isolation file */
  }
  const isolatedChapters = new Set((isolation.isolated ?? []).map((i) => i.chapter))

  const planningDone = await readFile(paths.worldJson, 'utf-8')
    .then(() => true)
    .catch(() => false)

  const chapters: ProgressView['chapters'] = []
  for (let ch = 1; ch <= totalChapters; ch++) {
    const file = chapterFile(ch)
    const hasFinal = finals.includes(`${file}.txt`)
    const hasReview = outlineReviews.includes(`${file}_review.json`)
    const hasDraft = drafts.includes(`${file}.txt`)
    const hasOutline = outlines.includes(`${file}.json`)
    const currentStage = hasFinal
      ? '已完成'
      : isolatedChapters.has(ch)
        ? '已隔离'
        : hasDraft
          ? '正文审查'
          : hasReview
            ? '正文写作'
            : hasOutline
              ? '章纲审查'
              : planningDone
                ? '章纲生成'
                : '规划'
    chapters.push({ chapter: ch, currentStage, isolated: isolatedChapters.has(ch) })
  }

  return {
    projectId: paths.root.split(/[\\/]/).pop() ?? '',
    totalChapters,
    stages: {
      planning: planningDone ? 'done' : 'pending',
      outline: { done: outlineReviews.length, total: totalChapters },
      draft: { done: drafts.length, total: totalChapters },
      final: { done: finals.length, total: totalChapters },
    },
    chapters,
    projectStatus,
  }
}

export async function buildSummaryReport(
  paths: ProjectPaths,
  name: string,
  totalChapters: number,
  startedAt: string | null,
): Promise<SummaryReport> {
  const finals = await listTxt(paths.chapters.final)
  const reviews = await listJson(paths.chapters.review)

  let totalWords = 0
  for (const f of finals) {
    const text = await readFile(join(paths.chapters.final, f), 'utf-8').catch(() => '')
    totalWords += text.replace(/\s/g, '').length
  }

  const scores: number[] = []
  for (const f of reviews) {
    const raw = await readFile(join(paths.chapters.review, f), 'utf-8')
      .then((t) => JSON.parse(t) as { score?: number })
      .catch(() => null)
    if (raw?.score !== undefined) scores.push(raw.score)
  }

  let isolation: { isolated?: Array<{ chapter: number }> } = {}
  try {
    isolation = JSON.parse(await readFile(paths.state.isolationJson, 'utf-8'))
  } catch {
    /* ignore */
  }

  const modelCalls: Record<string, number> = {}
  let fallbackCount = 0
  try {
    const rawResponses = await readdir(paths.logs.rawResponsesDir)
    for (const f of rawResponses) {
      const roleMatch = f.match(/\d{4}-\d{2}-\d{2}T[\d-]+_(\w+)/)
      if (roleMatch) modelCalls[roleMatch[1]] = (modelCalls[roleMatch[1]] ?? 0) + 1
    }
  } catch {
    /* ignore */
  }
  try {
    const audit = await readFile(paths.logs.auditLog, 'utf-8')
    fallbackCount = (audit.match(/model\.fallback/g) ?? []).length
  } catch {
    /* ignore */
  }

  return {
    projectId: paths.root.split(/[\\/]/).pop() ?? '',
    name,
    totalChapters,
    finalCount: finals.length,
    isolatedChapters: (isolation.isolated ?? []).map((i) => i.chapter),
    totalWords,
    averageScore: scores.length > 0 ? Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)) : null,
    modelCalls,
    fallbackCount,
    startedAt,
    finishedAt: new Date().toISOString(),
  }
}