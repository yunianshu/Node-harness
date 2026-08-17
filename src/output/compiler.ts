import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chapterFile, ProjectPaths } from '../storage/layout.js'

export interface CompileGap {
  chapter: number
  reason: 'missing' | 'isolated'
}

export interface CompileResult {
  ok: boolean
  text: string | null
  gaps: CompileGap[]
  totalChapters: number
  finalCount: number
}

export async function compile(
  paths: ProjectPaths,
  options: { bookTitle?: string; allowGaps?: boolean },
): Promise<CompileResult> {
  const config = JSON.parse(await readFile(paths.projectJson, 'utf-8')) as { totalChapters: number; name: string }
  const totalChapters = config.totalChapters

  let finals: string[] = []
  try {
    finals = (await readdir(paths.chapters.final)).filter((f) => f.endsWith('.txt'))
  } catch {
    finals = []
  }

  let isolation: { isolated?: Array<{ chapter: number; reason: string }> } = {}
  try {
    isolation = JSON.parse(await readFile(paths.state.isolationJson, 'utf-8'))
  } catch {
    /* ignore */
  }
  const isolatedMap = new Map((isolation.isolated ?? []).map((i) => [i.chapter, i.reason]))

  const gaps: CompileGap[] = []
  for (let ch = 1; ch <= totalChapters; ch++) {
    const file = `${chapterFile(ch)}.txt`
    if (finals.includes(file)) continue
    gaps.push({ chapter: ch, reason: isolatedMap.has(ch) ? 'isolated' : 'missing' })
  }

  if (gaps.length > 0 && !options.allowGaps) {
    return {
      ok: false,
      text: null,
      gaps,
      totalChapters,
      finalCount: totalChapters - gaps.length,
    }
  }

  const parts: string[] = []
  const title = options.bookTitle ?? config.name
  parts.push(title)
  parts.push('')
  for (let ch = 1; ch <= totalChapters; ch++) {
    const file = `${chapterFile(ch)}.txt`
    if (finals.includes(file)) {
      parts.push(`第 ${ch} 章`)
      parts.push('')
      parts.push(await readFile(join(paths.chapters.final, file), 'utf-8'))
      parts.push('')
    } else {
      const gap = gaps.find((g) => g.chapter === ch)!
      parts.push(`第 ${ch} 章`)
      parts.push('')
      parts.push(
        gap.reason === 'isolated'
          ? `【占位说明】本章因${isolatedMap.get(ch) ?? '质量隔离'}未生成终稿，请处理后单独重生成本章。`
          : '【占位说明】本章尚未生成，请继续生成流程。',
      )
      parts.push('')
    }
  }

  const text = parts.join('\n')
  const { atomicWriteFile } = await import('../storage/atomic.js')
  await atomicWriteFile(paths.output.fullNovel, text)

  return { ok: true, text, gaps, totalChapters, finalCount: totalChapters - gaps.length }
}