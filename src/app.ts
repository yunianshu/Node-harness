import { join } from 'node:path'
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises'
import type { HostProvider } from './host/types.js'
import { FakeHost } from './host/dsh-adapter.js'
import { ProviderRegistry } from './model/registry.js'
import { GlobalRateLimiter } from './model/rate-limiter.js'
import { ChannelManager } from './model/fallback.js'
import { ModelGateway } from './model/gateway.js'
import { ProjectService } from './project/service.js'
import { StylePackLoader } from './quality/style-pack-loader.js'
import { PipelineScheduler, PhaseName, PhaseResult } from './pipeline/scheduler.js'
import { IsolationLedger } from './pipeline/isolation.js'
import { ChapterSlotManager } from './pipeline/worker-pool.js'
import { GuidanceService, GuidanceStage, GuidanceNote } from './guidance/service.js'
import { RegenOrchestrator, RegenScope } from './guidance/regen-orchestrator.js'
import { AuditLog } from './storage/audit.js'
import { chapterFile, ensureProjectLayout, projectPaths } from './storage/layout.js'
import { fileExists } from './storage/atomic.js'
import { compile } from './output/compiler.js'
import { exportPackage } from './output/exporter.js'
import { queryProgress, buildSummaryReport } from './notify/progress.js'
import { WebhookNotifier } from './notify/webhook.js'
import type { DomainEvent } from './notify/events.js'

export interface CommandSpec {
  name: string
  description: string
  args: Array<{ key: string; required: boolean; description: string }>
}

export interface NovelAppOptions {
  host?: HostProvider
  dataRoot?: string
  stylePackRoot?: string
  fetchImpl?: typeof fetch
  gateway?: ModelGateway
}

/** 分步执行的阶段提问：命令层返回继续/停止，供聊天流逐阶段询问。 */
export type PhaseAskDecision = 'continue' | 'stop'
export type PhaseAskFn = (phase: { label: string; summary: string }) => Promise<PhaseAskDecision>

const PHASE_LABELS: Record<PhaseName | 'done', string> = { planning: '规划', outline: '章纲', write: '正文', done: '全书完成' }
const PHASE_ROLES: Record<PhaseName, 'planner' | 'outliner' | 'writer'> = { planning: 'planner', outline: 'outliner', write: 'writer' }

/** 阶段结果 → 聊天可读摘要（命令层呈现给用户，字段级可调整由此文本触发）。 */
export function phaseSummaryText(result: PhaseResult): string {
  const counts = result.counts
  const countSuffix = counts
    ? `\n进度：章纲 ${counts.outlineDone}/${counts.total} · 草稿 ${counts.draftDone}/${counts.total} · 终稿 ${counts.finalDone}/${counts.total}`
    : ''
  if (result.phase === 'planning' && result.planning) {
    return [
      `世界观：${result.planning.worldview}`,
      `人物：${result.planning.characters.join('、') || '无'}`,
      `地点：${result.planning.locations.join('、') || '无'}`,
    ].join('\n') + countSuffix
  }
  if (result.phase === 'outline' && result.outline) {
    return (
      result.outline.map((o) => `第${o.chapter}章「${o.title}」${o.summary ? `：${o.summary.slice(0, 50)}` : ''}`).join('\n') ||
      '（无章纲产物）'
    ) + countSuffix
  }
  if (result.phase === 'write' && result.write) {
    const parts = [`草稿 ${result.write.draftDone} 章`, `终稿 ${result.write.finalDone} 章`]
    if (result.write.isolated.length > 0) parts.push(`隔离 ${result.write.isolated.join(',')}`)
    return parts.join(' · ') + countSuffix
  }
  return result.status === 'already-done' ? '该阶段已有产物，未重复执行' : '完成'
}

export class NovelHarnessApp {
  readonly host: HostProvider
  private readonly registry: ProviderRegistry
  private readonly limiter: GlobalRateLimiter
  private readonly channels: ChannelManager
  readonly gateway: ModelGateway
  readonly projects: ProjectService
  readonly stylePacks: StylePackLoader
  readonly scheduler: PipelineScheduler
  readonly guidance: GuidanceService
  readonly regen: RegenOrchestrator
  readonly webhook: WebhookNotifier
  private readonly running = new Map<string, AbortController>()
  readonly events: DomainEvent[] = []
  private readonly pipelineListeners = new Set<(event: DomainEvent) => void>()

