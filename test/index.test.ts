import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import Commands from '@deepseek-ai/dsh-commands'
import { apply, FakeHost } from '../src/index'
import type { HostProvider } from '../src/host/types'
import type { SessionAppender } from '../src/progress-feed'

/** 记录会话 append：验证进度/正文流式事件是否写入会话日志。 */
class RecordingSession implements SessionAppender {
  readonly events: Array<{ type: string; data?: unknown }> = []
  append(type: 'novel/progress-start' | 'novel/progress' | 'novel/story-start' | 'novel/story-reset' | 'novel/story-delta' | 'novel/story-finish' | 'novel/toc-start' | 'novel/toc', data: unknown): unknown {
    this.events.push({ type, data })
    return undefined
  }
}

/** 挂载真实 dsh 命令服务后加载插件，返回根上下文与宿主。 */
async function bootPlugin(llm?: HostProvider['llm']) {
  const ctx = new Context()
  await ctx.plugin(Commands)
  const dataRoot = await mkdtemp(join(tmpdir(), 'novel-plugin-'))
  const host = new FakeHost(dataRoot, llm)
  apply(ctx, { host, dataRoot })
  return { ctx, host, dataRoot }
}

function invoke(rawInput: string): CommandInvocation {
  return {
    commandId: 'test-command-id' as never,
    agent: {} as never,
    rawInput,
    signal: new AbortController().signal,
  }
}

function invokeWithSession(rawInput: string, session: SessionAppender): CommandInvocation {
  return {
    commandId: 'test-command-id' as never,
    agent: { session } as never,
    rawInput,
    signal: new AbortController().signal,
  }
}

async function runCommand(ctx: Context, name: string, rawInput: string): Promise<CommandResult> {
  const def = ctx.commands.find(undefined, name)
  if (def === undefined) throw new Error(`command not found: ${name}`)
  return await def.handler(invoke(rawInput))
}

async function runCommandWithSession(ctx: Context, name: string, rawInput: string, session: SessionAppender): Promise<CommandResult> {
  const def = ctx.commands.find(undefined, name)
  if (def === undefined) throw new Error(`command not found: ${name}`)
  return await def.handler(invokeWithSession(rawInput, session))
}

const contexts: Context[] = []

afterEach(() => {
  for (const ctx of contexts.splice(0)) {
    void ctx.root.fiber.dispose()
  }
})

