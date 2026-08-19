import { join } from 'node:path'
import type { HostProvider } from '../host/types.js'
import type { ModelGateway } from '../model/gateway.js'
import type { ProjectConfig } from '../project/schema.js'
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
import { OutlinerStage } from './stages/outliner.js'
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

/** 分步执行（runPhase）的单个阶段结果：命令层据此呈现阶段摘要并询问下一步。 */
export type PhaseName = 'planning' | 'outline' | 'write'

export interface PhaseResult {
  phase: PhaseName | 'done'
  projectId: string
  status: 'done' | 'already-done'
  /** 规划阶段：世界观摘要 + 角色/地点名列表。 */
  planning?: { worldview: string; characters: string[]; locations: string[] }
  /** 章纲阶段：各章标题/摘要（目标章序升序）。 */
  outline?: Array<{ chapter: number; title: string; summary: string }>
  /** 正文阶段：产出统计。 */
  write?: { draftDone: number; finalDone: number; isolated: number[] }
  counts?: { outlineDone: number; draftDone: number; finalDone: number; total: number }
}

/** 阶段共享上下文：loadPhaseContext 一次性装配，供三个阶段方法复用（断点续跑底座）。 */
interface PhaseContext {
  projectId: string
  paths: ReturnType<typeof projectPaths>
  /** 应用风格包阈值覆盖后的项目配置（与 run() 历史行为一致）。 */
  config: ProjectConfig
  stylePack: StylePack
  matrix: MatrixStore
  isolation: IsolationLedger
  progress: ProgressMatrix
  signal: AbortSignal
  scan: { progress: ProgressMatrix; maxFinalChapter: number; hasPlanning: boolean }
  ctx: { projectId: string; gateway: ModelGateway; log: (e: StageLogEntry) => void; signal?: AbortSignal }
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