  /** 订阅流水线领域事件（进度卡片等消费方），返回退订函数。 */
  onPipelineEvent(listener: (event: DomainEvent) => void): () => void {
    this.pipelineListeners.add(listener)
    return () => {
      this.pipelineListeners.delete(listener)
    }
  }

  private emitPipelineEvent(event: DomainEvent): void {
    this.events.push(event)
    this.webhook.handleEvent(event)
    for (const listener of this.pipelineListeners) {
      try {
        listener(event)
      } catch {
        /* 监听方故障不阻断流水线 */
      }
    }
  }

  constructor(options: NovelAppOptions = {}) {
    this.host = options.host ?? new FakeHost(options.dataRoot)
    this.registry = new ProviderRegistry()
    this.limiter = new GlobalRateLimiter()
    this.channels = new ChannelManager()
    this.stylePacks = new StylePackLoader(options.stylePackRoot ?? join(process.cwd(), 'style-packs'))
    this.gateway =
      options.gateway ??
      new ModelGateway({
        registry: this.registry,
        limiter: this.limiter,
        channels: this.channels,
        host: this.host,
        dataRoot: options.dataRoot ?? '',
        fetchImpl: options.fetchImpl,
      })
    this.projects = new ProjectService({ host: this.host, listStylePacks: () => this.stylePacks.list() })
    this.scheduler = new PipelineScheduler({
      host: this.host,
      gateway: this.gateway,
      projectService: this.projects,
      stylePackLoader: this.stylePacks,
      onEvent: (e) => {
        const event = { ...e, timestamp: Date.now() } as DomainEvent
        this.emitPipelineEvent(event)
      },
    })
    this.webhook = new WebhookNotifier(options.fetchImpl ?? fetch)
    this.guidance = new GuidanceService({
      isProjectPaused: async (id) => {
        const status = (await this.projects.loadProject(id)).status
        return status === 'paused' || status === 'completed'
      },
      hasArtifactsFor: async (id, target) => {
        const paths = await this.pathsOf(id)
        const chapter = Math.max(...target.chapters)
        return fileExists(join(paths.chapters.outline, `${chapterFile(chapter)}.json`))
      },
      projectRoot: async (id) => {
        const paths = await this.pathsOf(id)
        await ensureProjectLayout(paths)
        return { guidanceFile: paths.guidance.notesJson, auditFile: paths.logs.auditLog }
      },
    })
    const regenSlots = new ChapterSlotManager(2)
    this.regen = new RegenOrchestrator({
      isProjectPaused: async (id) => {
        const status = (await this.projects.loadProject(id)).status
        return status === 'paused' || status === 'completed'
      },
      totalChapters: async (id) => (await this.projects.loadProject(id)).totalChapters,
      hasFinal: async (id, ch) => fileExists(join((await this.pathsOf(id)).chapters.final, `${chapterFile(ch)}.txt`)),
      isIsolated: async (id, ch) => {
        const ledger = new IsolationLedger((await this.pathsOf(id)).state.isolationJson)
        await ledger.load()
        return ledger.isIsolated(ch)
      },
      releaseIsolation: async (id, ch) => {
        const ledger = new IsolationLedger((await this.pathsOf(id)).state.isolationJson)
        await ledger.load()
        await ledger.release(ch)
      },
      consumeNote: (id, ch, stage, requestId) => this.guidance.consume(id, ch, stage, requestId),
      acquireSlot: async (_id, _ch, _priority) => {
        await regenSlots.acquireSlot(_ch, 'guidance')
        return () => regenSlots.releaseSlot(_ch)
      },
      regenerateChapter: (id, request) => this.regenerateChapter(id, request),
      audit: async (id, operator, action, detail) => {
        const paths = await this.pathsOf(id)
        await new AuditLog(paths.logs.auditLog).append(operator, action, detail)
      },
    })
  }

  private async dataRoot(): Promise<string> {
    return this.host.storage.dataRoot()
  }

