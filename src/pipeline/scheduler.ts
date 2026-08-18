import { join } from 'node:path'
import type { HostProvider } from '../host/types.js'
import type { ModelGateway } from '../model/gateway.js'
import type { ProjectConfig, ModelBinding } from '../project/schema.js'
import { ProjectService } from '../project/service.js'
import { StylePackLoader, StylePack } from '../quality/style-pack-loader.js'
import { checkDraft, verdict } from '../quality/quality-gate.js'
import { MatrixStore, MemoryMatrix } from '../memory/matrix-store.js'
import { buildInjection } from '../memory/injection-builder.js'
import { computeConsistencySignals, protagonistNamesOf } from '../memory/rules.js'
import { extractFromFinal } from '../memory/extractor.js'
import { extractSpatiotemporalWithLlm } from '../memory/archivist.js'
import { ResumeScanner, ProgressMatrix } from './resume.js'
import { IsolationLedger } from './isolation.js'
import { ChapterSlotManager } from './worker-pool.js'
import { compressReviewFeedback } from './feedback-compressor.js'
import { PlannerStage, PlannerIncompleteError } from './stages/planner.js'
import { OutlinerStage, OutlineIncompleteError } from './stages/outliner.js'
import { OutlineReviewerStage } from './stages/outline-reviewer.js'
import { WriterStage } from './stages/writer.js'
import { ReviewerStage } from './stages/reviewer.js'
import { StageLogEntry } from './stages/stage.js'
import { ChapterOutline, PlanningArtifacts, ReviewReport } from './schemas.js'
import { atomicWriteFile, atomicWriteJson, readJsonValidated, readTextIfExists } from '../storage/atomic.js'
import { chapterFile, projectPaths } from '../storage/layout.js'

export interface SchedulerDeps {
  host: HostProvider
  gateway: ModelGateway
  projectService: ProjectService
  stylePackLoader: StylePackLoader
  onEvent?: (event: Record<string, unknown>) => void
}

export interface ChapterArtifactsView {
  chapter: number
  outline: ChapterOutline | null
  draft: string | null
  review: ReviewReport | null
  final: string | null
  matrixDigest: string | null
}

export interface PipelineSummary {
  projectId: string
  totalChapters: number
  finalCount: number
  isolated: number[]
  aborted: boolean
}

interface ChapterRuntime {
  directedRounds: number
  fullRegens: number
  reviewReports: ReviewReport[]
  consecutiveFailures: number
  draftVersion: number
}

export class PipelineScheduler {
  constructor(private readonly deps: SchedulerDeps) {}

  private log(ctx: { projectId: string }, entry: StageLogEntry): void {
    this.deps.onEvent?.({ type: 'pipeline.log', projectId: ctx.projectId, ...entry })
  }

