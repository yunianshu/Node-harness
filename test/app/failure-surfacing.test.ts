import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 模拟 dsh 会话事件类型注册面（与 progress-feed.test.ts 同款，避免引入真实运行时依赖树）
vi.mock('@deepseek-ai/dsh-session', () => ({
  KNOWN_SESSION_EVENT_TYPES: new Set(['turn/start', 'turn/end']),
}))

import { NovelHarnessApp } from '../../src/app'
import { FakeHost } from '../../src/host/dsh-adapter'
import {
  attachProgressFeed,
  registerNovelSessionEvents,
  resetSessionEventTypesRegistration,
} from '../../src/progress-feed'
import type { NovelProgressEventData, SessionAppender } from '../../src/progress-feed'
import type { ModelGateway } from '../../src/model/gateway'

class RecordingSession implements SessionAppender {
  readonly events: { type: string; data?: unknown }[] = []

  append(type: 'novel/progress-start', data: { projectId: string; name: string }): unknown
  append(type: 'novel/progress', data: NovelProgressEventData): unknown
  append(type: 'novel/story-start', data: { projectId: string; chapter: number; title?: string }): unknown
  append(type: 'novel/story-reset', data: { projectId: string; chapter: number }): unknown
  append(type: 'novel/story-delta', data: { projectId: string; chapter: number; delta: string }): unknown
  append(type: 'novel/story-finish', data: { projectId: string; chapter: number; score?: number; isolated?: boolean }): unknown
  append(type: 'novel/toc-start', data: { projectId: string; name: string }): unknown
  append(type: 'novel/toc', data: unknown): unknown
  append(type: string, data: unknown): unknown {
    this.events.push({ type, data })
    return undefined
  }
}

/**
 * 规划产物恒为空 → PlannerIncompleteError → 3 次补全耗尽 → 自动流水线失败。
 * 精确复现真实缺陷场景（规划失败被静默暂停，失败原因无处可看）。
 */
const emptyPlannerGateway = {
  setBindings: () => {},
  channelStatus: () => [] as const,
  invoke: async () => ({ content: '{}', finishReason: 'stop' as const, usage: null, raw: {} }),
  invokeStream: async () => ({ content: '{}', finishReason: 'stop' as const, usage: null, raw: {} }),
} as unknown as ModelGateway

/** 轮询等待条件成立（startProject 为 fire-and-forget，失败落盘异步）。 */
async function waitFor(cond: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('waitFor 超时')
}

describe('失败原因透出（startProject 自动流水线）', () => {
  let root: string
  let app: NovelHarnessApp

  beforeEach(async () => {
    resetSessionEventTypesRegistration()
    root = await mkdtemp(join(tmpdir(), 'fail-surf-'))
    app = new NovelHarnessApp({ dataRoot: root, host: new FakeHost(root), gateway: emptyPlannerGateway })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('规划连续失败：lastError 落 project.json + 状态回滚 paused + pipeline-errors.jsonl 写盘', async () => {
    const created = await app.projects.create(
      { name: '失败透出', premise: '刀客为查旧案真相重回故地，雪夜长街，故人重逢。', totalChapters: 1, stylePackId: 'gulong' },
      'test',
    )
    const projectId = created.project.projectId
    await app.startProject(projectId)

    await waitFor(async () => {
      const p = await app.projects.loadProject(projectId)
      return p.status === 'paused' && p.lastError !== undefined
    })
    const config = await app.projects.loadProject(projectId)
    expect(config.status).toBe('paused')
    expect(config.lastError).toContain('规划阶段连续失败')
    // problems 内容并入 lastError（世界观/角色等补全原因）
    expect(config.lastError).toContain('世界观档案缺失')

    // pipeline.error 无 webhook 也落盘 logs/pipeline-errors.jsonl
    const raw = await readFile(join(root, 'novels', projectId, 'logs', 'pipeline-errors.jsonl'), 'utf-8')
    const entries = raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    expect(entries.length).toBeGreaterThanOrEqual(1)
    const planning = entries.find((e) => e.stage === 'planning')
    expect(planning).toBeDefined()
    expect(planning.projectId).toBe(projectId)
    expect(planning.message).toContain('规划阶段连续失败')
    expect(typeof planning.timestamp).toBe('string')
  })

  it('失败后进度卡快照携带 lastError（红条数据源）+ recent 时间线含失败原因', async () => {
    await registerNovelSessionEvents()
    const created = await app.projects.create(
      { name: '失败透出', premise: '刀客为查旧案真相重回故地，雪夜长街，故人重逢。', totalChapters: 1, stylePackId: 'gulong' },
      'test',
    )
    const projectId = created.project.projectId
    const session = new RecordingSession()
    const detach = attachProgressFeed(app, session, projectId)

    await app.startProject(projectId)
    await waitFor(async () => {
      const p = await app.projects.loadProject(projectId)
      return p.status === 'paused' && p.lastError !== undefined
    })
    // 等待 recordFailure 后显式 emit 的 project.status 事件驱动的最新快照落地
    await waitFor(async () =>
      (session.events as { type: string; data?: unknown }[]).some(
        (e) => e.type === 'novel/progress' && (e.data as { lastError?: string } | undefined)?.lastError !== undefined,
      ),
    )

    const snaps = session.events.filter((e) => e.type === 'novel/progress') as { data?: NovelProgressEventData }[]
    const failed = snaps[snaps.length - 1].data!
    expect(failed.status).toBe('paused')
    expect(failed.lastError).toContain('规划阶段连续失败')
    // recent 同时呈现带原因的「（失败重试：…）」与兜底「失败：…」note
    const notes = (failed.recent ?? []).map((r) => r.note)
    expect(notes.some((n) => n.includes('（失败重试：'))).toBe(true)
    expect(notes.some((n) => n.includes('失败：规划阶段连续失败'))).toBe(true)
    detach()
  })
})