  async pathsOf(projectId: string) {
    return projectPaths(await this.dataRoot(), projectId)
  }

  commands(): CommandSpec[] {
    return [
      { name: 'novel.create', description: '创建小说项目', args: [{ key: 'name', required: true, description: '项目名' }, { key: 'premise', required: true, description: '故事前提' }, { key: 'chapters', required: true, description: '总章数' }, { key: 'stylePack', required: false, description: '风格包' }] },
      { name: 'novel.start', description: '启动生成（逐阶段询问，--auto 全自动）', args: [{ key: 'project', required: true, description: '项目ID' }, { key: 'auto', required: false, description: '全自动不询问' }] },
      { name: 'novel.plan', description: '执行规划阶段', args: [{ key: 'project', required: true, description: '项目ID' }, { key: 'model', required: false, description: '覆盖规划模型' }, { key: 'temperature', required: false, description: '覆盖温度' }, { key: 'maxTokens', required: false, description: '覆盖输出上限' }] },
      { name: 'novel.outline', description: '执行章纲阶段', args: [{ key: 'project', required: true, description: '项目ID' }, { key: 'chapters', required: false, description: '章号列表' }, { key: 'model', required: false, description: '覆盖章纲模型' }, { key: 'temperature', required: false, description: '覆盖温度' }, { key: 'maxTokens', required: false, description: '覆盖输出上限' }] },
      { name: 'novel.write', description: '执行正文阶段', args: [{ key: 'project', required: true, description: '项目ID' }, { key: 'chapters', required: false, description: '章号列表' }, { key: 'model', required: false, description: '覆盖写作模型' }, { key: 'temperature', required: false, description: '覆盖温度' }, { key: 'maxTokens', required: false, description: '覆盖输出上限' }] },
      { name: 'novel.pause', description: '暂停生成', args: [{ key: 'project', required: true, description: '项目ID' }] },
      { name: 'novel.resume', description: '恢复生成', args: [{ key: 'project', required: true, description: '项目ID' }] },
      { name: 'novel.stop', description: '终止项目', args: [{ key: 'project', required: true, description: '项目ID' }] },
      { name: 'novel.status', description: '两级进度视图', args: [{ key: 'project', required: true, description: '项目ID' }] },
      { name: 'novel.report', description: '总结报告', args: [{ key: 'project', required: true, description: '项目ID' }] },
      { name: 'novel.export', description: '合并全文/交付包', args: [{ key: 'project', required: true, description: '项目ID' }, { key: 'allowGaps', required: false, description: '允许缺章占位' }] },
      { name: 'novel.guidance.add', description: '附加指导意见', args: [{ key: 'project', required: true, description: '项目ID' }, { key: 'chapter', required: true, description: '章号' }, { key: 'stage', required: true, description: 'outline|content' }, { key: 'content', required: true, description: '意见内容' }] },
      { name: 'novel.guidance.regen', description: '指导重生成', args: [{ key: 'project', required: true, description: '项目ID' }, { key: 'chapters', required: true, description: '章号列表' }, { key: 'stage', required: true, description: 'outline|content' }, { key: 'confirmFinal', required: false, description: '确认终稿重生成' }] },
      { name: 'novel.admin.provider', description: '注册服务商/凭据', args: [{ key: 'providerId', required: true, description: '服务商ID' }, { key: 'kind', required: true, description: 'openai-compat|glm-plan-cn|glm-plan-intl' }, { key: 'baseURL', required: true, description: '端点' }, { key: 'apiKey', required: false, description: 'API Key' }, { key: 'planToken', required: false, description: '订阅 token' }, { key: 'channel', required: false, description: 'cn|intl' }] },
      { name: 'novel.regenerate', description: '失败章重入队', args: [{ key: 'project', required: true, description: '项目ID' }, { key: 'chapters', required: true, description: '章号列表' }] },
      { name: 'novel.probe', description: '探测 dsh 底座模型能力', args: [{ key: 'call', required: false, description: 'provider/model 流式调用' }, { key: 'text', required: false, description: '调用文本' }, { key: 'maxTokens', required: false, description: '输出上限' }] },
    ]
  }

