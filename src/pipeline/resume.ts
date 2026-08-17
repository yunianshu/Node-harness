export interface ChapterStageStatus {
  outline: boolean
  outlineReview: boolean
  draft: boolean
  review: boolean
  final: boolean
}

export type ProgressMatrix = Map<number, ChapterStageStatus>

export interface OutlineRuntimeState {
  chapter: number
  reviewPassed: boolean
  directedRounds: number
  fullRegens: number
}

export interface ResumeScanResult {
  progress: ProgressMatrix
  hasPlanning: boolean
  hasAnyArtifacts: boolean
  maxFinalChapter: number
  maxOutlineChapter: number
}

function chapterOf(fileName: string): number | null {
  const match = fileName.match(/chapter_(\d{4})/)
  if (!match) return null
  return Number(match[1])
}

export interface ResumeScannerOptions {
  chaptersRoot: string
  planningFiles: { world: string; characters: string; locations: string }
}

export class ResumeScanner {
  constructor(private readonly options: ResumeScannerOptions) {}

  async scan(): Promise<ResumeScanResult> {
    const { readdir } = await import('node:fs/promises')
    const { readJsonValidated } = await import('../storage/atomic.js')
    const { readTextIfExists } = await import('../storage/atomic.js')

    const progress: ProgressMatrix = new Map()
    const ensure = (ch: number): ChapterStageStatus => {
      let entry = progress.get(ch)
      if (!entry) {
        entry = { outline: false, outlineReview: false, draft: false, review: false, final: false }
        progress.set(ch, entry)
      }
      return entry
    }

    let hasPlanning = true
    for (const file of [this.options.planningFiles.world, this.options.planningFiles.characters, this.options.planningFiles.locations]) {
      const parsed = await readJsonValidated(file)
      if (parsed === null) {
        hasPlanning = false
        break
      }
    }

    const dirs = {
      outline: `${this.options.chaptersRoot}/outline`,
      outlineReview: `${this.options.chaptersRoot}/outline_review`,
      draft: `${this.options.chaptersRoot}/draft`,
      review: `${this.options.chaptersRoot}/review`,
      final: `${this.options.chaptersRoot}/final`,
    }

    const listSafe = async (dir: string): Promise<string[]> => {
      try {
        return await readdir(dir)
      } catch {
        return []
      }
    }

    for (const f of await listSafe(dirs.outline)) {
      const ch = chapterOf(f)
      if (ch === null || !f.endsWith('.json')) continue
      const parsed = await readJsonValidated(`${dirs.outline}/${f}`)
      if (parsed !== null && typeof parsed === 'object' && 'scenes' in parsed) ensure(ch).outline = true
    }
    for (const f of await listSafe(dirs.outlineReview)) {
      const ch = chapterOf(f)
      if (ch === null || !f.endsWith('.json')) continue
      const parsed = await readJsonValidated(`${dirs.outlineReview}/${f}`)
      if (parsed !== null && typeof parsed === 'object' && 'score' in parsed) ensure(ch).outlineReview = true
    }
    for (const f of await listSafe(dirs.draft)) {
      const ch = chapterOf(f)
      if (ch === null || !f.endsWith('.txt')) continue
      const text = await readTextIfExists(`${dirs.draft}/${f}`)
      if (text !== null && text.trim().length > 0) ensure(ch).draft = true
    }
    for (const f of await listSafe(dirs.review)) {
      const ch = chapterOf(f)
      if (ch === null || !f.endsWith('.json')) continue
      const parsed = await readJsonValidated(`${dirs.review}/${f}`)
      if (parsed !== null && typeof parsed === 'object' && 'score' in parsed) ensure(ch).review = true
    }
    for (const f of await listSafe(dirs.final)) {
      const ch = chapterOf(f)
      if (ch === null || !f.endsWith('.txt')) continue
      const text = await readTextIfExists(`${dirs.final}/${f}`)
      if (text !== null && text.trim().length > 0) ensure(ch).final = true
    }

    let maxFinalChapter = 0
    let maxOutlineChapter = 0
    let hasAnyArtifacts = progress.size > 0 || hasPlanning
    for (const [ch, status] of progress) {
      if (status.final) maxFinalChapter = Math.max(maxFinalChapter, ch)
      if (status.outline) maxOutlineChapter = Math.max(maxOutlineChapter, ch)
    }

    return { progress, hasPlanning, hasAnyArtifacts, maxFinalChapter, maxOutlineChapter }
  }

  static nextActionFor(status: ChapterStageStatus): 'outline' | 'outline-review' | 'draft' | 'review' | 'final' | 'done' {
    if (!status.outline) return 'outline'
    if (!status.outlineReview) return 'outline-review'
    if (!status.draft) return 'draft'
    if (!status.review) return 'review'
    if (!status.final) return 'final'
    return 'done'
  }
}