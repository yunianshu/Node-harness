import type { NovelHarnessApp } from './app.js'
import { buildToc, type NovelToc } from './notify/progress.js'

/**
 * 会话进度供给：把流水线里程碑以 novel/milestone 会话事件（每条独立聊天消息，
 * 与对话流一致的逐条消息呈现）追加到发起命令的 agent 会话，dsh web 对话内由
 * 客户端里程碑卡片（client/）逐条渲染；另推目录卡 novel/toc 作为进度兜底。
 * 事件为 log-only：不进模型历史、不产生 token。
 */

/** 步骤消息种类：客户端据此选择图标与配色。 */
export type NovelMilestoneKind = 'step' | 'done' | 'completed' | 'isolated' | 'fallback' | 'error' | 'status'

/** 一条小说生成步骤消息（novel/milestone 会话事件载荷，每条独立聊天消息）。 */
export interface NovelMilestoneEventData {
  projectId: string
  /** 稳定唯一 id（= projectId + 全局事件序号），match 据此开独立卡片。 */
  id: string
  kind: NovelMilestoneKind
  /** 步骤文案（如「第 1 章 章纲生成」「第 1 章 终稿完成 · 评分 8」）。 */
  text: string
  /** 展示用时间（HH:MM:SS）。 */
  time: string
}

/** 会话追加所需的最小面（Agent.session 的结构子集，避免依赖 dsh-agent 包）。 */
export interface SessionAppender {
  /** 只读事件快照（用于判定目录卡是否已开，避免重复 start 事件）。 */
  readonly events?: readonly { type: string; data?: unknown }[]
  append(type: 'novel/milestone', data: NovelMilestoneEventData): unknown
  append(type: 'novel/story-start', data: { projectId: string; chapter: number; title?: string }): unknown
  append(type: 'novel/story-reset', data: { projectId: string; chapter: number }): unknown
  append(type: 'novel/story-delta', data: { projectId: string; chapter: number; delta: string }): unknown
  append(type: 'novel/story-finish', data: { projectId: string; chapter: number; score?: number; isolated?: boolean }): unknown
  append(type: 'novel/toc-start', data: { projectId: string; name: string }): unknown
  append(type: 'novel/toc', data: NovelToc): unknown
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
  'pipeline.error',
  'pipeline.stage-done',
])

/** 各会话已转发过的流水线领域事件（按会话分组、事件对象引用去重）：
 *  同一会话先后多个 FEED 命令（如 novel.status 后 novel.resume）各自绑定监听器，
 *  会把同一条 novel.story-* 或 milestone 领域事件各转发一次——story-start 重复由
 *  session.events 持久守卫兜底，milestone 每条 seq 唯一也需防同对象二次转发
 *  （同 id 二次 start 会炸会话装配），这里统一按事件对象去重，只落一条。 */
const forwardedEvents = new WeakMap<SessionAppender, WeakSet<object>>()

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
    case 'chapter.final': {
      const score = typeof event.score === 'number' ? ` · 评分 ${event.score}` : ''
      return `第 ${event.chapter} 章 终稿完成${score}`
    }
    case 'chapter.isolated':
      return `第 ${event.chapter} 章 隔离：${String(event.reason ?? '').slice(0, 80)}`
    case 'model.fallback':
      return `模型降级：${String(event.detail ?? event.channel ?? '')}`.slice(0, 100)
    case 'pipeline.completed':
      return '全书生成完成'
    case 'pipeline.log': {
      const stage = STAGE_LABELS[String(event.stage)] ?? String(event.stage ?? '')
      const chapter = typeof event.chapter === 'number' ? `第 ${event.chapter} 章 ` : ''
      if (event.result !== 'failed') return `${chapter}${stage}`
      // 补全类失败透出具体原因（如「（失败重试：人物关系未闭合）」），与 isolated 分支同取 80 字符上限
      const detail = typeof event.detail === 'string' ? event.detail.slice(0, 80) : ''
      return `${chapter}${stage}（失败重试${detail ? `：${detail}` : ''}）`
    }
    case 'pipeline.error':
      return `失败：${String(event.message ?? '').slice(0, 80)}`
    case 'project.status': {
      // startProject 失败兜底 emit：message 存在时呈现失败原因，否则回退状态文本
      const status = String(event.to ?? event.status ?? '')
      return event.message ? `失败：${String(event.message).slice(0, 80)}` : `项目状态：${status}`
    }
    case 'pipeline.summary':
      // run() 结束时的汇总事件：非中止即全书完成（aborted 由 signal.aborted 驱动）
      return event.aborted === true ? '全书生成中止' : '全书生成完成'
    case 'pipeline.stage-done':
      return `阶段完成：${String(event.phase ?? '') === 'planning' ? '规划' : String(event.phase) === 'outline' ? '章纲' : String(event.phase) === 'write' ? '正文' : String(event.phase)}`
    default:
      return `项目状态：${String(event.status ?? '')}`
  }
}