  async executeCommand(name: string, args: Record<string, unknown>, ask?: PhaseAskFn): Promise<unknown> {
    switch (name) {
      case 'novel.create':
        return this.projects.create({
          name: String(args.name),
          premise: String(args.premise),
          totalChapters: Number(args.chapters),
          ...(args.stylePack ? { stylePackId: String(args.stylePack) } : {}),
        }, String(args.operator ?? 'cli'))
      case 'novel.start':
        // 默认逐阶段执行（聊天询问下一步）；--auto 或非交互调用（无提问通道）回退全自动
        if (Boolean(args.auto) || ask === undefined) return this.startProject(String(args.project))
        return this.startStepped(String(args.project), ask)
      case 'novel.plan':
        return this.runOnePhase(String(args.project), 'planning')
      case 'novel.outline':
        return this.runOnePhase(String(args.project), 'outline', {
          chapters: args.chapters as number[] | undefined,
          model: args.model !== undefined ? String(args.model) : undefined,
          temperature: args.temperature !== undefined ? Number(args.temperature) : undefined,
          maxTokens: args.maxTokens !== undefined ? Number(args.maxTokens) : undefined,
        })
      case 'novel.write':
        return this.runOnePhase(String(args.project), 'write', {
          chapters: args.chapters as number[] | undefined,
          model: args.model !== undefined ? String(args.model) : undefined,
          temperature: args.temperature !== undefined ? Number(args.temperature) : undefined,
          maxTokens: args.maxTokens !== undefined ? Number(args.maxTokens) : undefined,
        })
      case 'novel.pause':
        return this.pauseProject(String(args.project))
      case 'novel.resume':
        return this.startProject(String(args.project))
      case 'novel.stop':
        this.running.get(String(args.project))?.abort()
        this.running.delete(String(args.project))
        return this.projects.stop(String(args.project))
      case 'novel.status':
        return this.status(String(args.project))
      case 'novel.report':
        return this.report(String(args.project))
      case 'novel.export':
        return this.export(String(args.project), { allowGaps: Boolean(args.allowGaps) })
      case 'novel.guidance.add':
        return this.guidance.attach(String(args.project), { chapters: [Number(args.chapter)], stage: String(args.stage) as GuidanceStage }, String(args.content))
      case 'novel.guidance.regen':
        return this.regen.regenerate(
          String(args.project),
          { kind: String(args.stage) as 'content' | 'outline', chapters: (args.chapters as number[]).map(Number) },
          { confirmFinalOverride: Boolean(args.confirmFinal) },
        )
      case 'novel.admin.provider':
        return this.registerProvider(args)
      case 'novel.regenerate':
        return this.projects.regenerate(String(args.project), (args.chapters as number[]).map(Number))
      case 'novel.probe':
        return this.probeDshLlm(args)
      default:
        throw new Error(`未知命令：${name}`)
    }
  }

  async registerProvider(args: Record<string, unknown>): Promise<{ providerId: string }> {
    const providerId = String(args.providerId)
    const kind = String(args.kind) as 'openai-compat' | 'glm-plan-cn' | 'glm-plan-intl'
    this.registry.register({ providerId, kind, baseURL: String(args.baseURL), qps: args.qps !== undefined ? Number(args.qps) : undefined })
    const secret = args.apiKey ?? args.planToken
    if (secret) {
      const handle = await this.host.credentials.put(
        {
          providerId,
          kind: args.apiKey ? 'api-key' : 'plan-token',
          ...(args.channel ? { channel: String(args.channel) as 'cn' | 'intl' } : {}),
        },
        String(secret),
      )
      this.registry.attachCredential(providerId, handle)
    }
    return { providerId }
  }