  /**
   * 全自动流水线（向后兼容）：循环 runPhase 直到全书完成或中止。
   * 规划 → 全部章纲 → 全部正文，每阶段产物断点续跑（已有产物跳过）。
   */
  async run(projectId: string, signal: AbortSignal): Promise<PipelineSummary> {
    let result: PhaseResult
    do {
      result = await this.runPhase(projectId, signal)
    } while (result.phase !== 'done' && !signal.aborted)

    const pc = await this.loadPhaseContext(projectId, signal)
    const finalCount = this.countFinal(pc.progress)
    const isolated = pc.isolation.list().map((i) => i.chapter)
    const aborted = signal.aborted
    this.deps.onEvent?.({
      type: 'pipeline.summary',
      projectId,
      totalChapters: pc.config.totalChapters,
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
    return { projectId, totalChapters: pc.config.totalChapters, finalCount, isolated, aborted }
  }

  /** 阶段共享上下文装配：数据根/项目配置/风格包覆盖/断点扫描/隔离台账/记忆矩阵/阶段日志。 */
  private async loadPhaseContext(projectId: string, signal: AbortSignal): Promise<PhaseContext> {
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

    return {
      projectId,
      paths,
      config: configWithPackOverrides,
      stylePack,
      matrix,
      isolation,
      progress: scan.progress,
      signal,
      scan,
      ctx,
    }
  }

  /** 单阶段入口：显式指定 phase 或自动选下一未完成阶段；每阶段完成发 pipeline.stage-done。 */
  async runPhase(
    projectId: string,
    signal: AbortSignal,
    options: { phase?: PhaseName; chapters?: number[] } = {},
  ): Promise<PhaseResult> {
    const pc = await this.loadPhaseContext(projectId, signal)
    const phase = options.phase ?? this.nextPhase(pc)
    const targets = this.targetChapters(pc.config, options.chapters)
    if (phase === 'planning') return this.planningPhase(pc)
    if (phase === 'outline') return this.outlinePhase(pc, targets)
    return this.writePhase(pc, targets)
  }

  async runPlanning(projectId: string, signal: AbortSignal): Promise<PhaseResult> {
    return this.runPhase(projectId, signal, { phase: 'planning' })
  }

  async runOutline(projectId: string, signal: AbortSignal, chapters?: number[]): Promise<PhaseResult> {
    return this.runPhase(projectId, signal, { phase: 'outline', chapters })
  }

  async runWrite(projectId: string, signal: AbortSignal, chapters?: number[]): Promise<PhaseResult> {
    return this.runPhase(projectId, signal, { phase: 'write', chapters })
  }

  /** 自动选下一未完成阶段：无规划 → planning；章纲未齐 → outline；否则 write。 */
  private nextPhase(pc: PhaseContext): PhaseName {
    if (!pc.scan.hasPlanning) return 'planning'
    const targets = this.targetChapters(pc.config)
    const outlineDone = targets.every((ch) => pc.progress.get(ch)?.outlineReview === true || pc.isolation.isIsolated(ch))
    if (!outlineDone) return 'outline'
    return 'write'
  }

  private async planningPhase(pc: PhaseContext): Promise<PhaseResult> {
    if (pc.scan.hasPlanning) {
      return {
        phase: 'planning',
        projectId: pc.projectId,
        status: 'already-done',
        planning: await this.planningSummary(pc),
        counts: this.countsOf(pc),
      }
    }
    try {
      await this.runPlanningCore(pc.ctx, pc.paths, pc.config, pc.matrix)
    } catch (err) {
      // 规划补全 3 轮仍失败：暂停项目并告警（spec 5.3.3 场景 1），
      // 不再让调度器静默吞错导致项目永久卡在 planning
      this.deps.onEvent?.({ type: 'pipeline.error', projectId: pc.projectId, stage: 'planning', message: err instanceof Error ? err.message : String(err) })
      try {
        await this.deps.projectService.pause(pc.projectId)
      } catch {
        /* 可能已被并发暂停 */
      }
      await this.deps.projectService.releaseLock(pc.projectId)
      throw err
    }
    await this.markPlanningDoneSafe(pc.projectId)
    this.deps.onEvent?.({ type: 'pipeline.stage-done', projectId: pc.projectId, phase: 'planning' })
    return {
      phase: 'planning',
      projectId: pc.projectId,
      status: 'done',
      planning: await this.planningSummary(pc),
      counts: this.countsOf(pc),
    }
  }

  private async planningSummary(pc: PhaseContext) {
    const world = await readJsonValidated<PlanningArtifacts['world']>(pc.paths.worldJson, (r): r is PlanningArtifacts['world'] => typeof r === 'object' && r !== null && 'worldview' in r)
    const characters = await readJsonValidated<PlanningArtifacts['characters']>(pc.paths.charactersJson, Array.isArray as unknown as (r: unknown) => r is PlanningArtifacts['characters'])
    const locations = await readJsonValidated<PlanningArtifacts['locations']>(pc.paths.locationsJson, Array.isArray as unknown as (r: unknown) => r is PlanningArtifacts['locations'])
    return {
      worldview: world?.worldview ?? '',
      characters: (characters ?? []).map((c) => c.name),
      locations: (locations ?? []).map((l) => l.name),
    }
  }

  private async outlinePhase(pc: PhaseContext, targets: number[]): Promise<PhaseResult> {
    const isDone = targets.every((ch) => pc.progress.get(ch)?.outlineReview === true || pc.isolation.isIsolated(ch))
    const summaries = (): Promise<Array<{ chapter: number; title: string; summary: string }>> => this.outlineSummaries(pc, targets)
    if (isDone) {
      return { phase: 'outline', projectId: pc.projectId, status: 'already-done', outline: await summaries(), counts: this.countsOf(pc) }
    }
    await this.outlineLane(pc, targets)
    this.deps.onEvent?.({ type: 'pipeline.stage-done', projectId: pc.projectId, phase: 'outline' })
    return { phase: 'outline', projectId: pc.projectId, status: 'done', outline: await summaries(), counts: this.countsOf(pc) }
  }

  private async outlineSummaries(
    pc: PhaseContext,
    targets: number[],
  ): Promise<Array<{ chapter: number; title: string; summary: string }>> {
    const out: Array<{ chapter: number; title: string; summary: string }> = []
    for (const ch of targets) {
      const outline = await readJsonValidated<ChapterOutline>(
        join(pc.paths.chapters.outline, `${chapterFile(ch)}.json`),
        (r): r is ChapterOutline => typeof r === 'object' && r !== null && 'scenes' in r,
      )
      if (outline) out.push({ chapter: ch, title: outline.title, summary: outline.summary })
    }
    return out
  }

  private async writePhase(pc: PhaseContext, targets: number[]): Promise<PhaseResult> {
    const isDone = targets.every((ch) => pc.progress.get(ch)?.final === true || pc.isolation.isIsolated(ch))
    const counts = this.countsOf(pc)
    const isolated = pc.isolation.list().map((i) => i.chapter)
    const allDone = counts.finalDone + isolated.length >= pc.config.totalChapters
    if (isDone) {
      if (allDone) await this.markCompleteSafe(pc.projectId)
      return {
        phase: allDone ? 'done' : 'write',
        projectId: pc.projectId,
        status: 'already-done',
        write: { draftDone: counts.draftDone, finalDone: counts.finalDone, isolated },
        counts,
      }
    }
    await this.runWriteWorkers(pc, targets)
    const after = this.countsOf(pc)
    const isolatedAfter = pc.isolation.list().map((i) => i.chapter)
    const allAfter = after.finalDone + isolatedAfter.length >= pc.config.totalChapters
    if (allAfter) await this.markCompleteSafe(pc.projectId)
    this.deps.onEvent?.({ type: 'pipeline.stage-done', projectId: pc.projectId, phase: 'write', counts: after })
    return {
      phase: allAfter ? 'done' : 'write',
      projectId: pc.projectId,
      status: 'done',
      write: { draftDone: after.draftDone, finalDone: after.finalDone, isolated: isolatedAfter },
      counts: after,
    }
  }

  /** 目标章集合：未指定时为全部章，指定时过滤越界并去重升序。 */
  private targetChapters(config: ProjectConfig, chapters?: number[]): number[] {
    if (chapters !== undefined && chapters.length > 0) {
      return [...new Set(chapters)]
        .filter((c) => Number.isInteger(c) && c >= 1 && c <= config.totalChapters)
        .sort((a, b) => a - b)
    }
    return Array.from({ length: config.totalChapters }, (_, i) => i + 1)
  }

  private countsOf(pc: PhaseContext): { outlineDone: number; draftDone: number; finalDone: number; total: number } {
    let outlineDone = 0
    let draftDone = 0
    let finalDone = 0
    for (let ch = 1; ch <= pc.config.totalChapters; ch++) {
      const s = pc.progress.get(ch)
      if (s?.outlineReview) outlineDone++
      if (s?.draft) draftDone++
      if (s?.final) finalDone++
    }
    return { outlineDone, draftDone, finalDone, total: pc.config.totalChapters }
  }

  private countFinal(progress: ProgressMatrix): number {
    let n = 0
    for (const [, s] of progress) if (s.final) n++
    return n
  }

  /** 正文阶段 worker 池：目标章并发写作（writer→checkDraft→reviewer→verdict→final→archive）。 */
  private async runWriteWorkers(pc: PhaseContext, targets: number[]): Promise<void> {
    const { ctx, paths, config, stylePack, matrix, isolation, progress, signal } = pc
    const runtimes = new Map<number, ChapterRuntime>()
    const writerPool = new ChapterSlotManager(config.scheduling.writerConcurrency)
    const workable = targets.filter((ch) => !progress.get(ch)?.final && !isolation.isIsolated(ch))

    const chapterTask = async (chapter: number): Promise<void> => {
      if (signal.aborted) return
      if (progress.get(chapter)?.final) return
      await writerPool.runExclusive(chapter, 'normal', async () => {
        try {
          await this.processChapter(chapter, {
            ctx,
            paths,
            config,
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
            projectId: pc.projectId,
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
            this.deps.onEvent?.({ type: 'chapter.isolated', projectId: pc.projectId, chapter, reason: message })
          }
        }
      })
    }

    const workers = Array.from({ length: config.scheduling.writerConcurrency }, async () => {
      while (!signal.aborted) {
        const chapter = workable.find(
          (ch) =>
            !progress.get(ch)?.final &&
            !isolation.isIsolated(ch) &&
            !writerPool.isBusy(ch) &&
            this.outlineReady(ch, progress, config.scheduling.outlineLookahead, runtimes),
        )
        if (chapter === undefined) {
          const allDone = workable.every((ch) => progress.get(ch)?.final || isolation.isIsolated(ch))
          if (allDone) return
          await sleep(50)
          continue
        }
        await chapterTask(chapter)
      }
    })

    await Promise.allSettled(workers)
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

  private async runPlanningCore(
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

  /** 章纲阶段：目标章依次 outliner→outline-reviewer，审查不达门槛进入定向/全量重生成或隔离。 */
  private async outlineLane(pc: PhaseContext, targets: number[]): Promise<void> {
    const { ctx, paths, config, stylePack, matrix, progress, isolation, signal } = pc
    const runtimes = new Map<number, ChapterRuntime>()
    const outliner = new OutlinerStage()
    const reviewer = new OutlineReviewerStage()
    const world = (await readJsonValidated<PlanningArtifacts['world']>(paths.worldJson, (r): r is PlanningArtifacts['world'] => typeof r === 'object' && r !== null && 'worldview' in r)) ?? { worldview: '', themes: [] }
    const characters = (await readJsonValidated<PlanningArtifacts['characters']>(paths.charactersJson, Array.isArray as unknown as (r: unknown) => r is PlanningArtifacts['characters'])) ?? []
    const locations = (await readJsonValidated<PlanningArtifacts['locations']>(paths.locationsJson, Array.isArray as unknown as (r: unknown) => r is PlanningArtifacts['locations'])) ?? []
    const premise = (await readTextIfExists(paths.premiseTxt)) ?? ''

    const chaptersDigest = characters.map((c) => `${c.name}（${c.tier}）${c.surfaceIdentity ?? ''}`).join('；')
    const locationsDigest = locations.map((l) => `- ${l.name}（${l.moodTone}）`).join('\n')

    for (let i = 0; i < targets.length; i++) {
      const chapter = targets[i]
      if (signal.aborted) break
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
          latestArchivedChapter: pc.scan.maxFinalChapter,
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
          i-- // 瞬时失败重试同一章（失败计数不达阈值不跳过）
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