  async run(projectId: string, signal: AbortSignal): Promise<PipelineSummary> {
    const dataRoot = await this.deps.host.storage.dataRoot()
    const paths = projectPaths(dataRoot, projectId)
    const config = await this.deps.projectService.loadProject(projectId)
    this.deps.gateway.setBindings(config.bindings)

    const stylePack = await this.deps.stylePackLoader.load(config.stylePackId)
    // 应用风格包与去AI味层的边界协议：风格包声明的阈值覆盖并入本项目的
    // 硬检查配置（generic 无声明即保持严格基线；spec 术语表的冲突仲裁条款落地）
    const configWithPackOverrides: ProjectConfig = {
      ...config,
      aiFlavor: {
        ...config.aiFlavor,
        thresholds: {
          ...config.aiFlavor.thresholds,
          ...stylePack.qualityOverrides.aiFlavorThresholds,
        },
      },
    }
    const scanner = new ResumeScanner({
      chaptersRoot: paths.chapters.root,
      planningFiles: {
        world: paths.worldJson,
        characters: paths.charactersJson,
        locations: paths.locationsJson,
      },
    })
    const scan = await scanner.scan()
    const isolation = new IsolationLedger(paths.state.isolationJson)
    await isolation.load()

    const ctx = { projectId, gateway: this.deps.gateway, log: (e: StageLogEntry) => this.log({ projectId }, e), signal }
    const matrix = new MatrixStore({
      matrixFile: paths.memory.matrixJson,
      snapshotsDir: paths.memory.snapshotsDir,
      chapterArtifactExists: async (ch) => scan.progress.get(ch)?.final === true,
    })
    await matrix.load()

    if (!scan.hasPlanning) {
      try {
        await this.runPlanning(ctx, paths, config, matrix)
      } catch (err) {
        // 规划补全 3 轮仍失败：暂停项目并告警（spec 5.3.3 场景 1），
        // 不再让调度器静默吞错导致项目永久卡在 planning
        this.deps.onEvent?.({ type: 'pipeline.error', projectId, stage: 'planning', message: err instanceof Error ? err.message : String(err) })
        try {
          await this.deps.projectService.pause(projectId)
        } catch {
          /* 可能已被并发暂停 */
        }
        await this.deps.projectService.releaseLock(projectId)
        throw err
      }
    }

    const runtimes = new Map<number, ChapterRuntime>()
    const progress: ProgressMatrix = scan.progress
    const writerPool = new ChapterSlotManager(config.scheduling.writerConcurrency)

    await this.markPlanningDoneSafe(projectId)

    const chaptersOf = Array.from({ length: config.totalChapters }, (_, i) => i + 1)

    const chapterTask = async (chapter: number): Promise<void> => {
      if (signal.aborted) return
      if (progress.get(chapter)?.final) return
      await writerPool.runExclusive(chapter, 'normal', async () => {
        try {
          await this.processChapter(chapter, {
            ctx,
            paths,
            config: configWithPackOverrides,
            stylePack,
            matrix,
            isolation,
            progress,
            runtimes,
            signal,
          })
        } catch (err) {
          const runtime = this.runtimeOf(runtimes, chapter)
          runtime.consecutiveFailures++
          const message = err instanceof Error ? err.message : String(err)
          this.deps.onEvent?.({
            type: 'chapter.error',
            projectId,
            chapter,
            message: `${err instanceof Error ? err.stack : message}`,
          })
          if (runtime.consecutiveFailures >= config.scheduling.chapterFailureLimit) {
            await isolation.isolate({
              chapter,
              reason: `连续失败 ${runtime.consecutiveFailures} 次：${message}`,
              kind: 'consecutive-failures',
              rewriteSummary: `失败${runtime.consecutiveFailures}次`,
            })
            this.deps.onEvent?.({ type: 'chapter.isolated', projectId, chapter, reason: message })
          }
        }
      })
    }

    const workers = Array.from({ length: config.scheduling.writerConcurrency }, async () => {
      while (!signal.aborted) {
        const chapter = chaptersOf.find(
          (ch) =>
            !progress.get(ch)?.final &&
            !isolation.isIsolated(ch) &&
            !writerPool.isBusy(ch) &&
            this.outlineReady(ch, progress, config.scheduling.outlineLookahead, runtimes),
        )
        if (chapter === undefined) {
          const allDone = chaptersOf.every((ch) => progress.get(ch)?.final || isolation.isIsolated(ch))
          if (allDone) return
          await sleep(50)
          continue
        }
        await chapterTask(chapter)
      }
    })

    const outlineLane = this.runOutlineLane({
      ctx,
      paths,
      config: configWithPackOverrides,
      stylePack,
      matrix,
      progress,
      runtimes,
      isolation,
      signal,
      scan,
    }).catch(async (err: unknown) => {
      this.deps.onEvent?.({
        type: 'pipeline.error',
        projectId,
        message: err instanceof Error ? err.message : String(err),
      })
    })

    await Promise.allSettled([outlineLane, ...workers])

    const finalCount = chaptersOf.filter((ch) => progress.get(ch)?.final).length
    const isolated = isolation.list().map((i) => i.chapter)
    const aborted = signal.aborted
    if (!aborted && finalCount + isolated.length >= config.totalChapters) {
      await this.markCompleteSafe(projectId)
    }
    this.deps.onEvent?.({
      type: 'pipeline.summary',
      projectId,
      totalChapters: config.totalChapters,
      finalCount,
      isolated,
      aborted,
    })
    if (aborted) {
      try {
        await this.deps.projectService.pause(projectId)
      } catch {
        /* may already be paused */
      }
    }
    await this.deps.projectService.releaseLock(projectId)
    return { projectId, totalChapters: config.totalChapters, finalCount, isolated, aborted }
  }

