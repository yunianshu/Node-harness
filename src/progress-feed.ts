import type { NovelHarnessApp } from './app.js'

/**
 * 会话进度供给：把流水线里程碑以 novel/progress 会话事件（快照语义，
 * 同 todo/write 的 latest-write-wins）追加到发起命令的 agent 会话，
 * dsh web 对话内由客户端进度卡片（client/）实时渲染。
 * 事件为 log-only：不进模型历史、不产生 token。
 */

/** 一帧项目进度快照（novel/progress 会话事件载荷）。 */
export interface NovelProgressEventData {
  projectId: string
  name: string
  status: string
  totalChapters: number
  outlineDone: number
  draftDone: number
  finalDone: number
  isolated: number[]
  /** 活跃章节及当前环节（未完成未隔离，按章号升序，最多 8 条）。 */
  activeChapters?: Array<{ chapter: number; stage: string }>
  /** 最近过程事件（新→旧，最多 8 条）：呈现"章纲→审查→写作→审查→终稿"的步骤流转。 */
  recent?: Array<{ time: string; note: string }>
  /** 本帧触发的里程碑说明（如「第 3 章终稿完成」）。 */
  note?: string
  updatedAt: string
}

/** 会话追加所需的最小面（Agent.session 的结构子集，避免依赖 dsh-agent 包）。 */
export interface SessionAppender {
  /** 只读事件快照（用于判定进度卡是否已开，避免重复 start 事件）。 */
  readonly events?: readonly { type: string; data?: unknown }[]
  append(type: 'novel/progress-start', data: { projectId: string; name: string }): unknown
  append(type: 'novel/progress', data: NovelProgressEventData): unknown
  append(type: 'novel/story-start', data: { projectId: string; chapter: number; title?: string }): unknown
  append(type: 'novel/story-reset', data: { projectId: string; chapter: number }): unknown
  append(type: 'novel/story-delta', data: { projectId: string; chapter: number; delta: string }): unknown
  append(type: 'novel/story-finish', data: { projectId: string; chapter: number; score?: number; isolated?: boolean }): unknown
}

/** 正文流式增量帧的聚合窗口（ms）：高频 delta 累积后按窗口推一帧，避免刷爆会话日志。 */
const STORY_DELTA_WINDOW_MS = 80

/** 触发会话追加的里程碑事件类型；pipeline.log 提供阶段级粒度驱动步骤流转。 */
const MILESTONE_EVENTS = new Set([
  'chapter.final',
  'chapter.isolated',
  'model.fallback',
  'pipeline.summary',
  'pipeline.completed',
  'project.status',
  'pipeline.log',
  'pipeline.stage-done',
])

/** 各会话已转发过的正文流式领域事件（按会话分组、事件对象引用去重）：
 *  同一会话先后多个 FEED 命令（如 novel.status 后 novel.resume）各自绑定监听器，
 *  会把同一条 novel.story-* 领域事件各转发一次——start 重复由 session.events 持久守卫
 *  拦截，但 delta/finish 无守卫会正文双写/冗余收束，这里统一按事件对象去重，只落一条。 */
const forwardedStoryEvents = new WeakMap<SessionAppender, WeakSet<object>>()

const STAGE_LABELS: Record<string, string> = {
  planner: '规划',
  outliner: '章纲生成',
  'outline-reviewer': '章纲审查',
  writer: '正文写作',
  reviewer: '正文审查',
  archivist: '归档',
}

