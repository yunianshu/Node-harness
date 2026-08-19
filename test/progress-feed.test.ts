import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 模拟 dsh 会话事件类型注册面（真实包的运行时依赖树过重，不引入单测）
vi.mock('@deepseek-ai/dsh-session', () => ({
  KNOWN_SESSION_EVENT_TYPES: new Set(['turn/start', 'turn/end']),
}))

import { NovelHarnessApp } from '../src/app'
import { FakeHost } from '../src/host/dsh-adapter'
import {
  attachProgressFeed,
  NOVEL_SESSION_EVENT_TYPES,
  registerNovelSessionEvents,
  registerNovelSessionEventsInto,
  resetSessionEventTypesRegistration,
  resolveHostSessionModule,
} from '../src/progress-feed'
import type { NovelProgressEventData, SessionAppender } from '../src/progress-feed'
import type { NovelToc } from '../src/notify/progress'
import type { ModelGateway, LlmRequest, InvokeContext } from '../src/model/gateway'
import type { PipelineRole } from '../src/project/schema'
import { diverseParagraphText, resetCounter } from './helpers/text'

class RecordingSession implements SessionAppender {
  readonly events: { type: string; data?: unknown }[] = []

  append(type: 'novel/progress-start', data: { projectId: string; name: string }): unknown
  append(type: 'novel/progress', data: NovelProgressEventData): unknown
  append(type: 'novel/story-start', data: { projectId: string; chapter: number; title?: string }): unknown
  append(type: 'novel/story-reset', data: { projectId: string; chapter: number }): unknown
  append(type: 'novel/story-delta', data: { projectId: string; chapter: number; delta: string }): unknown
  append(type: 'novel/story-finish', data: { projectId: string; chapter: number; score?: number; isolated?: boolean }): unknown
  append(type: 'novel/toc-start', data: { projectId: string; name: string }): unknown
  append(type: 'novel/toc', data: NovelToc): unknown
  append(type: string, data: unknown): unknown {
    this.events.push({ type, data })
    return undefined
  }
}

const PLANNING = JSON.stringify({
  world: { worldview: '民国武林', themes: ['孤独'] },
  characters: [
    { name: '沈孤鸿', tier: '主角', surfaceIdentity: '刀客', trueCore: '旧案幸存者', coreDesire: '查明真相', relations: [{ target: '白老板', relation: '故人' }], narrativeFunction: '推进主线' },
    { name: '白老板', tier: '重要配角', surfaceIdentity: '酒馆老板', trueCore: '线人', coreDesire: '护住女儿', relations: [{ target: '沈孤鸿', relation: '故人' }], narrativeFunction: '提供情报' },
  ],
  locations: [{ name: '长街', spatialFeatures: '青石板', moodTone: '冷冽', relatedCharacters: [], narrativeFunction: '' }],
})

function makeGateway(): ModelGateway {
  return {
    setBindings: () => {},
    channelStatus: () => [],
    async invoke(role: PipelineRole, _req: LlmRequest, ctx: InvokeContext) {
      if (role === 'planner') return { content: PLANNING, finishReason: 'stop', usage: null, raw: {} }
      if (role === 'outliner') {
        const ch = ctx.chapter ?? 1
        return {
          content: JSON.stringify({
            chapter: ch, title: `第${ch}章`, summary: '摘要', keyEvents: ['事件'],
            scenes: [{ seq: 1, locationRef: '长街', timeAdvance: '当日', purpose: '寻人' }],
            crossChapterHandoff: '衔接', foreshadowPlan: [],
          }),
          finishReason: 'stop', usage: null, raw: {},
        }
      }
      if (role === 'outline-reviewer') return { content: JSON.stringify({ score: 9, issues: [], styleDeviation: 'none' }), finishReason: 'stop', usage: null, raw: {} }
      if (role === 'writer') {
        // 追加超长句段与单行段，确保句长/段长 CV 稳居硬阈值之上（避开节奏两级检查的 severe 档）
        const longTail = '这一夜的风把整条长街吹得干干净净，雪粒子打在酒旗上啪啪作响，他数着更声一路走到城门口的时候，天边已经泛起一线灰白，城门还没有开，守门的老兵抱着枪在打盹。'.repeat(2)
        return { content: diverseParagraphText(18, 2200) + '\n' + longTail + '\n他等着。', finishReason: 'stop', usage: null, raw: {} }
      }
      return { content: JSON.stringify({ score: 8, issues: [], styleDeviation: 'none' }), finishReason: 'stop', usage: null, raw: {} }
    },
    // Task #10 后 writer 走流式面：分片回调增量（模拟真实 dsh 逐字流，验证 delta 聚合窗口合并）；
    // 非 writer 角色聚合后一次性回调全文
    async invokeStream(role, request, ctx, onDelta) {
      const res = await this.invoke(role, request, ctx)
      if (role === 'writer' && onDelta && typeof res.content === 'string') {
        for (let i = 0; i < res.content.length; i += 120) {
          onDelta(res.content.slice(i, i + 120))
        }
      } else {
        onDelta?.(res.content)
      }
      return res
    },
  }
}