  private async markPlanningDoneSafe(projectId: string): Promise<void> {
    try {
      await this.deps.projectService.markPlanningDone(projectId)
    } catch {
      /* resumed project may already be generating */
    }
  }

  private async markCompleteSafe(projectId: string): Promise<void> {
    try {
      await this.deps.projectService.markComplete(projectId)
    } catch {
      /* completed 项目的局部重生成：状态已是终态，无需迁移 */
    }
  }

  private outlineReady(
    chapter: number,
    progress: ProgressMatrix,
    lookahead: number,
    _runtimes: Map<number, ChapterRuntime>,
  ): boolean {
    const status = progress.get(chapter)
    if (status?.draft) return true
    return status?.outlineReview === true
  }

  private async runPlanning(
    ctx: { projectId: string; gateway: ModelGateway; log: (e: StageLogEntry) => void; signal?: AbortSignal },
    paths: ReturnType<typeof projectPaths>,
    config: ProjectConfig,
    matrix: MatrixStore,
  ): Promise<void> {
    const planner = new PlannerStage()
    const premise = await this.deps.projectService.readPremise(config.projectId)
    // 补全循环（spec 5.3.1 规则 2 / 5.3.3 场景 1）：产物不完整不落盘，
    // 携缺失清单重试；连续 3 次仍失败向上抛出，由 run() 暂停项目并告警
    let feedback: string[] = []
    for (let attempt = 0; attempt < 3; attempt++) {
      let artifacts: import('./schemas.js').PlanningArtifacts
      try {
        artifacts = await planner.execute(
          { premise, repairFeedback: feedback, stylePackName: (await this.deps.stylePackLoader.load(config.stylePackId)).displayName },
          ctx,
        )
      } catch (err) {
        if (err instanceof PlannerIncompleteError) {
          feedback = err.problems
          continue
        }
        throw err
      }
      await atomicWriteJson(paths.worldJson, artifacts.world)
      await atomicWriteJson(paths.charactersJson, artifacts.characters)
      await atomicWriteJson(paths.locationsJson, artifacts.locations)
      for (const c of artifacts.characters) {
        await matrix.updateCharacterState(c.name, c.tier, 1, {}, `规划建档：${c.tier}`)
      }
      return
    }
    throw new Error(`规划阶段连续失败：${feedback.join('；')}`)
  }

