import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectPaths, ensureProjectLayout } from '../../src/storage/layout'
import { compile } from '../../src/output/compiler'
import { exportPackage } from '../../src/output/exporter'

let root: string
let paths: ReturnType<typeof projectPaths>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'output-'))
  paths = projectPaths(root, 'p1')
  await ensureProjectLayout(paths)
  await writeFile(paths.projectJson, JSON.stringify({ projectId: 'p1', name: '风暴', totalChapters: 5, stylePackId: 'generic' }))
  await writeFile(paths.worldJson, JSON.stringify({ worldview: '武侠世界' }))
  await writeFile(paths.charactersJson, JSON.stringify([{ name: '沈孤鸿' }]))
  await writeFile(paths.locationsJson, JSON.stringify([{ name: '长街' }]))
  await writeFile(paths.premiseTxt, '刀客查案')
})

describe('compiler', () => {
  it('merges complete 30-chapter-like novel in order without gaps', async () => {
    await writeFile(paths.projectJson, JSON.stringify({ projectId: 'p1', name: '风暴', totalChapters: 3, stylePackId: 'generic' }))
    for (let ch = 1; ch <= 3; ch++) {
      await writeFile(join(paths.chapters.final, `chapter_${String(ch).padStart(4, '0')}.txt`), `第${ch}章正文内容`)
    }
    const result = await compile(paths, {})
    expect(result.ok).toBe(true)
    expect(result.gaps).toEqual([])
    expect(result.text).toContain('风暴')
    expect(result.text?.indexOf('第 1 章')).toBeLessThan(result.text!.indexOf('第 3 章'))
    expect(result.text).toContain('第1章正文内容')
  })

  it('gap chapters interrupt with list unless confirmed (spec 5.8.1 rule 2/4)', async () => {
    for (const ch of [1, 2]) {
      await writeFile(join(paths.chapters.final, `chapter_${String(ch).padStart(4, '0')}.txt`), `第${ch}章`)
    }
    await writeFile(paths.state.isolationJson, JSON.stringify({ isolated: [{ chapter: 3, reason: '审查超限', kind: 'review-limit', rewriteSummary: '', isolatedAt: '' }] }))
    const blocked = await compile(paths, {})
    expect(blocked.ok).toBe(false)
    expect(blocked.text).toBeNull()
    expect(blocked.gaps.map((g) => [g.chapter, g.reason])).toEqual([[3, 'isolated'], [4, 'missing'], [5, 'missing']])

    const allowed = await compile(paths, { allowGaps: true })
    expect(allowed.ok).toBe(true)
    expect(allowed.text).toContain('【占位说明】')
    expect(allowed.text).toContain('审查超限')
  })
})

describe('exporter', () => {
  it('exports bundle with full text + setting collection + summary report (spec 5.8.1 rule 3)', async () => {
    await writeFile(paths.projectJson, JSON.stringify({ projectId: 'p1', name: '风暴', totalChapters: 1, stylePackId: 'generic' }))
    await writeFile(join(paths.chapters.final, 'chapter_0001.txt'), '终稿正文')
    await writeFile(join(paths.chapters.review, 'chapter_0001_review.json'), JSON.stringify({ score: 8.5 }))
    await writeFile(paths.output.fullNovel, '风暴\n\n第 1 章\n\n终稿正文')

    const bundle = await exportPackage(paths, '风暴', '2026-01-01T00:00:00Z')
    expect(bundle.files).toContain('全文.txt')
    expect(bundle.files).toContain(join('设定集', '世界观.json'))
    expect(bundle.files).toContain(join('设定集', '角色档案.json'))
    expect(bundle.files).toContain(join('设定集', '地点档案.json'))
    expect(bundle.files).toContain(join('设定集', '故事前提.txt'))
    expect(bundle.files).toContain('总结报告.json')
    const summary = JSON.parse(await readFile(join(bundle.bundleDir, '总结报告.json'), 'utf-8'))
    expect(summary.finalCount).toBe(1)
    expect(summary.averageScore).toBe(8.5)
    expect(summary.totalWords).toBe(4)
  })
})