  /**
   * 探测 dsh 底座模型能力（开发诊断命令）：
   * - 无参：列出全部可用模型（provider route / model id）
   * - --call provider/model：对指定模型做一次真实流式调用，返回聚合文本
   */
  async probeDshLlm(args: Record<string, unknown>): Promise<unknown> {
    const models = await this.host.llm.listModels()
    const call = args.call !== undefined ? String(args.call) : undefined
    if (!call) {
      return {
        kind: 'models',
        count: models.length,
        models: models.map((m) => `${m.provider}/${m.model}${m.name ? `（${m.name}）` : ''}`),
      }
    }
    const [provider, model] = call.split('/')
    if (!provider || !model) throw new Error(`--call 格式应为 provider/model，收到 ${call}`)
    const text = String(args.text ?? '用一句话自我介绍。')
    const chunks: string[] = []
    for await (const delta of this.host.llm.stream({
      provider,
      model,
      user: text,
      ...(args.maxTokens !== undefined ? { maxTokens: Number(args.maxTokens) } : {}),
    })) {
      if (delta.text) chunks.push(delta.text)
      else if (delta.reasoning) chunks.push(`[思考] ${delta.reasoning}`)
    }
    return { provider, model, content: chunks.join('') }
  }

  async startProject(projectId: string): Promise<unknown> {
    const project = await this.projects.start(projectId)
    const controller = new AbortController()
    this.running.set(projectId, controller)
    void this.scheduler.run(projectId, controller.signal).catch(() => {})
    return project
  }

  async pauseProject(projectId: string): Promise<unknown> {
    const result = await this.projects.pause(projectId)
    this.running.get(projectId)?.abort()
    this.running.delete(projectId)
    return result
  }

  /**
   * 逐阶段启动（聊天式默认）：每完成一个阶段（规划/章纲/正文）调用 ask 询问下一步，
   * 「继续」进入下一阶段，「停止」暂停项目（释放锁，可稍后手动续跑）；全书完成即止。
   * ask 不可用（无提问 provider / 非 live agent）时降级为不阻塞、连续跑完剩余阶段。
   */
  async startStepped(projectId: string, ask: PhaseAskFn): Promise<unknown> {
    const status = (await this.projects.loadProject(projectId)).status
    if (status === 'pending' || status === 'paused') await this.projects.start(projectId)
    const controller = new AbortController()
    this.running.set(projectId, controller)
    const summaries: string[] = []
    let result: PhaseResult | undefined
    let stopped = false
    try {
      do {
        result = await this.scheduler.runPhase(projectId, controller.signal)
        const label = PHASE_LABELS[result.phase]
        const summary = phaseSummaryText(result)
        summaries.push(`【${label}】${summary}`)
        if (result.phase === 'done') break
        let decision: PhaseAskDecision = 'continue'
        try {
          decision = await ask({ label, summary })
        } catch {
          /* 无提问通道：不阻塞，继续下一阶段 */
        }
        if (decision === 'stop') {
          stopped = true
          controller.abort()
          await this.projects.pause(projectId)
          await this.projects.releaseLock(projectId)
          break
        }
      } while (true)
    } finally {
      this.running.delete(projectId)
    }
    return { projectId, phase: result?.phase ?? 'done', stopped, summaries: summaries.join('\n\n') }
  }

  /**
   * 单阶段命令（novel-plan/outline/write）：确保项目已启动（锁），执行指定阶段，
   * 完成后回到暂停态（等待聊天决定下一步）；全书完成则保持 completed。
   * --model/--temperature/--maxTokens 覆盖对应角色绑定后执行。
   */
  async runOnePhase(
    projectId: string,
    phase: PhaseName,
    options: { chapters?: number[]; model?: string; temperature?: number; maxTokens?: number } = {},
  ): Promise<unknown> {
    if (phase !== 'planning') await this.requirePlanning(projectId)
    if (options.model !== undefined || options.temperature !== undefined || options.maxTokens !== undefined) {
      await this.applyRoleOverrides(projectId, phase, options)
    }
    const status = (await this.projects.loadProject(projectId)).status
    const startedByMe = status === 'pending' || status === 'paused'
    if (startedByMe) await this.projects.start(projectId)
    const controller = new AbortController()
    this.running.set(projectId, controller)
    try {
      const result = await this.scheduler.runPhase(projectId, controller.signal, { phase, chapters: options.chapters })
      if (startedByMe && result.phase !== 'done') {
        await this.projects.pause(projectId)
        await this.projects.releaseLock(projectId)
      }
      return result
    } finally {
      this.running.delete(projectId)
    }
  }