function milestoneNote(event: { type: string; [key: string]: unknown }): string | undefined {
  switch (event.type) {
    case 'chapter.final':
      return `第 ${event.chapter} 章终稿完成`
    case 'chapter.isolated':
      return `第 ${event.chapter} 章隔离：${String(event.reason ?? '').slice(0, 80)}`
    case 'model.fallback':
      return `模型降级：${String(event.detail ?? event.channel ?? '')}`.slice(0, 100)
    case 'pipeline.completed':
      return '全书生成完成'
    case 'pipeline.log': {
      const stage = STAGE_LABELS[String(event.stage)] ?? String(event.stage ?? '')
      const chapter = typeof event.chapter === 'number' ? `第 ${event.chapter} 章 ` : ''
      const failed = event.result === 'failed' ? '（失败重试）' : ''
      return `${chapter}▸ ${stage}${failed}`
    }
    case 'pipeline.summary':
      return undefined
    case 'pipeline.stage-done':
      return `阶段完成：${String(event.phase ?? '') === 'planning' ? '规划' : String(event.phase) === 'outline' ? '章纲' : String(event.phase) === 'write' ? '正文' : String(event.phase)}`
    default:
      return `项目状态：${String(event.status ?? '')}`
  }
}

interface StatusLike {
  projectId?: string
  projectStatus?: string
  stages?: { outline?: { done: number; total: number }; draft?: { done: number; total: number }; final?: { done: number; total: number } }
  chapters?: Array<{ chapter: number; currentStage?: string; isolated: boolean }>
}

/** 最近过程事件保留条数（呈现步骤流转，新→旧）。 */
const RECENT_LIMIT = 8

async function snapshotOf(
  app: NovelHarnessApp,
  projectId: string,
  note?: string,
  recent?: NovelProgressEventData['recent'],
): Promise<NovelProgressEventData | null> {
  const [project, status] = await Promise.all([
    app.projects.loadProject(projectId).catch(() => null),
    app.status(projectId).catch(() => null),
  ])
  if (project === null || status === null) return null
  const s = status as StatusLike
  const activeChapters = (s.chapters ?? [])
    .filter((c) => !c.isolated && c.currentStage !== undefined && c.currentStage !== '已完成' && c.currentStage !== '已隔离')
    .slice(0, 8)
    .map((c) => ({ chapter: c.chapter, stage: c.currentStage! }))
  return {
    projectId,
    name: project.name,
    status: project.status,
    totalChapters: project.totalChapters,
    outlineDone: s.stages?.outline?.done ?? 0,
    draftDone: s.stages?.draft?.done ?? 0,
    finalDone: s.stages?.final?.done ?? 0,
    isolated: (s.chapters ?? []).filter((c) => c.isolated).map((c) => c.chapter),
    activeChapters,
    recent,
    ...(note ? { note } : {}),
    updatedAt: new Date().toISOString(),
  }
}

/**
 * dsh 会话持久层回放只认 KNOWN_SESSION_EVENT_TYPES 内的类型，out-of-tree
 * 插件事件类型的注册面上游暂缺（known-event-types.ts 注释 deferred until
 * such a consumer exists）。这里在启动期向该 Set 补注册本插件各事件类型；
 * 失败则整体降级为不追加，绝不污染会话日志。
 */
/** 宿主解析失败/命中的可观测日志各只发一次（apply 的 fire-and-forget 与 dispatchCommand 的 await 均会触发）。 */
let hostResolutionWarned = false
let hostResolvedLogged = false

/** 宿主 dsh-session 模块的最小导出面（持久层回放读取的 KNOWN_SESSION_EVENT_TYPES 集合）。 */
export interface HostSessionLike {
  KNOWN_SESSION_EVENT_TYPES?: ReadonlySet<string> & { add?(value: string): unknown }
}

/** 本插件注册的会话事件类型全集（持久层回放 assertEventsSupported 需全部识别）。 */
export const NOVEL_SESSION_EVENT_TYPES = [
  'novel/progress-start',
  'novel/progress',
  'novel/story-start',
  'novel/story-reset',
  'novel/story-delta',
  'novel/story-finish',
] as const

/** 宿主解析的可注入面：单测传入桩 resolve/load，避免依赖真实文件布局。 */
export interface HostSessionResolutionImpl {
  resolve(specifier: string): string
  load(resolvedPath: string): Promise<unknown>
}

export type HostSessionResolution =
  | { ok: true; module: HostSessionLike; resolvedPath: string }
  | { ok: false; reason: string }

