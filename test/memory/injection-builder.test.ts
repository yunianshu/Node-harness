import { describe, expect, it } from 'vitest'
import { emptyMatrix } from '../../src/memory/matrix-store'
import { buildInjection } from '../../src/memory/injection-builder'

function richMatrix() {
  const m = emptyMatrix()
  m.foreshadows.push(
    { id: 'F-001', title: '断刀', plantedChapter: 2, expectedRevealChapter: 8, status: 'planted' },
    { id: 'F-002', title: '旧约', plantedChapter: 3, status: 'revealed', revealedChapter: 9 },
    { id: 'F-003', title: '断魂剑', plantedChapter: 10, expectedRevealChapter: 12, status: 'planted' },
  )
  m.motifs.push(
    { motif: '雪', count: 3, chapters: [1, 4, 7] },
    { motif: '伞', count: 1, chapters: [2] },
  )
  m.mysteries.push(
    { id: 'M-001', title: '内鬼是谁', raisedChapter: 2, lastAdvancedChapter: 8, status: 'open' },
    { id: 'M-002', title: '旧案', raisedChapter: 1, lastAdvancedChapter: 3, status: 'resolved', resolvedChapter: 6 },
  )
  m.themeTrack.push({ theme: '孤独与救赎', chapters: [1, 5], lastVisitedChapter: 5 })
  m.characterStates.push(
    { name: '沈孤鸿', tier: '主角', lastUpdatedChapter: 11, status: { location: '渡口', injury: '旧伤未愈' }, changeLog: [] },
    { name: '白老板', tier: '重要配角', lastUpdatedChapter: 8, status: { location: '长街' }, changeLog: [] },
    { name: '阿九', tier: '次要配角', lastUpdatedChapter: 9, status: {}, changeLog: [{ chapter: 4, note: '加入' }, { chapter: 9, note: '受伤' }] },
    { name: '卖花老人', tier: '路人', lastUpdatedChapter: 2, status: {}, changeLog: [] },
  )
  m.spatiotemporalLatest = {
    chapter: 11,
    startScene: { location: '长街', description: '' },
    endScene: { location: '渡口', description: '' },
    timeline: '次日',
    status: 'valid',
  }
  m.spatiotemporalHistory = Array.from({ length: 8 }, (_, i) => ({
    chapter: i + 3,
    endLocation: `地${i + 3}`,
    timeline: `第${i + 3}章`,
  }))
  return m
}

describe('injection builder', () => {
  it('chapter 10 injection includes all pending foreshadows (spec 5.5.1 rule 2)', () => {
    const injection = buildInjection(richMatrix(), 10)
    expect(injection.foreshadows.map((f) => f.id)).toContain('F-001')
    expect(injection.foreshadows.map((f) => f.id)).not.toContain('F-002')
  })

  it('chapter 12 injection includes protagonist full state and no passerby (spec 5.5.1 rule 5)', () => {
    const injection = buildInjection(richMatrix(), 12)
    const protagonist = injection.characterStates.find((c) => c.name === '沈孤鸿')
    expect(protagonist?.status).toEqual({ location: '渡口', injury: '旧伤未愈' })
    expect(injection.characterStates.some((c) => c.name === '卖花老人')).toBe(false)
    expect(injection.pruningLog.some((l) => l.includes('卖花老人'))).toBe(true)
  })

  it('overdue foreshadow gets boosted priority', () => {
    const injection = buildInjection(richMatrix(), 12)
    const f1 = injection.foreshadows.find((f) => f.id === 'F-001')
    expect(f1?.priority).toBe('overdue-boosted')
    const f3 = injection.foreshadows.find((f) => f.id === 'F-003')
    expect(f3?.priority).toBe('normal')
  })

  it('motifs filtered to recurring only; mysteries only open ones', () => {
    const injection = buildInjection(richMatrix(), 10)
    expect(injection.motifRequirements).toEqual(['雪'])
    expect(injection.mysteries.map((m) => m.id)).toEqual(['M-001'])
  })

  it('supporting character beyond 10 chapters reduced to name only', () => {
    const injection = buildInjection(richMatrix(), 19)
    const bai = injection.characterStates.find((c) => c.name === '白老板')
    expect(bai?.status).toEqual({})
    expect(injection.pruningLog.some((l) => l.includes('白老板'))).toBe(true)
  })

  it('spacetime keeps latest + last 5 summary; long history pruned', () => {
    const injection = buildInjection(richMatrix(), 12)
    expect(injection.spatiotemporal.latest?.chapter).toBe(11)
    expect(injection.spatiotemporal.recentSummary).toHaveLength(5)
    expect(injection.spatiotemporal.recentSummary[4].chapter).toBe(10)
  })
})