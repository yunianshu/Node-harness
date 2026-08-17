import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import Commands from '@deepseek-ai/dsh-commands'
import { apply, FakeHost } from '../src/index'

/** 挂载真实 dsh 命令服务后加载插件，返回根上下文与宿主。 */
async function bootPlugin() {
  const ctx = new Context()
  await ctx.plugin(Commands)
  const dataRoot = await mkdtemp(join(tmpdir(), 'novel-plugin-'))
  const host = new FakeHost(dataRoot)
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

async function runCommand(ctx: Context, name: string, rawInput: string): Promise<CommandResult> {
  const def = ctx.commands.find(undefined, name)
  if (def === undefined) throw new Error(`command not found: ${name}`)
  return await def.handler(invoke(rawInput))
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
})