/**
 * 从 dsh 入口解析宿主 dsh-session 实例：与持久层回放（coordinator）共享同一
 * KNOWN_SESSION_EVENT_TYPES 集合。插件代码位于仓库目录，Node 按物理路径解析会把
 * 动态 import('@deepseek-ai/dsh-session') 指向本地 node_modules 副本（rc.7），而底座
 * 回放检查的是其全局嵌套实例（rc.6）——两个独立 Set，本地 add 对回放永不生效
 * （表现为 novel/* 事件写入成功但历史回放报 unknown）。故经 dsh 入口（process.argv[1]）
 * 的 createRequire 解析到底座嵌套实例再 add。
 * 解析失败 / 模块缺 KNOWN_SESSION_EVENT_TYPES 导出均返回 { ok:false }（**绝不回退本地**：
 * 否则本地 rc.7 同样导出该 Set，add 成功却对回放无效，原缺陷静默重建且零日志）。
 */
export async function resolveHostSessionModule(
  entry: string,
  impl?: Partial<HostSessionResolutionImpl>,
): Promise<HostSessionResolution> {
  try {
    const { createRequire } = await import('node:module')
    const { pathToFileURL } = await import('node:url')
    const resolve = impl?.resolve ?? ((specifier: string) => createRequire(entry).resolve(specifier))
    const resolvedPath = resolve('@deepseek-ai/dsh-session')
    const load = impl?.load ?? ((p: string) => import(pathToFileURL(p).href))
    const module = (await load(resolvedPath)) as HostSessionLike
    if (module.KNOWN_SESSION_EVENT_TYPES === undefined) {
      return { ok: false, reason: `解析出的模块缺失 KNOWN_SESSION_EVENT_TYPES 导出（${resolvedPath}）` }
    }
    return { ok: true, module, resolvedPath }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 向指定 dsh-session 模块的 KNOWN_SESSION_EVENT_TYPES 补注册本插件事件类型。
 * 抽成纯函数便于单测断言 Set 实际包含的类型；session 为 null（未确认宿主）时返回 false。
 */
export function registerNovelSessionEventsInto(session: HostSessionLike | null): boolean {
  if (session === null) return false
  const known = session.KNOWN_SESSION_EVENT_TYPES
  if (known === undefined || typeof known.add !== 'function') return false
  for (const type of NOVEL_SESSION_EVENT_TYPES) known.add(type)
  return true
}

let sessionEventTypesReady = false

/** 测试钩子：重置事件类型注册闩，使「注册失败降级」路径在同一测试进程内可重测。 */
export function resetSessionEventTypesRegistration(): void {
  sessionEventTypesReady = false
}

async function loadHostSessionModule(): Promise<HostSessionLike | null> {
  if (!process.env.VITEST) {
    const entry = process.argv[1]
    if (typeof entry !== 'string' || entry.length === 0) {
      if (!hostResolutionWarned) {
        hostResolutionWarned = true
        console.warn('[novel-harness] 无 dsh 进程入口（argv[1] 缺失），无法解析宿主 dsh-session 实例；novel/* 会话事件将不追加（会话日志安全）')
      }
      return null
    }
    const resolved = await resolveHostSessionModule(entry)
    if (resolved.ok) {
      if (!hostResolvedLogged) {
        hostResolvedLogged = true
        console.log(`[novel-harness] 已解析宿主 dsh-session 实例：${resolved.resolvedPath}`)
      }
      return resolved.module
    }
    if (!hostResolutionWarned) {
      hostResolutionWarned = true
      console.warn(`[novel-harness] 解析宿主 dsh-session 实例失败（${resolved.reason}）；novel/* 会话事件将不追加（会话日志安全）`)
    }
    return null
  }
  return import('@deepseek-ai/dsh-session')
}

export async function registerNovelSessionEvents(): Promise<boolean> {
  if (sessionEventTypesReady) return true
  const ok = registerNovelSessionEventsInto(await loadHostSessionModule())
  if (ok) sessionEventTypesReady = true
  return ok
}

/**
 * 将一个会话绑定到项目的进度推送：立即追加起始帧，此后每个里程碑追加一帧快照。
 * @returns 解绑函数。
 */
export function attachProgressFeed(
  app: NovelHarnessApp,
  session: SessionAppender,
  projectId: string,
): () => void {
  /** 过程时间线（新→旧）：随每帧快照下发，客户端呈现步骤流转。 */
  let recent: Array<{ time: string; note: string }> = []
  const appendSnapshot = (data: NovelProgressEventData): void => {
    try {
      session.append('novel/progress', data)
    } catch {
      /* 会话已关闭等：进度推送不阻断 */
    }
  }
  const push = (note?: string): void => {
    if (note !== undefined) {
      recent = [{ time: new Date().toISOString().slice(11, 19), note }, ...recent].slice(0, RECENT_LIMIT)
    }
    void snapshotOf(app, projectId, note, recent).then((snapshot) => {
      if (snapshot !== null) appendSnapshot(snapshot)
    })
  }

  const bind = (): void => {
    void app.projects
      .loadProject(projectId)
      .then((project) => {
        // 同一 (会话, 项目) 只开一次卡：重复 attach（如 status 查询）仅刷新快照，
        // 否则同一 Context 收到多个 start 会被对话装配器拒绝。
        // 正确性依赖 core-session 的同步 append 语义：读 events 快照 + append 位于同一
        // 同步块（之间无 await），append 同步写日志并重置快照，并发 attach 的第二个绑定
        // 必然看到首个 append 的 start；若未来 dsh 使 append 异步化或 events 返回独立副本，
        // 重复 start 会回归并炸掉会话装配（story-start 侧另有按 key 的持久守卫兜底）。
        const alreadyStarted = (session.events ?? []).some(
          (e) =>
            e.type === 'novel/progress-start' &&
            (e.data as { projectId?: string } | undefined)?.projectId === projectId,
        )
        try {
          if (!alreadyStarted) {
            session.append('novel/progress-start', { projectId, name: project.name })
          }
        } catch {
          /* 同上 */
        }
        push()
      })
      .catch(() => {})
  }

  // ---- 正文流式转发（novel.story-* 领域事件 → novel/story-* 会话事件）----
  // delta 帧高频到达：按章累积，STORY_DELTA_WINDOW_MS 窗口推一帧（多章并发各自独立累积）；
  // start 立即开卡，finish 先冲掉剩余 delta 再收束。整段 try 包裹：会话已关闭等不阻断流水线。
  const storyDeltaBuffer = new Map<number, string>()
  let storyTimer: ReturnType<typeof setTimeout> | null = null
  const pushStory = (type: 'novel/story-start' | 'novel/story-reset' | 'novel/story-delta' | 'novel/story-finish', data: Record<string, unknown>): void => {
    try {
      session.append(type as never, data as never)
    } catch {
      /* 会话已关闭等：流式呈现不阻断 */
    }
  }
  const flushStoryDeltas = (): void => {
    storyTimer = null
    for (const [chapter, text] of storyDeltaBuffer) {
      pushStory('novel/story-delta', { projectId, chapter, delta: text })
    }
    storyDeltaBuffer.clear()
  }
  const scheduleStoryFlush = (): void => {
    if (storyTimer !== null) return
    storyTimer = setTimeout(flushStoryDeltas, STORY_DELTA_WINDOW_MS)
  }
  const handleStoryEvent = (event: { type: string; chapter?: number; [key: string]: unknown }): void => {
    if (typeof event.chapter !== 'number') return
    if (event.type === 'novel.story-start') {
      // 与 progress-start 同构的幂等守卫：同一 (会话, 项目, 章) 至多一条 story-start。
      // 重复 start 会被对话装配器按 "received more than one start Match" 拒绝整条会话
      // （pause 中途写作后 resume 重发、同会话多个 FEED 命令各自转发同一条领域事件均会命中）。
      const alreadyStarted = (session.events ?? []).some(
        (e) =>
          e.type === 'novel/story-start' &&
          (e.data as { projectId?: string; chapter?: number } | undefined)?.projectId === projectId &&
          (e.data as { projectId?: string; chapter?: number } | undefined)?.chapter === event.chapter,
      )
      if (alreadyStarted) {
        // 同 key 已开卡 = 重写（regen/重试再跑 processChapter 会重发 story-start）：
        // 不重复开卡（装配器拒绝第二个 start），改发 story-reset 让客户端清空旧卡正文，
        // 后续 delta 以新稿重新累积——否则旧文+新文在客户端拼接。
        pushStory('novel/story-reset', { projectId, chapter: event.chapter })
        return
      }
      pushStory('novel/story-start', {
        projectId,
        chapter: event.chapter,
        ...(event.title !== undefined ? { title: String(event.title) } : {}),
      })
      return
    }
    if (event.type === 'novel.story-delta') {
      const delta = typeof event.delta === 'string' ? event.delta : ''
      if (delta.length === 0) return
      storyDeltaBuffer.set(event.chapter, (storyDeltaBuffer.get(event.chapter) ?? '') + delta)
      scheduleStoryFlush()
      return
    }
    if (event.type === 'novel.story-finish') {
      if (storyDeltaBuffer.has(event.chapter)) {
        pushStory('novel/story-delta', { projectId, chapter: event.chapter, delta: storyDeltaBuffer.get(event.chapter) ?? '' })
        storyDeltaBuffer.delete(event.chapter)
      }
      pushStory('novel/story-finish', {
        projectId,
        chapter: event.chapter,
        ...(typeof event.score === 'number' ? { score: event.score } : {}),
        ...(event.isolated === true ? { isolated: true } : {}),
      })
    }
  }

  void registerNovelSessionEvents().then((ready) => {
    if (!ready) return
    bind()
  })

  return app.onPipelineEvent((event) => {
    if (!sessionEventTypesReady) return
    if ((event as { projectId?: string }).projectId !== projectId) return
    if (event.type.startsWith('novel.story-')) {
      // 同一条领域事件被同会话多个监听器各转发一次：按会话分组以事件对象引用去重，
      // 只落一条（start 另有 session.events 持久守卫防跨重启/跨 attach 重复）。
      let seen = forwardedStoryEvents.get(session)
      if (seen === undefined) {
        seen = new WeakSet<object>()
        forwardedStoryEvents.set(session, seen)
      }
      if (seen.has(event)) return
      seen.add(event)
      handleStoryEvent(event as unknown as { type: string; chapter?: number; [key: string]: unknown })
      return
    }
    if (!MILESTONE_EVENTS.has(event.type)) return
    push(milestoneNote(event))
  })
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * 小说进度卡片起始帧：在发起命令的会话上打开一张进度卡（log-only，
     * 不进模型历史）。与 novel/progress 按 projectId 配对。
     */
    'novel/progress-start': { projectId: string; name: string }
    /** 小说进度快照（latest-write-wins）：由客户端卡片折叠为实时进度视图。 */
    'novel/progress': NovelProgressEventData
    /** 正文流式卡起始帧：第 N 章正文开始逐字流出（log-only，不进模型历史）。 */
    'novel/story-start': { projectId: string; chapter: number; title?: string }
    /** 正文重写清卡帧：regen/重试重写同一章时清空既有卡正文，后续 delta 以新稿重新累积。 */
    'novel/story-reset': { projectId: string; chapter: number }
    /** 正文流式增量帧（80ms 聚合窗口）：客户端累积到对应章的卡片正文。 */
    'novel/story-delta': { projectId: string; chapter: number; delta: string }
    /** 正文流式收束帧：终稿评分（如通过审查）与隔离标记（如超限）。 */
    'novel/story-finish': { projectId: string; chapter: number; score?: number; isolated?: boolean }
  }
}