describe('plugin entry（真实 dsh 命令体系集成）', () => {
  it('registers novel-* commands on the dsh command registry', async () => {
    const { ctx } = await bootPlugin()
    contexts.push(ctx)
    const names = ctx.commands.list(undefined).map((d) => d.name)
    expect(names).toContain('novel-create')
    expect(names).toContain('novel-guidance-add')
    expect(names).toContain('novel-guidance-regen')
    expect(names).toContain('novel-admin-provider')
    expect(names).toContain('novel-plan')
    expect(names).toContain('novel-outline')
    expect(names).toContain('novel-write')
    expect(names.every((n) => !n.includes('.'))).toBe(true)
  })

  it('exposes the app through ctx.novelApp service handle', async () => {
    const { ctx } = await bootPlugin()
    contexts.push(ctx)
    expect(ctx.novelApp).toBeDefined()
    expect(ctx.novelApp.app.commands().map((c) => c.name)).toContain('novel.create')
  })

  it('dispatches novel-create with quoted premise and optional style pack', async () => {
    const { ctx } = await bootPlugin()
    contexts.push(ctx)
    const result = await runCommand(ctx, 'novel-create', '--name 风雪录 --premise "民国武林，刀客寻仇，雪夜长街，故人重逢" --chapters 5')
    expect(result.kind).toBe('success')
    const created = JSON.parse((result as { text: string }).text)
    expect(created.project.name).toBe('风雪录')
    expect(created.project.totalChapters).toBe(5)
    expect(created.project.status).toBe('pending')
    expect(created.warnings.join()).toContain('generic')
  })

  it('reports usage error on missing required flag', async () => {
    const { ctx } = await bootPlugin()
    contexts.push(ctx)
    const result = await runCommand(ctx, 'novel-create', '--name 风雪录')
    expect(result.kind).toBe('error')
    expect((result as { text: string }).text).toContain('--premise')
  })

  it('rejects unknown flags', async () => {
    const { ctx } = await bootPlugin()
    contexts.push(ctx)
    const result = await runCommand(ctx, 'novel-status', '--project p1 --bogus 1')
    expect(result.kind).toBe('error')
    expect((result as { text: string }).text).toContain('--bogus')
  })

  it('coerces chapter list flags for novel-regenerate', async () => {
    const { ctx } = await bootPlugin()
    contexts.push(ctx)
    const created = await runCommand(ctx, 'novel-create', '--name 残卷 --premise "一个关于旧案与真相的故事，主角是退隐的捕快" --chapters 3')
    expect(created.kind).toBe('success')
    const projectId = JSON.parse((created as { text: string }).text).project.projectId
    const result = await runCommand(ctx, 'novel-regenerate', `--project ${projectId} --chapters 1,2,3`)
    expect(result.kind).toBe('success')
    const ticket = JSON.parse((result as { text: string }).text)
    expect(ticket.chapters).toEqual([1, 2, 3])
  })

  it('keeps secret-bearing command input out of the session log contract', async () => {
    const { ctx } = await bootPlugin()
    contexts.push(ctx)
    const def = ctx.commands.find(undefined, 'novel-admin-provider')
    expect(def).toBeDefined()
    expect(def?.recordInput).toBe(false)
    expect(ctx.commands.find(undefined, 'novel-create')?.recordInput).not.toBe(false)
  })

  it('binds the progress feed BEFORE executing long commands (novel-plan captures live progress snapshots)', async () => {
    // planner 一次流返回合法规划产物，让 planning 阶段真实跑通并 emit pipeline.log / stage-done
    const planningJson = JSON.stringify({
      world: { worldview: '雪夜江湖，十年前灭门旧案笼罩北地边城', themes: ['复仇', '真相'] },
      characters: [
        { name: '沈孤鸿', tier: '主角', surfaceIdentity: '刀客', trueCore: '执念', coreDesire: '查清旧案', relations: [{ target: '贺连城', relation: '旧友' }], narrativeFunction: '推动主线' },
        { name: '贺连城', tier: '重要配角', surfaceIdentity: '酒馆老板', trueCore: '隐瞒', coreDesire: '守密', relations: [{ target: '沈孤鸿', relation: '旧友' }], narrativeFunction: '提供线索' },
      ],
      locations: [{ name: '雪夜长街', spatialFeatures: '积雪深巷', moodTone: '肃杀', relatedCharacters: ['沈孤鸿'], narrativeFunction: '主场景' }],
    })
    const llm: HostProvider['llm'] = {
      listModels: async () => [{ provider: 'dsh', model: 'mock', name: 'mock' }],
      stream: async function* () {
        yield { text: planningJson, finish: 'stop' }
      },
    }
    const { ctx } = await bootPlugin(llm)
    contexts.push(ctx)
    const created = await runCommand(ctx, 'novel-create', '--name 绑定时序 --premise "雪夜长街，刀客为查旧案重回故地" --chapters 1')
    expect(created.kind).toBe('success')
    const projectId = JSON.parse((created as { text: string }).text).project.projectId

    const session = new RecordingSession()
    const result = await runCommandWithSession(ctx, 'novel-plan', `--project ${projectId}`, session)
    expect(result.kind).toBe('success')
    // 命令执行前已 attach：progress-start 由 bind 在命令期间发出
    expect(session.events.filter((e) => e.type === 'novel/progress-start')).toHaveLength(1)
    // planning 阶段 pipeline.log / stage-done 触发多条实时快照：
    // 若 attach 拖到命令结束后（回归），将只有 bind 初始 1 条，断言失败
    const snapshots = session.events.filter((e) => e.type === 'novel/progress') as Array<{ data: { projectId: string } }>
    expect(snapshots.length).toBeGreaterThanOrEqual(2)
    expect(snapshots[0].data.projectId).toBe(projectId)
  })
})
