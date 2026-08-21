import { describe, expect, it } from 'vitest'
import {
  novelMilestoneDefinition,
  novelStoryDefinition,
  novelTocDefinition,
  type NovelStoryState,
  type NovelTocState,
} from '../../client/definition'
import type { NovelToc } from '../../src/notify/progress'

/**
 * novel/story-reset 客户端语义：regen/重试重写同一章时，feed 发 story-reset 清空
 * 既有卡正文，后续 delta 以新稿重新累积——否则旧文+新文在客户端拼接（对话流回归缺陷）。
 * definition.ts 仅 type-only imports，运行时擦除后可直接在 vitest 中调用 update()。
 */

/** update() 只读 context.state；参数类型直接取定义签名，避免耦合运行时上下文完整形态。 */
function runUpdate(state: NovelStoryState, event: { type: string; data: Record<string, unknown> }): NovelStoryState {
  const context = { state } as unknown as Parameters<typeof novelStoryDefinition.update>[0]
  const match = { event } as unknown as Parameters<typeof novelStoryDefinition.update>[1]
  return novelStoryDefinition.update(context, match) as NovelStoryState
}

const FINISHED: NovelStoryState = {
  projectId: 'p',
  chapter: 1,
  title: '第1章',
  text: '旧稿正文（第一代生成完毕）。',
  score: 8,
  isolated: false,
  done: true,
}

/** 构造一条完整会话事件（seq/time 为回放必要字段，match 签名要求）。 */
function storyEvent(type: string, data: Record<string, unknown>): Parameters<typeof novelStoryDefinition.match>[0] {
  return { type, seq: 1, time: 1, data } as Parameters<typeof novelStoryDefinition.match>[0]
}

describe('novelStoryDefinition（正文流式卡）', () => {
  it('match 将 story-reset 归为同 id 的 update 角色（不重复开卡）', () => {
    const m = novelStoryDefinition.match(storyEvent('novel/story-reset', { projectId: 'p', chapter: 1 }))
    expect(m).toEqual({ id: 'p-1', role: 'update' })
  })

  it('update 遇 story-reset 清空正文、重置收束标记与评分（卡复用，不拼接）', () => {
    const next = runUpdate(FINISHED, { type: 'novel/story-reset', data: { projectId: 'p', chapter: 1 } })
    expect(next.text).toBe('')
    expect(next.done).toBe(false)
    expect(next.score).toBeUndefined()
    expect(next.isolated).toBe(false)
    // 保留同 id 键控状态（章号/标题不变），仅内容重置
    expect(next.projectId).toBe('p')
    expect(next.chapter).toBe(1)
    expect(next.title).toBe('第1章')
  })

  it('reset 后 delta 以新稿重新累积，不含旧文残留', () => {
    const reset = runUpdate(FINISHED, { type: 'novel/story-reset', data: { projectId: 'p', chapter: 1 } })
    const after = runUpdate(reset, { type: 'novel/story-delta', data: { projectId: 'p', chapter: 1, delta: '新稿第一段。' } })
    expect(after.text).toBe('新稿第一段。')
    expect(after.text).not.toContain('旧稿正文')
  })

  it('reset 清除隔离标记，允许重写后正常收束', () => {
    const isolated: NovelStoryState = { ...FINISHED, isolated: true, done: true }
    const reset = runUpdate(isolated, { type: 'novel/story-reset', data: { projectId: 'p', chapter: 1 } })
    expect(reset.isolated).toBe(false)
    const finish = runUpdate(reset, { type: 'novel/story-finish', data: { projectId: 'p', chapter: 1, score: 9 } })
    expect(finish.done).toBe(true)
    expect(finish.score).toBe(9)
    expect(finish.isolated).toBe(false)
  })

  it('不相关类型事件透传 state 原样（update 保守）', () => {
    const next = runUpdate(FINISHED, { type: 'unrelated', data: {} })
    expect(next).toBe(FINISHED)
  })
})

// ---- novel/toc 目录卡 ----

/** toc 卡 update() 的 context/match 桥接（与 story 卡同构）。 */
function tocRunUpdate(state: NovelTocState, event: { type: string; data: Record<string, unknown> }): NovelTocState {
  const context = { state } as unknown as Parameters<typeof novelTocDefinition.update>[0]
  const match = { event } as unknown as Parameters<typeof novelTocDefinition.update>[1]
  return novelTocDefinition.update(context, match) as NovelTocState
}

function tocEvent(type: string, data: Record<string, unknown>): Parameters<typeof novelTocDefinition.match>[0] {
  return { type, seq: 1, time: 1, data } as Parameters<typeof novelTocDefinition.match>[0]
}

