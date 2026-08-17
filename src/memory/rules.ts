import type { CharacterTierCN, MemoryMatrix } from './matrix-store.js'

export interface OverdueForeshadow {
  id: string
  title: string
  expectedRevealChapter: number
  overdueBy: number
}

export interface StalledMystery {
  id: string
  title: string
  lastAdvancedChapter: number
  stalledChapters: number
}

export interface SupportingOverdue {
  name: string
  lastChapter: number
  window: number
}

export interface PasserbyDrift {
  name: string
  chapters: number[]
}

export interface ConsistencySignals {
  overdueForeshadows: OverdueForeshadow[]
  stalledMysteryAlert: boolean
  stalledMysteries: StalledMystery[]
  protagonistAbsentStreak: number
  supportingOverdue: SupportingOverdue[]
  passerbyDrift: PasserbyDrift[]
}

export interface RuleOptions {
  foreshadowOverdueWindow?: number
  mysteryStallChapters?: number
  supportingWindow?: number
  passerbyThreshold?: number
  protagonistNames: string[]
  latestArchivedChapter: number
}

export function computeConsistencySignals(matrix: MemoryMatrix, targetChapter: number, options: RuleOptions): ConsistencySignals {
  const overdueWindow = options.foreshadowOverdueWindow ?? 3
  const stallChapters = options.mysteryStallChapters ?? 3
  const supportingWindow = options.supportingWindow ?? 10
  const passerbyThreshold = options.passerbyThreshold ?? 3

  const overdueForeshadows: OverdueForeshadow[] = matrix.foreshadows
    .filter((f) => f.status === 'planted' && f.expectedRevealChapter !== undefined)
    .filter((f) => targetChapter > (f.expectedRevealChapter as number) + overdueWindow)
    .map((f) => ({
      id: f.id,
      title: f.title,
      expectedRevealChapter: f.expectedRevealChapter as number,
      overdueBy: targetChapter - (f.expectedRevealChapter as number) - overdueWindow,
    }))

  const stalledMysteries = matrix.mysteries
    .filter((m) => m.status === 'open' && targetChapter - m.lastAdvancedChapter >= stallChapters)
    .map((m) => ({
      id: m.id,
      title: m.title,
      lastAdvancedChapter: m.lastAdvancedChapter,
      stalledChapters: targetChapter - m.lastAdvancedChapter,
    }))

  const appearanceChapters = (name: string): number[] =>
    matrix.appearances.filter((a) => a.present.includes(name)).map((a) => a.chapter)

  let protagonistAbsentStreak = 0
  for (let ch = options.latestArchivedChapter; ch >= 1; ch--) {
    const record = matrix.appearances.find((a) => a.chapter === ch)
    if (record && options.protagonistNames.some((n) => record.present.includes(n))) break
    protagonistAbsentStreak++
  }

  const supportingOverdue: SupportingOverdue[] = matrix.characterStates
    .filter((c) => c.tier === '重要配角')
    .map((c) => ({ name: c.name, lastChapter: Math.max(0, ...appearanceChapters(c.name)), window: supportingWindow }))
    .filter(
      (s) =>
        s.lastChapter > 0 &&
        options.latestArchivedChapter - s.lastChapter > supportingWindow &&
        hasOpenThread(matrix, s.name),
    )

  const passerbyDrift: PasserbyDrift[] = matrix.characterStates
    .filter((c) => c.tier === '路人')
    .map((c) => ({ name: c.name, chapters: appearanceChapters(c.name).sort((a, b) => a - b) }))
    .filter((d) => {
      if (d.chapters.length < 2) return false
      const span = d.chapters[d.chapters.length - 1] - d.chapters[0]
      return span >= passerbyThreshold
    })

  return {
    overdueForeshadows,
    stalledMysteryAlert: stalledMysteries.length > 0,
    stalledMysteries,
    protagonistAbsentStreak,
    supportingOverdue,
    passerbyDrift,
  }
}

function hasOpenThread(matrix: MemoryMatrix, name: string): boolean {
  const inForeshadow = matrix.foreshadows.some((f) => f.status === 'planted' && f.title.includes(name))
  const inMystery = matrix.mysteries.some((m) => m.status === 'open' && m.title.includes(name))
  return inForeshadow || inMystery
}

export function protagonistNamesOf(matrix: MemoryMatrix): string[] {
  return matrix.characterStates.filter((c) => c.tier === '主角').map((c) => c.name)
}

export function tierOf(matrix: MemoryMatrix, name: string): CharacterTierCN | undefined {
  return matrix.characterStates.find((c) => c.name === name)?.tier
}