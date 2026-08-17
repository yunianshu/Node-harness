import { join } from 'node:path'
import { atomicWriteJson, readJsonValidated } from '../storage/atomic.js'

export type CharacterTierCN = '主角' | '重要配角' | '次要配角' | '路人'

export interface ForeshadowEntry {
  id: string
  title: string
  plantedChapter: number
  expectedRevealChapter?: number
  revealedChapter?: number
  status: 'planted' | 'revealed'
}

export interface MotifEntry {
  motif: string
  count: number
  chapters: number[]
}

export interface MysteryEntry {
  id: string
  title: string
  raisedChapter: number
  lastAdvancedChapter: number
  resolvedChapter?: number
  status: 'open' | 'resolved'
}

export interface ThemeEntry {
  theme: string
  chapters: number[]
  lastVisitedChapter: number
}

export interface CharacterStatusPatch {
  location?: string
  injury?: string
  possessions?: string[]
  knowledge?: string
  [key: string]: unknown
}

export interface CharacterStateEntry {
  name: string
  tier: CharacterTierCN
  lastUpdatedChapter: number
  status: CharacterStatusPatch
  changeLog: Array<{ chapter: number; note: string }>
}

export interface SceneRef {
  location: string
  description: string
}

export interface SpacetimeEntry {
  chapter: number
  startScene: SceneRef
  endScene: SceneRef
  timeline: string
  status: 'valid' | 'pending-manual'
  viewpointCharacter?: string
}

export interface SpacetimeSummaryItem {
  chapter: number
  endLocation: string
  timeline: string
}

export interface AppearanceRecord {
  chapter: number
  present: string[]
}

export interface MemoryMatrix {
  foreshadows: ForeshadowEntry[]
  motifs: MotifEntry[]
  mysteries: MysteryEntry[]
  themeTrack: ThemeEntry[]
  characterStates: CharacterStateEntry[]
  spatiotemporalLatest: SpacetimeEntry | null
  spatiotemporalHistory: SpacetimeSummaryItem[]
  appearances: AppearanceRecord[]
}

export function emptyMatrix(): MemoryMatrix {
  return {
    foreshadows: [],
    motifs: [],
    mysteries: [],
    themeTrack: [],
    characterStates: [],
    spatiotemporalLatest: null,
    spatiotemporalHistory: [],
    appearances: [],
  }
}

function isMatrix(raw: unknown): raw is MemoryMatrix {
  if (typeof raw !== 'object' || raw === null) return false
  const m = raw as Partial<MemoryMatrix>
  return Array.isArray(m.foreshadows) && Array.isArray(m.mysteries)
}

export interface MatrixStoreOptions {
  matrixFile: string
  snapshotsDir: string
  chapterArtifactExists?: (chapter: number) => Promise<boolean>
  historyKeepChapters?: number
}

export class MatrixConsistencyError extends Error {
  readonly code = 'MATRIX_CONSISTENCY'
  constructor(message: string) {
    super(message)
    this.name = 'MatrixConsistencyError'
  }
}

export class MatrixStore {
  private matrix: MemoryMatrix = emptyMatrix()
  private loaded = false
  private readonly historyKeep: number

  constructor(private readonly options: MatrixStoreOptions) {
    this.historyKeep = options.historyKeepChapters ?? 5
  }

  async load(): Promise<MemoryMatrix> {
    if (this.loaded) return this.matrix
    const raw = await readJsonValidated<MemoryMatrix>(this.options.matrixFile, isMatrix)
    this.matrix = raw ?? emptyMatrix()
    this.loaded = true
    return this.matrix
  }

  private async persist(): Promise<void> {
    await atomicWriteJson(this.options.matrixFile, this.matrix)
  }

  async snapshot(chapter: number): Promise<void> {
    await this.load()
    const { mkdir } = await import('node:fs/promises')
    await mkdir(this.options.snapshotsDir, { recursive: true })
    await atomicWriteJson(join(this.options.snapshotsDir, `chapter_${String(chapter).padStart(4, '0')}.json`), {
      chapter,
      takenAt: new Date().toISOString(),
      matrix: this.matrix,
    })
  }

  private async assertArtifactExists(chapter: number): Promise<void> {
    if (!this.options.chapterArtifactExists) return
    const exists = await this.options.chapterArtifactExists(chapter)
    if (!exists) {
      throw new MatrixConsistencyError(`第 ${chapter} 章无归档产物，悬空状态记录被拒绝`)
    }
  }

