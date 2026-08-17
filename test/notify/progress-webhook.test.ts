import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectPaths, ensureProjectLayout } from '../../src/storage/layout'
import { buildSummaryReport, queryProgress } from '../../src/notify/progress'
import type { DomainEvent } from '../../src/notify/events'
import { WebhookNotifier } from '../../src/notify/webhook'

let root: string
let paths: ReturnType<typeof projectPaths>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'notify-'))
  paths = projectPaths(root, 'p1')
  await ensureProjectLayout(paths)
  await writeFile(paths.projectJson, JSON.stringify({ projectId: 'p1', name: '风暴', totalChapters: 30, stylePackId: 'generic' }))
  await writeFile(paths.worldJson, JSON.stringify({ worldview: 'w' }))
})

async function seedChapters(finals: number[], drafts: number[], outlineReviews: number[]) {
  for (const ch of outlineReviews) {
    await writeFile(join(paths.chapters.outlineReview, `chapter_${String(ch).padStart(4, '0')}_review.json`), '{"score":9}')
  }
  for (const ch of drafts) {
    await writeFile(join(paths.chapters.draft, `chapter_${String(ch).padStart(4, '0')}.txt`), '初稿')
  }
  for (const ch of finals) {
    await writeFile(join(paths.chapters.final, `chapter_${String(ch).padStart(4, '0')}.txt`), '终稿内容')
  }
}

describe('progress view', () => {
  it('two-level progress like "outline 22/30 draft 20/30 final 18/30" (spec 5.7.1 rule 1)', async () => {
    const outlines = Array.from({ length: 23 }, (_, i) => i + 1)
    const outlineReviews = Array.from({ length: 22 }, (_, i) => i + 1)
    const drafts = Array.from({ length: 20 }, (_, i) => i + 1)
    const finals = Array.from({ length: 18 }, (_, i) => i + 1)
    for (const ch of outlines) {
      await writeFile(join(paths.chapters.outline, `chapter_${String(ch).padStart(4, '0')}.json`), '{"scenes":[]}')
    }
    await seedChapters(finals, drafts, outlineReviews)
    const view = await queryProgress(paths, 30, 'generating')
    expect(view.stages.outline).toEqual({ done: 22, total: 30 })
    expect(view.stages.draft).toEqual({ done: 20, total: 30 })
    expect(view.stages.final).toEqual({ done: 18, total: 30 })
    expect(view.chapters.find((c) => c.chapter === 21)?.currentStage).toBe('正文写作')
    expect(view.chapters.find((c) => c.chapter === 19)?.currentStage).toBe('正文审查')
    expect(view.chapters.find((c) => c.chapter === 1)?.currentStage).toBe('已完成')
  })

  it('summary report counts words/scores/isolation consistent with artifacts (spec 5.7.1 rule 4)', async () => {
    await seedChapters([1, 2, 3], [1, 2, 3], [1, 2, 3])
    for (const ch of [1, 2, 3]) {
      await writeFile(join(paths.chapters.review, `chapter_${String(ch).padStart(4, '0')}_review.json`), JSON.stringify({ score: 8.0 + (ch - 1) * 0.5 }))
    }
    await writeFile(paths.state.isolationJson, JSON.stringify({ isolated: [{ chapter: 4, reason: 'x', kind: 'review-limit', rewriteSummary: '', isolatedAt: '' }] }))
    const report = await buildSummaryReport(paths, '风暴', 5, '2026-01-01T00:00:00Z')
    expect(report.finalCount).toBe(3)
    expect(report.isolatedChapters).toEqual([4])
    expect(report.totalWords).toBe(12)
    expect(report.averageScore).toBe(8.5)
  })
})

describe('webhook notifier', () => {
  function event(type: string, projectId = 'p1'): DomainEvent {
    return { type, timestamp: Date.now(), projectId } as DomainEvent
  }

  it('aggregates 10 chapter events into one push (spec 5.7.1 rule 2)', async () => {
    const payloads: unknown[] = []
    const notifier = new WebhookNotifier(
      async (_url, init) => {
        payloads.push(JSON.parse(String(init.body)))
        return new Response('ok')
      },
      { countThreshold: 10, windowMs: 5000 },
    )
    notifier.configure('https://hook.mock')
    for (let i = 0; i < 10; i++) notifier.handleEvent(event('chapter.status'))
    await new Promise((r) => setTimeout(r, 50))
    expect(payloads).toHaveLength(1)
    expect((payloads[0] as { count: number }).count).toBe(10)
  })

  it('critical events flush immediately', async () => {
    const payloads: unknown[] = []
    const notifier = new WebhookNotifier(
      async (_url, init) => {
        payloads.push(JSON.parse(String(init.body)))
        return new Response('ok')
      },
      { countThreshold: 100, windowMs: 5000 },
    )
    notifier.configure('https://hook.mock')
    notifier.handleEvent(event('pipeline.completed'))
    await new Promise((r) => setTimeout(r, 50))
    expect(payloads).toHaveLength(1)
  })

  it('failed push retries then drops without breaking (spec 5.7.3)', async () => {
    let attempts = 0
    const notifier = new WebhookNotifier(
      async () => {
        attempts++
        throw new Error('network down')
      },
      { countThreshold: 1, windowMs: 1000 },
      async () => {},
    )
    notifier.configure('https://hook.mock')
    notifier.handleEvent(event('pipeline.error'))
    await new Promise((r) => setTimeout(r, 100))
    expect(attempts).toBe(3)
    const stats = notifier.getStats()
    expect(stats.sent).toBe(0)
    expect(stats.dropped).toBeGreaterThanOrEqual(1)
  })

  it('payload never contains credentials or raw responses (spec 5.7.1 rule 5)', async () => {
    let body = ''
    const notifier = new WebhookNotifier(
      async (_url, init) => {
        body = String(init.body)
        return new Response('ok')
      },
      { countThreshold: 2 },
    )
    notifier.configure('https://hook.mock')
    notifier.handleEvent({ ...event('model.fallback'), apiKey: 'sk-secret', raw: 'full response', credential: 'tok' } as DomainEvent)
    notifier.handleEvent({ ...event('model.plan-limit'), apiKey: 'sk-secret2' } as DomainEvent)
    await new Promise((r) => setTimeout(r, 50))
    expect(body).not.toContain('sk-secret')
    expect(body).not.toContain('full response')
    expect(body).not.toContain('credential')
    expect(body).toContain('model.fallback')
  })
})