  private async runOutlineLane(args: {
    ctx: { projectId: string; gateway: ModelGateway; log: (e: StageLogEntry) => void; signal?: AbortSignal }
    paths: ReturnType<typeof projectPaths>
    config: ProjectConfig
    stylePack: StylePack
    matrix: MatrixStore
    progress: ProgressMatrix
    runtimes: Map<number, ChapterRuntime>
    isolation: IsolationLedger
    signal: AbortSignal
    scan: { progress: ProgressMatrix; maxFinalChapter: number }
  }): Promise<void> {
    const { ctx, paths, config, stylePack, matrix, progress, runtimes, isolation, signal } = args
    const outliner = new OutlinerStage()
    const reviewer = new OutlineReviewerStage()
    const world = (await readJsonValidated<PlanningArtifacts['world']>(paths.worldJson, (r): r is PlanningArtifacts['world'] => typeof r === 'object' && r !== null && 'worldview' in r)) ?? { worldview: '', themes: [] }
    const characters = (await readJsonValidated<PlanningArtifacts['characters']>(paths.charactersJson, Array.isArray as unknown as (r: unknown) => r is PlanningArtifacts['characters'])) ?? []
    const locations = (await readJsonValidated<PlanningArtifacts['locations']>(paths.locationsJson, Array.isArray as unknown as (r: unknown) => r is PlanningArtifacts['locations'])) ?? []
    const premise = (await readTextIfExists(paths.premiseTxt)) ?? ''

    const chaptersDigest = characters.map((c) => `${c.name}（${c.tier}）${c.surfaceIdentity ?? ''}`).join('；')
    const locationsDigest = locations.map((l) => `- ${l.name}（${l.moodTone}）`).join('\n')

    for (let chapter = 1; chapter <= config.totalChapters && !signal.aborted; chapter++) {
      const status = progress.get(chapter)
      if (status?.outlineReview) continue
      if (isolation.isIsolated(chapter)) continue
      const runtime = this.runtimeOf(runtimes, chapter)
      const locationNames = locations.map((l) => l.name)
      // 章号注入阶段日志：供过程视图（novel/progress）按章呈现环节流转
      const chapterCtx = { ...ctx, log: (e: StageLogEntry) => ctx.log({ ...e, chapter }) }

      let outline: ChapterOutline | null = null
      let passed = false
      let mode: 'first' | 'directed' | 'full-regen' = 'first'
      const history: ReviewReport[] = []

      try {
      while (!passed && !signal.aborted) {
        const injection = buildInjection(matrix.current(), chapter)
        const previousOutline = mode === 'directed' ? outline : null
        const feedback = compressReviewFeedback(history)?.formatted ?? null
        outline = await outliner.execute(
          {
            mode,
            chapter,
            totalChapters: config.totalChapters,
            premiseDigest: premise.slice(0, 500),
            world,
            charactersDigest: chaptersDigest,
            locationsDigest,
            locationNames,
            injection,
            previousOutline,
            reviewFeedback: feedback,
            stylePack,
          },
          chapterCtx,
        )
        await atomicWriteJson(join(paths.chapters.outline, `${chapterFile(chapter)}.json`), outline)
        this.ensureProgress(progress, chapter).outline = true

        const signals = computeConsistencySignals(matrix.current(), chapter, {
          protagonistNames: protagonistNamesOf(matrix.current()),
          latestArchivedChapter: args.scan.maxFinalChapter,
        })
        const review = await reviewer.execute(
          {
            outlineJson: JSON.stringify(outline),
            chapter,
            stylePack,
            gate: config.gates.outlineGate,
            previousSpacetime: matrix.current().spatiotemporalLatest,
            stalledMysteryAlert: signals.stalledMysteryAlert,
            historyReports: history,
          },
          chapterCtx,
        )
        history.push(review.report)
        await atomicWriteJson(join(paths.chapters.outlineReview, `${chapterFile(chapter)}_review.json`), review.report)
        passed = review.passed

        if (passed) {
          this.ensureProgress(progress, chapter).outlineReview = true
          break
        }
        if (mode === 'first' || mode === 'directed') {
          if (runtime.directedRounds >= config.gates.outlineDirectedLimit) {
            if (runtime.fullRegens >= config.gates.outlineFullRegenLimit) {
              await isolation.isolate({
                chapter,
                reason: `章纲审查超限（定向${runtime.directedRounds}轮+全量${runtime.fullRegens}次后仍低于门槛）`,
                kind: 'review-limit',
                rewriteSummary: `定向${runtime.directedRounds}轮/全量${runtime.fullRegens}次`,
              })
              this.deps.onEvent?.({ type: 'chapter.isolated', projectId: ctx.projectId, chapter, reason: '章纲审查超限' })
              break
            }
            mode = 'full-regen'
            runtime.fullRegens++
          } else {
            mode = 'directed'
            runtime.directedRounds++
          }
        } else {
          if (runtime.fullRegens >= config.gates.outlineFullRegenLimit) {
            await isolation.isolate({
              chapter,
              reason: '章纲审查超限（全量重生成后仍不通过）',
              kind: 'review-limit',
              rewriteSummary: `定向${runtime.directedRounds}轮/全量${runtime.fullRegens}次`,
            })
            break
          }
          runtime.fullRegens++
        }
      }
      } catch (err) {
        runtime.consecutiveFailures++
        const message = err instanceof Error ? err.message : String(err)
        this.deps.onEvent?.({ type: 'chapter.error', projectId: ctx.projectId, chapter, message })
        if (runtime.consecutiveFailures >= config.scheduling.chapterFailureLimit) {
          await isolation.isolate({
            chapter,
            reason: `章纲阶段连续失败：${message}`,
            kind: 'consecutive-failures',
            rewriteSummary: `失败${runtime.consecutiveFailures}次`,
          })
        } else {
          chapter--
        }
      }
    }
  }

