import { describe, expect, it } from 'vitest'
import { emptyMatrix } from '../../src/memory/matrix-store'
import { computeConsistencySignals } from '../../src/memory/rules'

function baseMatrix() {
  const m = emptyMatrix()
  m.characterStates.push(
    { name: '沈孤鸿', tier: '主角', lastUpdatedChapter: 1, status: {}, changeLog: [] },
    { name: '白老板', tier: '重要配角', lastUpdatedChapter: 1, status: {}, changeLog: [] },
    { name: '卖花老人', tier: '路人', lastUpdatedChapter: 1, status: {}, changeLog: [] },
  )
  return m
}

describe('consistency rules', () => {
  it('foreshadow expected ch12 not revealed by ch15 → boosted at ch16 (spec 5.5.1 rule 3)', () => {
    const m = baseMatrix()
    m.foreshadows.push({ id: 'F-001', title: '断刀', plantedChapter: 3, expectedRevealChapter: 12, status: 'planted' })
    const signals = computeConsistencySignals(m, 16, { protagonistNames: ['沈孤鸿'], latestArchivedChapter: 15 })
    expect(signals.overdueForeshadows).toHaveLength(1)
    expect(signals.overdueForeshadows[0].id).toBe('F-001')
  })

  it('foreshadow within window is not flagged', () => {
    const m = baseMatrix()
    m.foreshadows.push({ id: 'F-002', title: '旧约', plantedChapter: 5, expectedRevealChapter: 14, status: 'planted' })
    const signals = computeConsistencySignals(m, 16, { protagonistNames: ['沈孤鸿'], latestArchivedChapter: 15 })
    expect(signals.overdueForeshadows).toHaveLength(0)
  })

  it('no mystery advanced ch7~9 → alert at ch10 (spec 5.5.1 rule 4)', () => {
    const m = baseMatrix()
    m.mysteries.push({ id: 'M-001', title: '内鬼是谁', raisedChapter: 2, lastAdvancedChapter: 6, status: 'open' })
    const signals = computeConsistencySignals(m, 10, { protagonistNames: ['沈孤鸿'], latestArchivedChapter: 9 })
    expect(signals.stalledMysteryAlert).toBe(true)
    expect(signals.stalledMysteries[0].id).toBe('M-001')
  })

  it('protagonist absent in ch5~7 (no records) → streak counts archived chapters', () => {
    const m = baseMatrix()
    m.appearances.push({ chapter: 4, present: ['沈孤鸿'] })
    const signals = computeConsistencySignals(m, 8, { protagonistNames: ['沈孤鸿'], latestArchivedChapter: 7 })
    expect(signals.protagonistAbsentStreak).toBe(3)
  })

  it('supporting character overdue with open thread flagged', () => {
    const m = baseMatrix()
    m.foreshadows.push({ id: 'F-003', title: '白老板的账本', plantedChapter: 2, expectedRevealChapter: 12, status: 'planted' })
    m.appearances.push({ chapter: 2, present: ['白老板'] })
    const signals = computeConsistencySignals(m, 14, { protagonistNames: ['沈孤鸿'], latestArchivedChapter: 13 })
    expect(signals.supportingOverdue.some((s) => s.name === '白老板')).toBe(true)
  })

  it('passerby drifting across 3+ chapters flagged (spec 5.4.1 rule 6b)', () => {
    const m = baseMatrix()
    m.appearances.push(
      { chapter: 2, present: ['卖花老人'] },
      { chapter: 5, present: ['卖花老人'] },
      { chapter: 9, present: ['卖花老人'] },
    )
    const signals = computeConsistencySignals(m, 10, { protagonistNames: ['沈孤鸿'], latestArchivedChapter: 9 })
    expect(signals.passerbyDrift).toHaveLength(1)
    expect(signals.passerbyDrift[0].chapters).toEqual([2, 5, 9])
  })

  it('passerby appearing in adjacent chapters only is not drift', () => {
    const m = baseMatrix()
    m.appearances.push(
      { chapter: 2, present: ['卖花老人'] },
      { chapter: 3, present: ['卖花老人'] },
    )
    const signals = computeConsistencySignals(m, 4, { protagonistNames: ['沈孤鸿'], latestArchivedChapter: 3 })
    expect(signals.passerbyDrift).toHaveLength(0)
  })
})