  private async requirePlanning(projectId: string): Promise<void> {
    const paths = await this.pathsOf(projectId)
    if (!(await fileExists(paths.worldJson))) {
      throw new Error('尚未完成规划：请先执行 novel-plan 完成世界观/人物/地点，再进入章纲或正文阶段')
    }
  }

  private async applyRoleOverrides(
    projectId: string,
    phase: PhaseName,
    overrides: { model?: string; temperature?: number; maxTokens?: number },
  ): Promise<void> {
    const role = PHASE_ROLES[phase]
    const config = await this.projects.loadProject(projectId)
    const bindings = config.bindings.map((b) =>
      b.role !== role
        ? b
        : {
            ...b,
            primary: overrides.model !== undefined ? { ...b.primary, model: overrides.model } : b.primary,
            temperature: overrides.temperature ?? b.temperature,
            maxOutputTokens: overrides.maxTokens ?? b.maxOutputTokens,
          },
    )
    await this.projects.updateBindings(projectId, bindings)
  }

  async status(projectId: string) {
    const project = await this.projects.loadProject(projectId)
    const paths = await this.pathsOf(projectId)
    return queryProgress(paths, project.totalChapters, project.status)
  }

  async report(projectId: string) {
    const project = await this.projects.loadProject(projectId)
    const paths = await this.pathsOf(projectId)
    const report = await buildSummaryReport(paths, project.name, project.totalChapters, project.createdAt)
    const { atomicWriteJson } = await import('./storage/atomic.js')
    await atomicWriteJson(paths.reports.summaryReport, report)
    return report
  }

  async export(projectId: string, options: { allowGaps?: boolean }) {
    const project = await this.projects.loadProject(projectId)
    const paths = await this.pathsOf(projectId)
    const compiled = await compile(paths, options)
    if (!compiled.ok) return compiled
    const bundle = await exportPackage(paths, project.name, project.createdAt)
    return { compiled, bundle }
  }

  private async regenerateChapter(projectId: string, request: { chapter: number; stage: GuidanceStage; note: GuidanceNote | null }): Promise<boolean> {
    const paths = await this.pathsOf(projectId)
    const file = chapterFile(request.chapter)
    const project = await this.projects.loadProject(projectId)
    // completed 为终态：局部重生成不做状态迁移，保持 completed（spec 六态语义）
    const wasCompleted = project.status === 'completed'

    const backupFinal = async (): Promise<void> => {
      const finalPath = join(paths.chapters.final, `${file}.txt`)
      if (await fileExists(finalPath)) {
        await copyFile(finalPath, join(paths.chapters.final, `${file}.regen-backup.txt`))
        await rm(finalPath)
      }
    }

    if (request.stage === 'content') {
      await backupFinal()
      await rm(join(paths.chapters.review, `${file}_review.json`), { force: true })
      await rm(join(paths.chapters.draft, `${file}.txt`), { force: true })
    } else {
      await backupFinal()
      for (const dir of [paths.chapters.review, paths.chapters.draft, paths.chapters.outlineReview, paths.chapters.outline]) {
        const suffix = dir === paths.chapters.outline || dir === paths.chapters.outlineReview ? (dir === paths.chapters.outline ? '.json' : '_review.json') : dir === paths.chapters.review ? '_review.json' : '.txt'
        await rm(join(dir, `${file}${suffix}`), { force: true })
      }
    }

    if (!wasCompleted) await this.projects.resume(projectId)
    const controller = new AbortController()
    this.running.set(projectId, controller)
    const summary = await this.scheduler.run(projectId, controller.signal).catch(() => null)
    if (!summary) return false
    const success = summary.finalCount >= 0 && (await fileExists(join(paths.chapters.final, `${file}.txt`)))
    if (!success) {
      const backup = join(paths.chapters.final, `${file}.regen-backup.txt`)
      if (await fileExists(backup)) {
        await copyFile(backup, join(paths.chapters.final, `${file}.txt`))
      }
    } else {
      await rm(join(paths.chapters.final, `${file}.regen-backup.txt`), { force: true })
    }
    if (!wasCompleted) await this.projects.pause(projectId)
    return success
  }
}