  private ensureProgress(progress: ProgressMatrix, chapter: number): import('./resume.js').ChapterStageStatus {
    let entry = progress.get(chapter)
    if (!entry) {
      entry = { outline: false, outlineReview: false, draft: false, review: false, final: false }
      progress.set(chapter, entry)
    }
    return entry
  }

  private runtimeOf(runtimes: Map<number, ChapterRuntime>, chapter: number): ChapterRuntime {
    let rt = runtimes.get(chapter)
    if (!rt) {
      rt = { directedRounds: 0, fullRegens: 0, reviewReports: [], consecutiveFailures: 0, draftVersion: 0 }
      runtimes.set(chapter, rt)
    }
    return rt
  }

  private async processChapter(chapter: number, args: {
    ctx: { projectId: string; gateway: ModelGateway; log: (e: StageLogEntry) => void; signal?: AbortSignal }
    paths: ReturnType<typeof projectPaths>
    config: ProjectConfig
    stylePack: StylePack
    matrix: MatrixStore
    isolation: IsolationLedger
    progress: ProgressMatrix
    runtimes: Map<number, ChapterRuntime>
    signal: AbortSignal
  }): Promise<void> {
    const { ctx, paths, config, stylePack, matrix, isolation, progress, runtimes, signal } = args
    const chapterCtx = { ...ctx, log: (e: StageLogEntry) => ctx.log({ ...e, chapter }) }
    const writer = new WriterStage()
    const reviewer = new ReviewerStage()
    const runtime = this.runtimeOf(runtimes, chapter)

    const outline = await readJsonValidated<ChapterOutline>(
      join(paths.chapters.outline, `${chapterFile(chapter)}.json`),
      (r): r is ChapterOutline => typeof r === 'object' && r !== null && 'scenes' in r,
    )
    if (!outline) return
    const world = (await readJsonValidated<PlanningArtifacts['world']>(paths.worldJson, (r): r is PlanningArtifacts['world'] => typeof r === 'object' && r !== null && 'worldview' in r)) ?? { worldview: '', themes: [] }
    const characters = (await readJsonValidated<PlanningArtifacts['characters']>(paths.charactersJson, Array.isArray as unknown as (r: unknown) => r is PlanningArtifacts['characters'])) ?? []
    const locations = (await readJsonValidated<PlanningArtifacts['locations']>(paths.locationsJson, Array.isArray as unknown as (r: unknown) => r is PlanningArtifacts['locations'])) ?? []
    const chaptersDigest = characters.map((c) => `${c.name}（${c.tier}）${c.surfaceIdentity ?? ''}`).join('；')
    const locationNames = locations.map((l) => l.name)
    const tierMap = new Map(characters.map((c) => [c.name, c.tier] as const))

    let draft = await readTextIfExists(join(paths.chapters.draft, `${chapterFile(chapter)}.txt`))
    let mode: 'first' | 'directed' = 'first'
    let rewrites = 0

    while (!signal.aborted) {
      const status = this.ensureProgress(progress, chapter)

      const gate = checkDraft(draft ?? '', { structured: config.structured, aiFlavor: config.aiFlavor })

      if (draft !== null && gate.passed) {
        const signals = computeConsistencySignals(matrix.current(), chapter, {
          protagonistNames: protagonistNamesOf(matrix.current()),
          latestArchivedChapter: this.latestFinal(progress),
        })
        const review = await reviewer.execute(
          {
            chapter,
            draftText: draft,
            version: Math.max(runtime.draftVersion, 1),
            outlineSummary: outline.summary,
            stylePack,
            gate: config.gates.draftGate,
            signals,
            previousSpacetime: matrix.current().spatiotemporalLatest,
            locationDigest: locationsDigest(locations),
          },
          chapterCtx,
        )
        runtime.reviewReports.push(review.report)
        await atomicWriteJson(join(paths.chapters.review, `${chapterFile(chapter)}_review.json`), review.report)
        status.review = true

        const v = verdict(
          { score: review.report.score, styleDeviation: review.report.styleDeviation },
          gate,
          config.gates,
        )
        if (v.accepted) {
          await atomicWriteFile(join(paths.chapters.final, `${chapterFile(chapter)}.txt`), draft)
          status.final = true
          await this.archiveChapter(chapter, draft, outline, matrix, tierMap, locationNames, paths, ctx)
          this.deps.onEvent?.({ type: 'chapter.final', projectId: ctx.projectId, chapter })
          return
        }
      }

      if (rewrites >= config.gates.draftRewriteLimit) {
        await isolation.isolate({
          chapter,
          reason: '正文审查超限（重写轮次耗尽）',
          kind: 'review-limit',
          rewriteSummary: `重写${rewrites}轮`,
        })
        this.deps.onEvent?.({ type: 'chapter.isolated', projectId: ctx.projectId, chapter, reason: '审查超限' })
        return
      }

      const injection = buildInjection(matrix.current(), chapter)
      const previousEnding = await this.tailOf(paths, chapter - 1)
      const aiFlavorHits =
        mode === 'directed'
          ? [
              ...gate.deAi.hits.map((h) => `${h.type}: ${h.excerpt}`),
              ...runtime.reviewReports.flatMap((r) => r.aiFlavorVerdict.hardHits.map((h) => `${h.type}: ${h.excerpt}`)),
            ]
          : []

      draft = await writer.execute(
        {
          chapter,
          outline,
          world,
          charactersDigest: chaptersDigest,
          injection,
          previousChapterEnding: previousEnding,
          mode,
          reviewFeedback: compressReviewFeedback(runtime.reviewReports)?.formatted ?? (gate.rewriteReasons.join('\n') || null),
          aiFlavorHits,
          guidanceNote: null,
          stylePack,
          wordRange: { min: config.structured.minWords, max: config.structured.maxWords },
        },
        chapterCtx,
      )
      if (mode === 'directed') rewrites++
      runtime.draftVersion++
      const draftFile = runtime.draftVersion > 1
        ? join(paths.chapters.draft, `${chapterFile(chapter)}_v${runtime.draftVersion}.txt`)
        : join(paths.chapters.draft, `${chapterFile(chapter)}.txt`)
      await atomicWriteFile(draftFile, draft)
      await atomicWriteFile(join(paths.chapters.draft, `${chapterFile(chapter)}.txt`), draft)
      status.draft = true
      status.review = false
      mode = 'directed'
    }
  }