const TOC: NovelToc = {
  projectId: 'p',
  projectDir: '/tmp/novels/p',
  name: '测试书',
  status: 'generating',
  totalChapters: 2,
  outlineDone: 1,
  finalDone: 0,
  isolated: [2],
  entries: [
    { chapter: 1, title: '雪夜', stage: '正文写作', isolated: false },
    { chapter: 2, title: '旧案', stage: '章纲审查', isolated: true },
  ],
  updatedAt: '2026-08-19T00:00:00.000Z',
}

describe('novelTocDefinition（目录卡）', () => {
  it('match 将 toc-start 开卡、toc 归为 update，无关类型不命中', () => {
    expect(novelTocDefinition.match(tocEvent('novel/toc-start', { projectId: 'p', name: '测试书' }))).toEqual({ id: 'p', role: 'start' })
    expect(novelTocDefinition.match(tocEvent('novel/toc', TOC as unknown as Record<string, unknown>))).toEqual({ id: 'p', role: 'update' })
    expect(novelTocDefinition.match(tocEvent('novel/milestone', {}))).toBeNull()
  })

  it('start 以 toc-start 开卡并置空快照（后续 toc 帧整体替换）', () => {
    const start = novelTocDefinition.start
    const ctx = {} as unknown as Parameters<typeof start>[0]
    const reader = {} as unknown as Parameters<typeof start>[2]
    const startMatch = { event: tocEvent('novel/toc-start', { projectId: 'p', name: '测试书' }) } as unknown as Parameters<typeof start>[1]
    expect(start(ctx, startMatch, reader)).toEqual({ name: '测试书', snapshot: null })
    const badMatch = { event: tocEvent('novel/toc', TOC as unknown as Record<string, unknown>) } as unknown as Parameters<typeof start>[1]
    expect(() => start(ctx, badMatch, reader)).toThrow(/novel\/toc-start/)
  })

  it('update 遇 novel/toc 整体替换快照（latest-write-wins）', () => {
    const base: NovelTocState = { name: '测试书', snapshot: null }
    const next = tocRunUpdate(base, { type: 'novel/toc', data: TOC as unknown as Record<string, unknown> })
    expect(next.snapshot).toBe(TOC)
    expect(next.name).toBe('测试书')
  })

  it('update 对无关事件透传 state 原样', () => {
    const base: NovelTocState = { name: '测试书', snapshot: TOC }
    const next = tocRunUpdate(base, { type: 'unrelated', data: {} })
    expect(next).toBe(base)
  })

  it('buildViewNode：快照为空不渲染，有快照以快照为载荷', () => {
    const buildViewNode = novelTocDefinition.buildViewNode!
    type TocBuildViewNode = NonNullable<typeof novelTocDefinition.buildViewNode>
    const startEvent = tocEvent('novel/toc-start', { projectId: 'p', name: '测试书' })
    const ctxEmpty = { start: { event: startEvent } } as unknown as Parameters<TocBuildViewNode>[0]
    expect(buildViewNode(ctxEmpty)).toBeNull()

    const ctx = {
      start: { event: startEvent },
      state: { name: '测试书', snapshot: TOC },
      key: 'k',
      id: 'p',
    } as unknown as Parameters<TocBuildViewNode>[0]
    const node = buildViewNode(ctx)
    expect(node).not.toBeNull()
    expect(node!.kind).toBe('novel-toc')
    expect(node!.data).toBe(TOC)
  })
})

// ---- novel/milestone 里程碑卡 ----

function milestoneEvent(type: string, data: Record<string, unknown>): Parameters<typeof novelMilestoneDefinition.match>[0] {
  return { type, seq: 1, time: 1, data } as Parameters<typeof novelMilestoneDefinition.match>[0]
}

describe('novelMilestoneDefinition（里程碑消息卡）', () => {
  it('match 将 novel/milestone 归为唯一 id 的 start 角色', () => {
    const m = novelMilestoneDefinition.match(
      milestoneEvent('novel/milestone', { projectId: 'p', id: 'p-3', kind: 'step', text: '第 1 章 章纲生成', time: '06:00:14' }),
    )
    expect(m).toEqual({ id: 'p-3', role: 'start' })
  })

  it('start 透传完整载荷（含 reasoning 思考内容，不裁剪）', () => {
    const start = novelMilestoneDefinition.start
    const data = {
      projectId: 'p',
      id: 'p-3',
      kind: 'step',
      text: '第 1 章 章纲生成',
      time: '06:00:14',
      reasoning: '这一章要埋下旧案的线索。',
    }
    const ctx = {} as unknown as Parameters<typeof start>[0]
    const reader = {} as unknown as Parameters<typeof start>[2]
    const startMatch = { event: milestoneEvent('novel/milestone', data) } as unknown as Parameters<typeof start>[1]
    expect(start(ctx, startMatch, reader)).toEqual(data)
  })
})
