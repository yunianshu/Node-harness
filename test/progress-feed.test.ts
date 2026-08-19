import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 模拟 dsh 会话事件类型注册面（真实包的运行时依赖树过重，不引入单测）
vi.mock('@deepseek-ai/dsh-session', () => ({
  KNOWN_SESSION_EVENT_TYPES: new Set(['turn/start', 'turn/end']),
}))

import { NovelHarnessApp } from '../src/app'
import { FakeHost } from '../src/host/dsh-adapter'
import { attachProgressFeed, registerNovelSessionEvents } from '../src/progress-feed'
import type { NovelProgressEventData, SessionAppender } from '../src/progress-feed'
import type { ModelGateway, LlmRequest, InvokeContext } from '../src/model/gateway'
import type { PipelineRole } from '../src/project/schema'
import { diverseParagraphText, resetCounter } from './helpers/text'

class RecordingSession implements SessionAppender {
  readonly events: { type: string; data?: unknown }[] = []

  append(type: 'novel/progress-start', data: { projectId: string; name: string }): unknown
  append(type: 'novel/progress', data: NovelProgressEventData): unknown
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
    // Task #10 后 writer 走流式面：聚合后一次性回调（非 dsh 模型无真实增量）
    async invokeStream(role, request, ctx, onDelta) {
      const res = await this.invoke(role, request, ctx)
      onDelta?.(res.content)
      return res
    },
  }
}

describe('NovelProgressFeed（会话进度供给）', () => {
  let root: string
  let app: NovelHarnessApp

  beforeEach(async () => {
    resetCounter()
    root = await mkdtemp(join(tmpdir(), 'progress-feed-'))
    app = new NovelHarnessApp({ dataRoot: root, host: new FakeHost(root), gateway: makeGateway() })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('registers session event types before use', async () => {
    await expect(registerNovelSessionEvents()).resolves.toBe(true)
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
})
