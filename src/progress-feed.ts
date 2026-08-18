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
}

/** 触发会话追加的里程碑事件类型；pipeline.log 提供阶段级粒度驱动步骤流转。 */
const MILESTONE_EVENTS = new Set([
  'chapter.final',
  'chapter.isolated',
  'model.fallback',
  'pipeline.summary',
  'pipeline.completed',
  'project.status',
  'pipeline.log',
])

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
 * such a consumer exists）。这里在启动期向该 Set 补注册本插件两型事件；
 * 失败（如 dsh 升级后冻结或改名）则整体降级为不追加，绝不污染会话日志。
 */
let sessionEventTypesReady = false

export async function registerNovelSessionEvents(): Promise<boolean> {
  if (sessionEventTypesReady) return true
  try {
    const session = (await import('@deepseek-ai/dsh-session')) as {
      KNOWN_SESSION_EVENT_TYPES?: ReadonlySet<string> & { add?(value: string): unknown }
    }
    const known = session.KNOWN_SESSION_EVENT_TYPES
    if (known === undefined || typeof known.add !== 'function') return false
    known.add('novel/progress-start')
    known.add('novel/progress')
    sessionEventTypesReady = true
    return true
  } catch {
    return false
  }
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
        // 否则同一 Context 收到多个 start 会被对话装配器拒绝
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

  void registerNovelSessionEvents().then((ready) => {
    if (!ready) return
    bind()
  })

  return app.onPipelineEvent((event) => {
    if (!sessionEventTypesReady) return
    if ((event as { projectId?: string }).projectId !== projectId) return
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
  }
}