/** 步骤消息种类：客户端据此选择图标与配色（纯展示，不参与文案）。 */
function milestoneKind(event: { type: string; message?: unknown; aborted?: unknown }): NovelMilestoneKind {
  switch (event.type) {
    case 'chapter.final':
      return 'done'
    case 'pipeline.completed':
      return 'completed'
    case 'pipeline.summary':
      return event.aborted === true ? 'status' : 'completed'
    case 'chapter.isolated':
      return 'isolated'
    case 'model.fallback':
      return 'fallback'
    case 'pipeline.error':
      return 'error'
    case 'project.status':
      return event.message !== undefined ? 'error' : 'status'
    default:
      return 'step'
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
  'novel/milestone',
  'novel/story-start',
  'novel/story-reset',
  'novel/story-delta',
  'novel/story-finish',
  'novel/toc-start',
  'novel/toc',
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
  const appendMilestone = (data: NovelMilestoneEventData): void => {
    try {
      session.append('novel/milestone', data)
    } catch {
      /* 会话已关闭等：里程碑推送不阻断 */
    }
  }
  const appendToc = (data: NovelToc): void => {
    try {
      session.append('novel/toc', data)
    } catch {
      /* 会话已关闭等：目录推送不阻断 */
    }
  }
  // 目录卡从落盘产物实时重建（产物即真相）：loadProject + status（内含 queryProgress）+
  // pathsOf 一次到位，buildToc 复用其 ProgressView，避免 queryProgress 全量跑两遍。
  const pushToc = (): void => {
    void (async () => {
      const [project, status, paths] = await Promise.all([
        app.projects.loadProject(projectId).catch(() => null),
        app.status(projectId).catch(() => null),
        app.pathsOf(projectId).catch(() => null),
      ])
      if (project === null || status === null || paths === null) return
      const toc = await buildToc(paths, project, status).catch(() => null)
      if (toc !== null) appendToc(toc)
    })()
  }

  const bind = (): void => {
    void app.projects
      .loadProject(projectId)
      .then((project) => {
        // 目录卡开卡守卫：同一 (会话, 项目) 只开一次卡，重复 attach（如 status 查询）
        // 仅刷新目录快照，否则同一 Context 收到多个 start 会被对话装配器拒绝。
        const alreadyTocStarted = (session.events ?? []).some(
          (e) =>
            e.type === 'novel/toc-start' &&
            (e.data as { projectId?: string } | undefined)?.projectId === projectId,
        )
        try {
          if (!alreadyTocStarted) {
            session.append('novel/toc-start', { projectId, name: project.name })
          }
        } catch {
          /* 会话已关闭等：不阻断 */
        }
        pushToc()
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
    // 同一条领域事件被同会话多个监听器各转发一次：按会话分组以事件对象引用去重，
    // 只落一条（story-start 另有 session.events 持久守卫防跨重启/跨 attach 重复）。
    let seen = forwardedEvents.get(session)
    if (seen === undefined) {
      seen = new WeakSet<object>()
      forwardedEvents.set(session, seen)
    }
    if (seen.has(event)) return
    seen.add(event)
    if (event.type.startsWith('novel.story-')) {
      handleStoryEvent(event as unknown as { type: string; chapter?: number; [key: string]: unknown })
      return
    }
    if (!MILESTONE_EVENTS.has(event.type)) return
    const note = milestoneNote(event)
    if (note === undefined) return
    const seq = (event as { seq?: unknown }).seq
    if (typeof seq !== 'number') return
    appendMilestone({
      projectId,
      id: `${projectId}-${seq}`,
      kind: milestoneKind(event as { type: string; message?: unknown }),
      text: note,
      time: new Date().toISOString().slice(11, 19),
    })
    // 目录卡作为进度兜底随里程碑同步刷新（产物即真相，latest-write-wins）
    pushToc()
  })
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * 小说步骤消息：每条独立聊天消息（log-only，不进模型历史），
     * 由客户端里程碑卡片逐条渲染为对话流中的一步。
     */
    'novel/milestone': NovelMilestoneEventData
    /** 正文流式卡起始帧：第 N 章正文开始逐字流出（log-only，不进模型历史）。 */
    'novel/story-start': { projectId: string; chapter: number; title?: string }
    /** 正文重写清卡帧：regen/重试重写同一章时清空既有卡正文，后续 delta 以新稿重新累积。 */
    'novel/story-reset': { projectId: string; chapter: number }
    /** 正文流式增量帧（80ms 聚合窗口）：客户端累积到对应章的卡片正文。 */
    'novel/story-delta': { projectId: string; chapter: number; delta: string }
    /** 正文流式收束帧：终稿评分（如通过审查）与隔离标记（如超限）。 */
    'novel/story-finish': { projectId: string; chapter: number; score?: number; isolated?: boolean }
    /** 小说目录卡起始帧：在发起命令的会话上打开一张目录卡（log-only，不进模型历史）。 */
    'novel/toc-start': { projectId: string; name: string }
    /** 小说目录快照（latest-write-wins）：目录数据从落盘产物实时重建（产物即真相）。 */
    'novel/toc': NovelToc
  }
}