  async addForeshadow(entry: Omit<ForeshadowEntry, 'id' | 'status'> & { id?: string }): Promise<ForeshadowEntry> {
    await this.load()
    const created: ForeshadowEntry = {
      id: entry.id ?? `F-${String(this.matrix.foreshadows.length + 1).padStart(3, '0')}`,
      title: entry.title,
      plantedChapter: entry.plantedChapter,
      expectedRevealChapter: entry.expectedRevealChapter,
      status: 'planted',
    }
    this.matrix.foreshadows.push(created)
    await this.persist()
    return created
  }

  async revealForeshadow(id: string, revealedChapter: number): Promise<void> {
    await this.load()
    await this.assertArtifactExists(revealedChapter)
    const entry = this.matrix.foreshadows.find((f) => f.id === id)
    if (!entry) throw new MatrixConsistencyError(`伏笔不存在：${id}`)
    entry.status = 'revealed'
    entry.revealedChapter = revealedChapter
    await this.persist()
  }

  async recordMotif(motif: string, chapter: number): Promise<void> {
    await this.load()
    const existing = this.matrix.motifs.find((m) => m.motif === motif)
    if (existing) {
      existing.count++
      existing.chapters.push(chapter)
    } else {
      this.matrix.motifs.push({ motif, count: 1, chapters: [chapter] })
    }
    await this.persist()
  }

  async addMystery(title: string, raisedChapter: number): Promise<MysteryEntry> {
    await this.load()
    const created: MysteryEntry = {
      id: `M-${String(this.matrix.mysteries.length + 1).padStart(3, '0')}`,
      title,
      raisedChapter,
      lastAdvancedChapter: raisedChapter,
      status: 'open',
    }
    this.matrix.mysteries.push(created)
    await this.persist()
    return created
  }

  async advanceMystery(id: string, chapter: number): Promise<void> {
    await this.load()
    const entry = this.matrix.mysteries.find((m) => m.id === id)
    if (!entry) throw new MatrixConsistencyError(`悬念不存在：${id}`)
    entry.lastAdvancedChapter = Math.max(entry.lastAdvancedChapter, chapter)
    await this.persist()
  }

  async resolveMystery(id: string, resolvedChapter: number): Promise<void> {
    await this.load()
    await this.assertArtifactExists(resolvedChapter)
    const entry = this.matrix.mysteries.find((m) => m.id === id)
    if (!entry) throw new MatrixConsistencyError(`悬念不存在：${id}`)
    entry.status = 'resolved'
    entry.resolvedChapter = resolvedChapter
    await this.persist()
  }

  async trackTheme(theme: string, chapter: number): Promise<void> {
    await this.load()
    const existing = this.matrix.themeTrack.find((t) => t.theme === theme)
    if (existing) {
      existing.chapters.push(chapter)
      existing.lastVisitedChapter = chapter
    } else {
      this.matrix.themeTrack.push({ theme, chapters: [chapter], lastVisitedChapter: chapter })
    }
    await this.persist()
  }

  async updateCharacterState(
    name: string,
    tier: CharacterTierCN,
    chapter: number,
    patch: CharacterStatusPatch,
    note?: string,
  ): Promise<void> {
    await this.load()
    const existing = this.matrix.characterStates.find((c) => c.name === name)
    if (existing) {
      existing.status = { ...existing.status, ...patch }
      existing.lastUpdatedChapter = chapter
      existing.changeLog.push({ chapter, note: note ?? '状态更新' })
    } else {
      this.matrix.characterStates.push({
        name,
        tier,
        lastUpdatedChapter: chapter,
        status: patch,
        changeLog: [{ chapter, note: note ?? '建档' }],
      })
    }
    await this.persist()
  }

  async recordAppearance(chapter: number, present: string[]): Promise<void> {
    await this.load()
    this.matrix.appearances.push({ chapter, present })
    await this.persist()
  }

  async setSpatiotemporal(entry: SpacetimeEntry): Promise<void> {
    await this.load()
    const latest = this.matrix.spatiotemporalLatest
    if (latest) {
      this.matrix.spatiotemporalHistory.push({
        chapter: latest.chapter,
        endLocation: latest.endScene.location,
        timeline: latest.timeline,
      })
      this.matrix.spatiotemporalHistory = this.matrix.spatiotemporalHistory.slice(-this.historyKeep)
    }
    this.matrix.spatiotemporalLatest = entry
    await this.persist()
  }

  async markSpatiotemporalPendingManual(chapter: number): Promise<void> {
    await this.load()
    if (this.matrix.spatiotemporalLatest && this.matrix.spatiotemporalLatest.chapter === chapter) {
      this.matrix.spatiotemporalLatest.status = 'pending-manual'
      await this.persist()
    }
  }

  current(): MemoryMatrix {
    return this.matrix
  }
}