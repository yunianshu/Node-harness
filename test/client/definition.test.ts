import { describe, expect, it } from 'vitest'
import { novelStoryDefinition, type NovelStoryState } from '../../client/definition'

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