  private latestFinal(progress: ProgressMatrix): number {
    let max = 0
    for (const [ch, s] of progress) if (s.final) max = Math.max(max, ch)
    return max
  }

  private async tailOf(paths: ReturnType<typeof projectPaths>, chapter: number): Promise<string | null> {
    if (chapter < 1) return null
    const text = await readTextIfExists(join(paths.chapters.final, `${chapterFile(chapter)}.txt`))
    if (!text) return null
    return text.slice(-200)
  }

  private async archiveChapter(
    chapter: number,
    finalText: string,
    outline: ChapterOutline,
    matrix: MatrixStore,
    tierMap: Map<string, import('../memory/matrix-store.js').CharacterTierCN>,
    locationNames: string[],
    paths: ReturnType<typeof projectPaths>,
    ctx: { projectId: string },
  ): Promise<void> {
    const extraction = extractFromFinal({
      finalText,
      outline: { chapter, foreshadowPlan: outline.foreshadowPlan },
      characterTiers: tierMap,
      locationNames,
    })

    for (const op of extraction.foreshadowOps) {
      const existing = matrix.current().foreshadows.find((f) => f.title === op.title)
      if (!existing && op.action === 'planted') {
        await matrix.addForeshadow({ title: op.title, plantedChapter: chapter, expectedRevealChapter: chapter + 8 })
      } else if (existing && op.action === 'revealed') {
        await matrix.revealForeshadow(existing.id, chapter)
      }
    }
    for (const motif of extraction.motifsHit) await matrix.recordMotif(motif, chapter)
    await matrix.recordAppearance(chapter, extraction.characterAppearances)
    for (const p of extraction.protagonistUpdates) {
      await matrix.updateCharacterState(p.name, tierMap.get(p.name) ?? '主角', chapter, { lastSeen: `第${chapter}章` }, p.note)
    }

    if (extraction.spacetime) {
      await matrix.setSpatiotemporal(extraction.spacetime)
    } else {
      const outcome = await extractSpatiotemporalWithLlm(this.deps.gateway, {
        chapter,
        finalText,
        locationNames,
        projectId: ctx.projectId,
      })
      if (outcome.kind === 'extracted') {
        await matrix.setSpatiotemporal(outcome.entry)
      } else {
        await matrix.setSpatiotemporal({
          chapter,
          startScene: { location: locationNames[0] ?? '未知', description: '' },
          endScene: { location: locationNames[0] ?? '未知', description: '' },
          timeline: '待人工确认',
          status: 'pending-manual',
        })
        await matrix.markSpatiotemporalPendingManual(chapter)
        this.deps.onEvent?.({ type: 'spacetime.pending-manual', projectId: ctx.projectId, chapter, reason: outcome.reason })
      }
    }
    await matrix.snapshot(chapter)
  }

