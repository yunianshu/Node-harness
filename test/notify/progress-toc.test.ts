import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectPaths } from '../../src/storage/layout'
import { buildToc, queryProgress, type NovelTocEntry } from '../../src/notify/progress'

/**
 * buildToc 单测：目录数据从落盘产物实时重建（产物即真相，不落 toc.json）。
 * 直接构造产物文件（outline 标题 / review 评分 / final 终稿 / isolation 隔离），
 * 镜像真实链路 queryProgress → buildToc，验证每章条目与顶部统计。
 */

describe('buildToc（产物重建目录卡快照）', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'toc-test-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function scaffold(extraOutlineTitles = 1): Promise<void> {
    const paths = projectPaths(root, 'proj-x')
    await mkdir(paths.chapters.outline, { recursive: true })
    await mkdir(paths.chapters.outlineReview, { recursive: true })
    await mkdir(paths.chapters.review, { recursive: true })
    await mkdir(paths.chapters.final, { recursive: true })
    await mkdir(paths.state.root, { recursive: true })

    await writeFile(join(paths.chapters.outline, 'chapter_0001.json'), JSON.stringify({ chapter: 1, title: '雪夜' }))
    await writeFile(join(paths.chapters.outline, 'chapter_0002.json'), JSON.stringify({ chapter: 2, title: '旧案' }))
    for (let ch = 3; ch <= 2 + extraOutlineTitles; ch++) {
      await writeFile(join(paths.chapters.outline, `chapter_${String(ch).padStart(4, '0')}.json`), JSON.stringify({ chapter: ch, title: `第${ch}章` }))
    }
    await writeFile(join(paths.chapters.outlineReview, 'chapter_0001_review.json'), JSON.stringify({ score: 9 }))
    await writeFile(join(paths.chapters.review, 'chapter_0001_review.json'), JSON.stringify({ score: 8, issues: [] }))
    await writeFile(join(paths.chapters.final, 'chapter_0001.txt'), '雪夜长街，故人重逢。'.repeat(20))
    await writeFile(join(paths.state.isolationJson), JSON.stringify({ isolated: [{ chapter: 2 }] }))
  }

  it('从产物重建每章 title/stage/score/isolated 与顶部统计', async () => {
    await scaffold()
    const paths = projectPaths(root, 'proj-x')
    const progress = await queryProgress(paths, 2, 'generating')
    const toc = await buildToc(paths, { name: '测试书', totalChapters: 2, status: 'generating' }, progress)

    expect(toc.projectId).toBe('proj-x')
    expect(toc.name).toBe('测试书')
    expect(toc.status).toBe('generating')
    expect(toc.totalChapters).toBe(2)
    // outlineDone = 章纲审查数（outline_review），finalDone = 终稿数，isolated = 隔离章
    expect(toc.outlineDone).toBe(1)
    expect(toc.finalDone).toBe(1)
    expect(toc.isolated).toEqual([2])

    expect(toc.entries).toHaveLength(2)
    const first = toc.entries[0]
    expect(first).toMatchObject({ chapter: 1, title: '雪夜', stage: '已完成', score: 8, isolated: false })
    expect(first.wordCount).toBeUndefined() // includeWordCount 默认关闭
    const second = toc.entries[1]
    expect(second).toMatchObject({ chapter: 2, title: '旧案', stage: '已隔离', isolated: true })
    expect(second.score).toBeUndefined() // 无正文审查报告
  })

  it('缺失章（无章纲产物）title 为 null、stage 回落规划', async () => {
    await scaffold(0) // 不写第 3 章章纲，验证缺章兜底
    const paths = projectPaths(root, 'proj-x')
    const progress = await queryProgress(paths, 3, 'planning')
    const toc = await buildToc(paths, { name: '测试书', totalChapters: 3, status: 'planning' }, progress)

    expect(toc.entries).toHaveLength(3)
    const third: NovelTocEntry = toc.entries[2]
    expect(third.title).toBeNull()
    expect(third.stage).toBe('规划')
    expect(third.isolated).toBe(false)
  })

  it('includeWordCount 开启时仅对终稿章计算正文字数', async () => {
    await scaffold()
    const paths = projectPaths(root, 'proj-x')
    const progress = await queryProgress(paths, 2, 'generating')
    const toc = await buildToc(paths, { name: '测试书', totalChapters: 2, status: 'generating' }, progress, {
      includeWordCount: true,
    })

    expect(typeof toc.entries[0].wordCount).toBe('number')
    expect(toc.entries[0].wordCount!).toBeGreaterThan(0)
    expect(toc.entries[1].wordCount).toBeUndefined() // 无终稿
  })

  it('评分 JSON 损坏/缺失时 score 缺省，不阻断整章条目', async () => {
    await scaffold()
    const paths = projectPaths(root, 'proj-x')
    await writeFile(join(paths.chapters.review, 'chapter_0002_review.json'), 'not-json{{')
    const progress = await queryProgress(paths, 2, 'generating')
    const toc = await buildToc(paths, { name: '测试书', totalChapters: 2, status: 'generating' }, progress)

    expect(toc.entries[0].score).toBe(8)
    expect(toc.entries[1].score).toBeUndefined()
    expect(toc.entries[1].title).toBe('旧案')
  })
})
