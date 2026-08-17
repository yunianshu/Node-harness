import type { MemoryMatrix, SpacetimeSummaryItem } from './matrix-store.js'

export interface InjectionForeshadow {
  id: string
  title: string
  plantedChapter: number
  priority: 'normal' | 'overdue-boosted'
}

export interface InjectionCharacterState {
  name: string
  tier: string
  lastUpdatedChapter: number
  status: Record<string, unknown>
}

export interface MatrixInjection {
  targetChapter: number
  foreshadows: InjectionForeshadow[]
  motifRequirements: string[]
  mysteries: Array<{ id: string; title: string; raisedChapter: number }>
  themes: string[]
  characterStates: InjectionCharacterState[]
  spatiotemporal: {
    latest: MemoryMatrix['spatiotemporalLatest']
    recentSummary: SpacetimeSummaryItem[]
  }
  pruningLog: string[]
}

export interface InjectionOptions {
  supportingRecentChapters?: number
  minorRecentChanges?: number
  motifMinCount?: number
}

export function buildInjection(
  matrix: MemoryMatrix,
  targetChapter: number,
  options: InjectionOptions = {},
): MatrixInjection {
  const pruningLog: string[] = []
  const supportingWindow = options.supportingRecentChapters ?? 10
  const minorChanges = options.minorRecentChanges ?? 3
  const motifMinCount = options.motifMinCount ?? 2

  const pending = matrix.foreshadows.filter((f) => f.status === 'planted')
  const overdueWindow = 3
  const foreshadows: InjectionForeshadow[] = pending.map((f) => {
    const overdue = f.expectedRevealChapter !== undefined && targetChapter > f.expectedRevealChapter + overdueWindow
    return {
      id: f.id,
      title: f.title,
      plantedChapter: f.plantedChapter,
      priority: overdue ? 'overdue-boosted' : 'normal',
    }
  })
  if (matrix.foreshadows.length > 0) {
    const revealed = matrix.foreshadows.length - pending.length
    if (revealed > 0) pruningLog.push(`已揭示伏笔 ${revealed} 条仅保留标题（不注入详情）`)
  }

  const motifRequirements = matrix.motifs
    .filter((m) => m.count >= motifMinCount)
    .map((m) => m.motif)
  const droppedMotifs = matrix.motifs.length - motifRequirements.length
  if (droppedMotifs > 0) pruningLog.push(`意象仅保留复现≥${motifMinCount}次条目，丢弃 ${droppedMotifs} 条`)

  const mysteries = matrix.mysteries
    .filter((m) => m.status === 'open')
    .map((m) => ({ id: m.id, title: m.title, raisedChapter: m.raisedChapter }))

  const themes = matrix.themeTrack.map((t) => t.theme)

  const characterStates: InjectionCharacterState[] = []
  for (const c of matrix.characterStates) {
    if (c.tier === '主角') {
      characterStates.push({
        name: c.name,
        tier: c.tier,
        lastUpdatedChapter: c.lastUpdatedChapter,
        status: c.status,
      })
    } else if (c.tier === '重要配角') {
      if (targetChapter - c.lastUpdatedChapter <= supportingWindow) {
        characterStates.push({
          name: c.name,
          tier: c.tier,
          lastUpdatedChapter: c.lastUpdatedChapter,
          status: c.status,
        })
      } else {
        pruningLog.push(`重要配角 ${c.name} 超过 ${supportingWindow} 章未更新，仅保留姓名`)
        characterStates.push({ name: c.name, tier: c.tier, lastUpdatedChapter: c.lastUpdatedChapter, status: {} })
      }
    } else if (c.tier === '次要配角') {
      const recentChanges = c.changeLog.slice(-minorChanges)
      if (recentChanges.length > 0) {
        characterStates.push({
          name: c.name,
          tier: c.tier,
          lastUpdatedChapter: c.lastUpdatedChapter,
          status: pickPatched(recentChanges),
        })
      }
    } else {
      pruningLog.push(`路人 ${c.name} 不注入生成上下文`)
    }
  }

  return {
    targetChapter,
    foreshadows,
    motifRequirements,
    mysteries,
    themes,
    characterStates,
    spatiotemporal: {
      latest: matrix.spatiotemporalLatest,
      recentSummary: matrix.spatiotemporalHistory.slice(-5),
    },
    pruningLog,
  }
}

function pickPatched(changes: Array<{ chapter: number; note: string }>): Record<string, unknown> {
  return { recentChanges: changes }
}