  async inspectChapter(projectId: string, chapter: number): Promise<ChapterArtifactsView> {
    const dataRoot = await this.deps.host.storage.dataRoot()
    const paths = projectPaths(dataRoot, projectId)
    const outline = await readJsonValidated<ChapterOutline>(
      join(paths.chapters.outline, `${chapterFile(chapter)}.json`),
      (r): r is ChapterOutline => typeof r === 'object' && r !== null && 'scenes' in r,
    )
    const draft = await readTextIfExists(join(paths.chapters.draft, `${chapterFile(chapter)}.txt`))
    const review = await readJsonValidated<ReviewReport>(
      join(paths.chapters.review, `${chapterFile(chapter)}_review.json`),
      (r): r is ReviewReport => typeof r === 'object' && r !== null && 'score' in r,
    )
    const final = await readTextIfExists(join(paths.chapters.final, `${chapterFile(chapter)}.txt`))
    const matrix = await readJsonValidated<MemoryMatrix>(paths.memory.matrixJson)
    return {
      chapter,
      outline: outline ?? null,
      draft: draft ?? null,
      review: review ?? null,
      final: final ?? null,
      matrixDigest: matrix ? `伏笔${matrix.foreshadows.length}/悬念${matrix.mysteries.length}/时空${matrix.spatiotemporalLatest?.endScene.location ?? '未知'}` : null,
    }
  }
}

function locationsDigest(locations: PlanningArtifacts['locations']): string {
  return locations.map((l) => `${l.name}（${l.moodTone}）`).join('；')
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}