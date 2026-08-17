import { beforeEach, describe, expect, it } from 'vitest'
import { RegenError, RegenOrchestrator, RegenChapterRequest } from '../../src/guidance/regen-orchestrator'
import type { GuidanceNote, GuidanceStage } from '../../src/guidance/service'

let paused = true
let finals = new Set<number>()
let isolated = new Set<number>()
let consumed: Array<{ chapter: number; stage: GuidanceStage; requestId: string }> = []
let notes = new Map<string, GuidanceNote>()
let slotLog: string[] = []
let regenLog: RegenChapterRequest[] = []
let auditLog: Array<[string, string]> = []

function makeDeps(overrides: Partial<Parameters<typeof makeFull>[0]> = {}) {
  return makeFull({
    ...overrides,
  })
}

function makeFull(base: {
  regenerateChapter?: (req: RegenChapterRequest) => Promise<boolean>
}): RegenOrchestrator {
  return new RegenOrchestrator({
    isProjectPaused: async () => paused,
    totalChapters: async () => 10,
    hasFinal: async (_id, ch) => finals.has(ch),
    isIsolated: async (_id, ch) => isolated.has(ch),
    releaseIsolation: async (_id, ch) => {
      isolated.delete(ch)
    },
    consumeNote: async (_id, ch, stage, requestId) => {
      consumed.push({ chapter: ch, stage, requestId })
      const note = [...notes.values()].find((n) => n.status === 'pending' && n.target.chapters.includes(ch))
      if (!note) return null
      note.status = 'consumed'
      return note
    },
    acquireSlot: async (_id, ch, priority) => {
      slotLog.push(`acquire:${ch}:${priority}`)
      return () => slotLog.push(`release:${ch}`)
    },
    regenerateChapter: async (_id, req) => {
      regenLog.push(req)
      return base.regenerateChapter ? base.regenerateChapter(req) : true
    },
    audit: async (_id, operator, action) => {
      auditLog.push([operator, action])
    },
  })
}

function makeNote(chapters: number[], stage: GuidanceStage): GuidanceNote {
  return {
    noteId: `G-${chapters.join('-')}`,
    target: { chapters, stage },
    content: '指导意见',
    status: 'pending',
    createdAt: '',
    updatedAt: '',
    operator: 'creator',
  }
}

beforeEach(() => {
  paused = true
  finals = new Set()
  isolated = new Set()
  consumed = []
  notes = new Map()
  slotLog = []
  regenLog = []
  auditLog = []
})

describe('regen orchestrator', () => {
  it('regenerates chapters with guidance priority slots; each chapter gets its own note (spec 5.9.1 rule 4)', async () => {
    notes.set('a', makeNote([3], 'content'))
    notes.set('b', makeNote([4], 'content'))
    const orchestrator = makeDeps({})
    const summary = await orchestrator.regenerate('p1', { kind: 'content', chapters: [3, 4] })
    expect(summary.results).toHaveLength(2)
    expect(slotLog.filter((l) => l.endsWith(':guidance'))).toHaveLength(2)
    expect(regenLog.map((r) => r.chapter)).toEqual([3, 4])
    expect(regenLog[0].note?.noteId).toBe('G-3')
    expect(regenLog[1].note?.noteId).toBe('G-4')
    expect(auditLog.some(([op, action]) => action === 'guidance.regen')).toBe(true)
  })

  it('final chapter without confirm → FINAL_REGEN_UNCONFIRMED (spec 5.9.1 rule 7)', async () => {
    finals.add(5)
    const orchestrator = makeDeps({})
    await expect(orchestrator.regenerate('p1', { kind: 'content', chapters: [5] })).rejects.toMatchObject({
      code: 'FINAL_REGEN_UNCONFIRMED',
    })
    await expect(
      orchestrator.regenerate('p1', { kind: 'content', chapters: [5] }, { confirmFinalOverride: true }),
    ).resolves.toMatchObject({ results: [{ chapter: 5, success: true }] })
  })

  it('failed regen keeps original final (success=false → finalReplaced=false)', async () => {
    finals.add(5)
    const orchestrator = makeDeps({ regenerateChapter: async () => false })
    const summary = await orchestrator.regenerate('p1', { kind: 'content', chapters: [5] }, { confirmFinalOverride: true })
    expect(summary.results[0].success).toBe(false)
    expect(summary.results[0].finalReplaced).toBe(false)
  })

  it('isolated chapter success releases from isolation ledger (spec 5.9.1 rule 6)', async () => {
    isolated.add(7)
    const orchestrator = makeDeps({})
    const summary = await orchestrator.regenerate('p1', { kind: 'content', chapters: [7] })
    expect(summary.results[0].releasedFromIsolation).toBe(true)
    expect(isolated.has(7)).toBe(false)
  })

  it('not paused → NOT_PAUSED', async () => {
    paused = false
    const orchestrator = makeDeps({})
    await expect(orchestrator.regenerate('p1', { kind: 'content', chapters: [1] })).rejects.toMatchObject({
      code: 'NOT_PAUSED',
    })
  })

  it('chapter out of range → CHAPTER_RANGE; duplicates deduped', async () => {
    const orchestrator = makeDeps({})
    await expect(orchestrator.regenerate('p1', { kind: 'content', chapters: [11] })).rejects.toMatchObject({
      code: 'CHAPTER_RANGE',
    })
    const summary = await orchestrator.regenerate('p1', { kind: 'content', chapters: [2, 2, 3] })
    expect(summary.results.map((r) => r.chapter)).toEqual([2, 3])
  })

  it('chapter without note runs as plain regen (note=null)', async () => {
    const orchestrator = makeDeps({})
    const summary = await orchestrator.regenerate('p1', { kind: 'outline', chapters: [6] })
    expect(summary.results[0].note).toBeNull()
    expect(regenLog[0].note).toBeNull()
  })
})