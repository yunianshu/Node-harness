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

/** 目录卡单章条目（title 缺省表示章纲未产出；score 缺省表示尚无审查报告）。 */
export interface NovelTocEntry {
  chapter: number
  title: string | null
  stage: string
  score?: number
  isolated: boolean
  /** 终稿正文字数（默认不计算，仅 includeWordCount 时读取）。 */
  wordCount?: number
}

/** 会话内小说目录卡快照（latest-write-wins，产物即真相，不落 toc.json）。 */
export interface NovelToc {
  projectId: string
  /** 产物根目录绝对路径（<dataRoot>/novels/<projectId>/），供会话卡片呈现文件保存位置。 */
  projectDir: string
  name: string
  status: string
  totalChapters: number
  /** 章纲审查完成数（= progress.stages.outline.done）。 */
  outlineDone: number
  /** 终稿完成数（= progress.stages.final.done）。 */
  finalDone: number
  isolated: number[]
  entries: NovelTocEntry[]
  updatedAt: string
}

/**
 * 从落盘产物实时重建小说目录（产物即真相，不新增 toc.json 落盘文件）。
 * 复用调用方已算出的 ProgressView（app.status 内含 queryProgress），不二次全量扫描；
 * 章标题/评分只对产物命中的章按需 readFile（Promise.all 并行），绝不逐章探测。
 */
export async function buildToc(
  paths: ProjectPaths,
  project: { name: string; totalChapters: number; status: string },
  progress: ProgressView,
  options: { includeWordCount?: boolean } = {},
): Promise<NovelToc> {
  const [outlineNames, reviewNames, finalNames] = await Promise.all([
    listJson(paths.chapters.outline),
    listJson(paths.chapters.review),
    listTxt(paths.chapters.final),
  ])
  const outlineBy = new Map<number, string>()
  const reviewBy = new Map<number, string>()
  const finalSet = new Set<number>()
  for (const f of outlineNames) {
    const m = f.match(/^chapter_(\d{4})\.json$/)
    if (m) outlineBy.set(Number(m[1]), f)
  }
  for (const f of reviewNames) {
    const m = f.match(/^chapter_(\d{4})_review\.json$/)
    if (m) reviewBy.set(Number(m[1]), f)
  }
  for (const f of finalNames) {
    const m = f.match(/^chapter_(\d{4})\.txt$/)
    if (m) finalSet.add(Number(m[1]))
  }

  const readTitle = async (ch: number): Promise<string | null> => {
    const file = outlineBy.get(ch)
    if (file === undefined) return null
    const raw = await readFile(join(paths.chapters.outline, file), 'utf-8').catch(() => '')
    try {
      const v = (JSON.parse(raw) as { title?: unknown }).title
      return typeof v === 'string' && v.length > 0 ? v : null
    } catch {
      return null
    }
  }
  const readScore = async (ch: number): Promise<number | undefined> => {
    const file = reviewBy.get(ch)
    if (file === undefined) return undefined
    const raw = await readFile(join(paths.chapters.review, file), 'utf-8').catch(() => '')
    try {
      const s = (JSON.parse(raw) as { score?: unknown }).score
      return typeof s === 'number' ? s : undefined
    } catch {
      return undefined
    }
  }

  const entries = await Promise.all(
    Array.from({ length: progress.totalChapters }, async (_x, i) => {
      const ch = i + 1
      const pc = progress.chapters[i]
      const [title, score] = await Promise.all([readTitle(ch), readScore(ch)])
      const entry: NovelTocEntry = {
        chapter: ch,
        title,
        stage: pc?.currentStage ?? '规划',
        ...(score !== undefined ? { score } : {}),
        isolated: pc?.isolated ?? false,
      }
      if (options.includeWordCount && finalSet.has(ch)) {
        const text = await readFile(join(paths.chapters.final, `${chapterFile(ch)}.txt`), 'utf-8').catch(() => '')
        entry.wordCount = text.replace(/\s/g, '').length
      }
      return entry
    }),
  )

  return {
    projectId: progress.projectId,
    projectDir: paths.root,
    name: project.name,
    status: project.status,
    totalChapters: progress.totalChapters,
    outlineDone: progress.stages.outline.done,
    finalDone: progress.stages.final.done,
    isolated: progress.chapters.filter((c) => c.isolated).map((c) => c.chapter),
    entries,
    updatedAt: new Date().toISOString(),
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