describe('NovelProgressFeed（会话进度供给）', () => {
  let root: string
  let app: NovelHarnessApp

  beforeEach(async () => {
    resetCounter()
    // 重置事件类型注册闩：保证每个用例都重新走注册路径（否则首个用例置位后其余用例不再注册）
    resetSessionEventTypesRegistration()
    root = await mkdtemp(join(tmpdir(), 'progress-feed-'))
    app = new NovelHarnessApp({ dataRoot: root, host: new FakeHost(root), gateway: makeGateway() })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('registers session event types before use', async () => {
    await expect(registerNovelSessionEvents()).resolves.toBe(true)
    // 只断言返回 true 无法覆盖"写入的正是回放读取的宿主 Set"：直接读被 mock 的模块，
    // 校验全部 novel 事件类型（含 story-reset）已实际落入 KNOWN_SESSION_EVENT_TYPES
    // （真实模块类型为 ReadonlySet，故经 unknown 桥接）
    const mod = (await import('@deepseek-ai/dsh-session')) as unknown as {
      KNOWN_SESSION_EVENT_TYPES?: Set<string>
    }
    const known = mod.KNOWN_SESSION_EVENT_TYPES
    expect(known).toBeDefined()
    for (const t of NOVEL_SESSION_EVENT_TYPES) expect(known!.has(t)).toBe(true)
  })

  it('pushes milestone snapshots to a bound session and survives re-attach without duplicate start', { timeout: 60_000 }, async () => {
    await registerNovelSessionEvents()
    const created = await app.projects.create(
      { name: '进度测试', premise: '一个关于刀客与旧案的故事，雪夜长街，故人重逢，真相渐近', totalChapters: 3, stylePackId: 'gulong' },
      'test',
    )
    const session = new RecordingSession()
    const detach = attachProgressFeed(app, session, created.project.projectId)

    await app.startProject(created.project.projectId)
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const proj = await app.projects.loadProject(created.project.projectId)
      const snapshots = session.events.filter((e) => e.type === 'novel/progress') as { data?: NovelProgressEventData }[]
      const lastStatus = snapshots[snapshots.length - 1]?.data?.status
      // 项目 completed 且快照也落地 completed 才退出：snapshot 是异步 append（fire-and-forget），
      // 只等项目状态会读到旧帧（generating）造成竞态 flaky
      if (proj.status === 'completed' && lastStatus === 'completed') break
      await new Promise((r) => setTimeout(r, 100))
    }

    const starts = session.events.filter((e) => e.type === 'novel/progress-start')
    expect(starts).toHaveLength(1)
    expect((starts[0].data as { projectId: string }).projectId).toBe(created.project.projectId)

    const snapshots = session.events.filter((e) => e.type === 'novel/progress') as { data?: NovelProgressEventData }[]
    expect(snapshots.length).toBeGreaterThanOrEqual(1)
    const last = snapshots[snapshots.length - 1].data!
    expect(last.status).toBe('completed')
    expect(last.finalDone).toBe(3)
    expect(last.totalChapters).toBe(3)
    // 过程视图字段：步骤时间线随过程推进累积，终态无活跃章
    expect(last.recent !== undefined && last.recent.length > 0).toBe(true)
    expect(last.recent!.some((r) => r.note.includes('▸'))).toBe(true)
    expect(last.activeChapters).toEqual([])

    // 重复 attach（如 status 查询重绑）：不再追加第二个 start，仅刷新快照
    const before = session.events.length
    const detach2 = attachProgressFeed(app, session, created.project.projectId)
    await new Promise((r) => setTimeout(r, 300))
    expect(session.events.filter((e) => e.type === 'novel/progress-start')).toHaveLength(1)
    expect(session.events.length).toBeGreaterThan(before)
    detach()
    detach2()
  })

  it('forwards chapter writing as streamed story cards (start → aggregated deltas → finish with score)', { timeout: 60_000 }, async () => {
    await registerNovelSessionEvents()
    const created = await app.projects.create(
      { name: '流式测试', premise: '一个关于刀客与旧案的故事，雪夜长街，故人重逢，真相渐近', totalChapters: 2, stylePackId: 'gulong' },
      'test',
    )
    const session = new RecordingSession()
    const detach = attachProgressFeed(app, session, created.project.projectId)

    await app.startProject(created.project.projectId)
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const proj = await app.projects.loadProject(created.project.projectId)
      const finishCount = session.events.filter((e) => e.type === 'novel/story-finish').length
      if (proj.status === 'completed' && finishCount >= 2) break
      await new Promise((r) => setTimeout(r, 100))
    }

    const starts = session.events.filter((e) => e.type === 'novel/story-start') as { data?: { projectId: string; chapter: number } }[]
    const deltas = session.events.filter((e) => e.type === 'novel/story-delta') as { data?: { projectId: string; chapter: number; delta: string } }[]
    const finishes = session.events.filter((e) => e.type === 'novel/story-finish') as { data?: { projectId: string; chapter: number; score?: number; isolated?: boolean } }[]

    expect(starts).toHaveLength(2)
    expect(starts.map((s) => s.data!.chapter).sort()).toEqual([1, 2])
    expect(finishes).toHaveLength(2)

    // 分片增量（每片 120 字符）被聚合窗口合并为少量会话帧；拼接后即为该章全文
    for (const ch of [1, 2]) {
      const texts = deltas.filter((d) => d.data!.chapter === ch).map((d) => d.data!.delta)
      expect(texts.length).toBeGreaterThan(0)
      const joined = texts.join('')
      expect(joined.length).toBeGreaterThan(1000)
      expect(joined).toContain('这一夜的风')
      const finish = finishes.find((f) => f.data!.chapter === ch)
      expect(typeof finish!.data!.score).toBe('number')
      expect(finish!.data!.isolated).toBeUndefined()
    }
    detach()
  })

  it('pushes toc snapshots to a bound session (toc-start once, toc refreshes)', { timeout: 60_000 }, async () => {
    await registerNovelSessionEvents()
    const created = await app.projects.create(
      { name: '目录测试', premise: '一个关于刀客与旧案的故事，雪夜长街，故人重逢，真相渐近', totalChapters: 2, stylePackId: 'gulong' },
      'test',
    )
    const session = new RecordingSession()
    const detach = attachProgressFeed(app, session, created.project.projectId)

    await app.startProject(created.project.projectId)
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const proj = await app.projects.loadProject(created.project.projectId)
      const tocs = session.events.filter((e) => e.type === 'novel/toc') as { data?: NovelToc }[]
      const lastStatus = tocs[tocs.length - 1]?.data?.status
      if (proj.status === 'completed' && lastStatus === 'completed') break
      await new Promise((r) => setTimeout(r, 100))
    }

    const starts = session.events.filter((e) => e.type === 'novel/toc-start')
    expect(starts).toHaveLength(1)
    expect((starts[0].data as { projectId: string }).projectId).toBe(created.project.projectId)

    const snapshots = session.events.filter((e) => e.type === 'novel/toc') as { data?: NovelToc }[]
    expect(snapshots.length).toBeGreaterThanOrEqual(1)
    const last = snapshots[snapshots.length - 1].data!
    expect(last.status).toBe('completed')
    expect(last.totalChapters).toBe(2)
    expect(last.name).toBe('目录测试')
    // 目录条目随产物重建：两章齐全、终稿章 stage=已完成、章纲标题非空
    expect(last.entries).toHaveLength(2)
    expect(last.entries.every((e) => typeof e.title === 'string' && e.title.length > 0)).toBe(true)
    expect(last.entries.filter((e) => e.stage === '已完成')).toHaveLength(2)
    expect(last.finalDone).toBe(2)
    expect(last.isolated).toEqual([])

    // 重复 attach：不重复开卡，仅刷新 toc 快照
    const before = session.events.length
    const detach2 = attachProgressFeed(app, session, created.project.projectId)
    await new Promise((r) => setTimeout(r, 300))
    expect(session.events.filter((e) => e.type === 'novel/toc-start')).toHaveLength(1)
    expect(session.events.length).toBeGreaterThan(before)
    detach()
    detach2()
  })

  it('never appends a second story-start for the same (project, chapter) across re-attach', async () => {
    await registerNovelSessionEvents()
    const created = await app.projects.create(
      { name: '幂等测试', premise: '一个关于刀客与旧案的故事，雪夜长街，故人重逢，真相渐近', totalChapters: 1, stylePackId: 'gulong' },
      'test',
    )
    const projectId = created.project.projectId
    const session = new RecordingSession()

    // 模拟同会话先后两个 FEED 命令（如 novel.status 后 novel.resume）：各自绑定监听器，
    // 同一条 novel.story-start 领域事件会被两个监听器各转发一次——必须只落地一条 start，
    // 否则对话装配器按 "more than one start Match" 拒绝整条会话（对话流消失）。
    const detach1 = attachProgressFeed(app, session, projectId)
    const detach2 = attachProgressFeed(app, session, projectId)
    const emit = (event: unknown): void =>
      (app as unknown as { emitPipelineEvent(e: unknown): void }).emitPipelineEvent(event)

    emit({ type: 'novel.story-start', projectId, chapter: 1, title: '第1章' })
    emit({ type: 'novel.story-start', projectId, chapter: 1, title: '第1章' })
    emit({ type: 'novel.story-delta', projectId, chapter: 1, delta: '雪夜追加。' })
    emit({ type: 'novel.story-finish', projectId, chapter: 1, score: 8 })
    await new Promise((r) => setTimeout(r, 200))

    const starts = session.events.filter((e) => e.type === 'novel/story-start')
    expect(starts).toHaveLength(1)
    expect((starts[0].data as { projectId: string; chapter: number }).projectId).toBe(projectId)

    // 重复 start 被跳过；同一条 delta/finish 领域事件也只落一条（事件对象去重），
    // 文本不双写，客户端正文无重复
    const deltas = session.events
      .filter((e) => e.type === 'novel/story-delta')
      .map((e) => (e.data as { delta: string }).delta)
    expect(deltas).toHaveLength(1)
    expect(deltas[0]).toBe('雪夜追加。')
    const finishes = session.events.filter((e) => e.type === 'novel/story-finish')
    expect(finishes).toHaveLength(1)
    expect((finishes[0].data as { score?: number }).score).toBe(8)

    // 另一章（不同 key）仍能正常开卡
    emit({ type: 'novel.story-start', projectId, chapter: 2, title: '第2章' })
    await new Promise((r) => setTimeout(r, 50))
    expect(session.events.filter((e) => e.type === 'novel/story-start')).toHaveLength(2)
    detach1()
    detach2()
  })
})

describe('宿主 dsh-session 实例解析（根因修复的自动化覆盖）', () => {
  let root: string
  let app: NovelHarnessApp

  beforeEach(async () => {
    resetCounter()
    resetSessionEventTypesRegistration()
    root = await mkdtemp(join(tmpdir(), 'host-session-test-'))
    app = new NovelHarnessApp({ dataRoot: root, host: new FakeHost(root), gateway: makeGateway() })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('registerNovelSessionEventsInto 向给定 Set 写入全部 novel 事件类型', () => {
    const known = new Set(['turn/start'])
    expect(registerNovelSessionEventsInto({ KNOWN_SESSION_EVENT_TYPES: known })).toBe(true)
    for (const t of NOVEL_SESSION_EVENT_TYPES) expect(known.has(t)).toBe(true)
  })

  it('registerNovelSessionEventsInto 对 null / 缺 add 的模块返回 false', () => {
    expect(registerNovelSessionEventsInto(null)).toBe(false)
    // 冻结 Set 无法 add（真实宿主若暴露的是只读集合，补注册应失败降级而非抛错）
    expect(registerNovelSessionEventsInto({ KNOWN_SESSION_EVENT_TYPES: new Set(['x']) })).toBe(true)
    expect(registerNovelSessionEventsInto({ KNOWN_SESSION_EVENT_TYPES: {} as never })).toBe(false)
  })

  it('resolveHostSessionModule 注入桩：命中可写 Set 且 registerInto 写入同一实例', async () => {
    const known = new Set(['turn/start'])
    const host = await resolveHostSessionModule('C:/fixture/entry.js', {
      resolve: () => 'C:/fixture/node_modules/@deepseek-ai/dsh-session/lib/index.js',
      load: async () => ({ KNOWN_SESSION_EVENT_TYPES: known }),
    })
    expect(host.ok).toBe(true)
    if (!host.ok) return
    expect(host.resolvedPath).toBe('C:/fixture/node_modules/@deepseek-ai/dsh-session/lib/index.js')
    expect(host.module.KNOWN_SESSION_EVENT_TYPES).toBe(known)
    expect(registerNovelSessionEventsInto(host.module)).toBe(true)
    expect(known.has('novel/story-reset')).toBe(true)
  })

  it('resolveHostSessionModule 解析抛错 / 模块缺导出均返回 ok:false', async () => {
    const resolveErr = await resolveHostSessionModule('C:/entry.js', {
      resolve: () => {
        throw new Error('MODULE_NOT_FOUND')
      },
    })
    expect(resolveErr.ok).toBe(false)

    const missingExport = await resolveHostSessionModule('C:/entry.js', {
      resolve: () => 'C:/x.js',
      load: async () => ({}),
    })
    expect(missingExport.ok).toBe(false)
  })

  it('resolveHostSessionModule 真实 createRequire：解析到 fixture 副本且重 import 为同一 Set 实例', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'host-session-fixture-'))
    try {
      const pkgDir = join(dir, 'node_modules', '@deepseek-ai', 'dsh-session')
      const libDir = join(pkgDir, 'lib')
      await mkdir(libDir, { recursive: true })
      await writeFile(
        join(pkgDir, 'package.json'),
        JSON.stringify({ name: '@deepseek-ai/dsh-session', version: '0.0.0-fixture', type: 'module', main: 'lib/index.mjs' }),
      )
      await writeFile(join(libDir, 'index.mjs'), 'export const KNOWN_SESSION_EVENT_TYPES = new Set(["turn/start"])\n')
      const entry = join(dir, 'entry.mjs')
      await writeFile(entry, '// 模拟 dsh 进程入口（process.argv[1] 指向该文件）\n')

      const host = await resolveHostSessionModule(entry)
      expect(host.ok).toBe(true)
      if (!host.ok) return
      // win32 下解析路径为反斜杠分隔，统一成正斜杠再断言
      expect(host.resolvedPath.replace(/\\/g, '/')).toMatch(/\/node_modules\/@deepseek-ai\/dsh-session\/lib\/index\.mjs$/)

      // 身份校验：以同一 file URL 重新 import，Node 按 realpath 缓存应返回同一模块实例（同一 Set）
      const { pathToFileURL } = await import('node:url')
      const again = (await import(pathToFileURL(host.resolvedPath).href)) as {
        KNOWN_SESSION_EVENT_TYPES?: Set<string>
      }
      expect(again.KNOWN_SESSION_EVENT_TYPES).toBe(host.module.KNOWN_SESSION_EVENT_TYPES)
      expect(registerNovelSessionEventsInto(host.module)).toBe(true)
      expect(again.KNOWN_SESSION_EVENT_TYPES!.has('novel/progress-start')).toBe(true)
      expect(again.KNOWN_SESSION_EVENT_TYPES!.has('novel/story-reset')).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('注册失败（宿主缺 KNOWN_SESSION_EVENT_TYPES）时 attach 不追加任何事件', async () => {
    const mod = (await import('@deepseek-ai/dsh-session')) as unknown as {
      KNOWN_SESSION_EVENT_TYPES?: Set<string>
    }
    const saved = mod.KNOWN_SESSION_EVENT_TYPES
    mod.KNOWN_SESSION_EVENT_TYPES = undefined
    try {
      await expect(registerNovelSessionEvents()).resolves.toBe(false)
      const session = new RecordingSession()
      const detach = attachProgressFeed(app, session, 'proj-x')
      const emit = (event: unknown): void =>
        (app as unknown as { emitPipelineEvent(e: unknown): void }).emitPipelineEvent(event)
      emit({ type: 'pipeline.completed', projectId: 'proj-x' })
      await new Promise((r) => setTimeout(r, 100))
      expect(session.events).toHaveLength(0)
      detach()
    } finally {
      mod.KNOWN_SESSION_EVENT_TYPES = saved
    }
  })

  it('regen 重写同一章：发 story-reset 清卡而非拼接旧文', async () => {
    await expect(registerNovelSessionEvents()).resolves.toBe(true)
    const session = new RecordingSession()
    const detach = attachProgressFeed(app, session, 'proj-x')
    const emit = (event: unknown): void =>
      (app as unknown as { emitPipelineEvent(e: unknown): void }).emitPipelineEvent(event)

    // 第一代：start + delta + finish
    emit({ type: 'novel.story-start', projectId: 'proj-x', chapter: 1, title: '第1章' })
    emit({ type: 'novel.story-delta', projectId: 'proj-x', chapter: 1, delta: '旧文第一段。' })
    emit({ type: 'novel.story-finish', projectId: 'proj-x', chapter: 1, score: 8 })
    await new Promise((r) => setTimeout(r, 200))

    // 重写（regen 重跑 processChapter 重发同 key story-start）：不应重复开卡或拼接旧文
    emit({ type: 'novel.story-start', projectId: 'proj-x', chapter: 1, title: '第1章' })
    emit({ type: 'novel.story-delta', projectId: 'proj-x', chapter: 1, delta: '新稿第一段。' })
    emit({ type: 'novel.story-finish', projectId: 'proj-x', chapter: 1, score: 9 })
    await new Promise((r) => setTimeout(r, 200))

    const starts = session.events.filter((e) => e.type === 'novel/story-start')
    expect(starts).toHaveLength(1) // 不重复开卡（装配器拒绝第二个 start）

    const resets = session.events.filter((e) => e.type === 'novel/story-reset')
    expect(resets).toHaveLength(1)
    expect((resets[0].data as { chapter: number }).chapter).toBe(1)

    const deltas = session.events
      .filter((e) => e.type === 'novel/story-delta')
      .map((e) => (e.data as { delta: string }).delta)
    // 客户端遇 reset 会清空旧卡再累积新稿；feed 侧保证两代正文帧都转发，是否拼接由 update() 决定
    expect(deltas).toEqual(['旧文第一段。', '新稿第一段。'])

    const finishes = session.events.filter((e) => e.type === 'novel/story-finish')
    expect(finishes).toHaveLength(2)
    detach()
  })

  it('不同章不受同 key 重写守卫影响，reset 只命中同一 (projectId, chapter)', async () => {
    await expect(registerNovelSessionEvents()).resolves.toBe(true)
    const session = new RecordingSession()
    const detach = attachProgressFeed(app, session, 'proj-x')
    const emit = (event: unknown): void =>
      (app as unknown as { emitPipelineEvent(e: unknown): void }).emitPipelineEvent(event)

    emit({ type: 'novel.story-start', projectId: 'proj-x', chapter: 1, title: '第1章' })
    emit({ type: 'novel.story-start', projectId: 'proj-x', chapter: 2, title: '第2章' })
    // 第 1 章重写
    emit({ type: 'novel.story-start', projectId: 'proj-x', chapter: 1, title: '第1章' })
    emit({ type: 'novel.story-delta', projectId: 'proj-x', chapter: 1, delta: '第1章新稿。' })
    emit({ type: 'novel.story-delta', projectId: 'proj-x', chapter: 2, delta: '第2章正文。' })
    await new Promise((r) => setTimeout(r, 200))

    const starts = session.events.filter((e) => e.type === 'novel/story-start')
    expect(starts).toHaveLength(2) // 两章各开一张卡
    const resets = session.events.filter((e) => e.type === 'novel/story-reset')
    expect(resets).toHaveLength(1) // 仅第 1 章重写命中 reset，第 2 章不受影响
    expect((resets[0].data as { chapter: number }).chapter).toBe(1)
    const ch2Delta = session.events
      .filter((e) => e.type === 'novel/story-delta' && (e.data as { chapter?: number }).chapter === 2)
      .map((e) => (e.data as { delta: string }).delta)
    expect(ch2Delta).toEqual(['第2章正文。'])
    detach()
  })
})
