import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NovelHarnessApp, phaseSummaryText } from '../../src/app'
import { FakeHost } from '../../src/host/dsh-adapter'
import type { ModelGateway, LlmRequest, InvokeContext } from '../../src/model/gateway'
import type { PipelineRole } from '../../src/project/schema'
import { diverseParagraphText } from '../helpers/text'

/** 记录各角色调用；invokeStream 一次性回调全文（writer 走流式面）。 */
class FakeLlmGateway implements ModelGateway {
  readonly calls: Array<{ role: string; chapter?: number }> = []
  constructor(private readonly handler: (role: PipelineRole, request: LlmRequest, ctx: InvokeContext) => string) {}
  setBindings(): void {}
  channelStatus(): [] {
    return []
  }
  async invoke(role: PipelineRole, request: LlmRequest, ctx: InvokeContext) {
    this.calls.push({ role, chapter: ctx.chapter })
    return { content: this.handler(role, request, ctx), finishReason: 'stop' as const, usage: null, raw: {} }
  }
  async invokeStream(role: PipelineRole, request: LlmRequest, ctx: InvokeContext, onDelta?: (text: string) => void) {
    const res = await this.invoke(role, request, ctx)
    onDelta?.(res.content)
    return res
  }
}

const PLANNING = JSON.stringify({
  world: { worldview: '民国武林', themes: ['孤独'] },
  characters: [
    { name: '沈孤鸿', tier: '主角', surfaceIdentity: '刀客', trueCore: '旧案幸存者', coreDesire: '查明真相', relations: [{ target: '白老板', relation: '故人' }], narrativeFunction: '推进主线' },
    { name: '白老板', tier: '重要配角', surfaceIdentity: '酒馆老板', trueCore: '线人', coreDesire: '护住女儿', relations: [{ target: '沈孤鸿', relation: '故人' }], narrativeFunction: '提供情报' },
  ],
  locations: [{ name: '长街', spatialFeatures: '青石板', moodTone: '冷冽', relatedCharacters: ['沈孤鸿'], narrativeFunction: '主要场景' }],
})

function outlineJson(ch: number): string {
  return JSON.stringify({
    chapter: ch,
    title: `第${ch}章`,
    summary: `第${ch}章摘要`,
    keyEvents: ['夜探'],
    scenes: [{ seq: 1, locationRef: '长街', timeAdvance: '当日黄昏', purpose: '寻人' }],
    crossChapterHandoff: 'x',
    foreshadowPlan: [],
  })
}

const OUTLINE_REVIEW_OK = JSON.stringify({ score: 9, issues: [], styleDeviation: 'none' })
const DRAFT_REVIEW_OK = JSON.stringify({ score: 8, issues: [], styleDeviation: 'none', aiFlavorVerdict: { softFindings: [] } })

function defaultDraft(): string {
  return diverseParagraphText(18, 2200)
}

let root: string
let app: NovelHarnessApp

function happyGateway(): FakeLlmGateway {
  return new FakeLlmGateway((role, _req, ctx) => {
    if (role === 'planner') return PLANNING
    if (role === 'outliner') return outlineJson(ctx.chapter ?? 1)
    if (role === 'outline-reviewer') return OUTLINE_REVIEW_OK
    if (role === 'writer') return defaultDraft()
    return DRAFT_REVIEW_OK
  })
}

async function createProject(app: NovelHarnessApp, chapters: number): Promise<string> {
  const created = (await app.executeCommand('novel.create', {
    name: `phase-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    premise: '民国年间，刀客沈孤鸿为查旧案真相重回故地，揭开十年前灭门惨案背后的秘密。',
    chapters,
    stylePack: 'generic',
  })) as { project: { projectId: string } }
  return created.project.projectId
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'app-phase-'))
  app = new NovelHarnessApp({ dataRoot: root, host: new FakeHost(root), gateway: happyGateway() })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('单阶段命令（novel.plan/outline/write）', () => {
  it('novel.plan 只跑规划并回到暂停态', async () => {
    const projectId = await createProject(app, 2)
    const gateway = app.gateway as unknown as FakeLlmGateway

    const result = (await app.executeCommand('novel.plan', { project: projectId })) as { phase: string; status: string }
    expect(result.phase).toBe('planning')
    expect(result.status).toBe('done')
    expect(gateway.calls.map((c) => c.role)).toEqual(['planner'])
    expect((await app.projects.loadProject(projectId)).status).toBe('paused')
  })

  it('novel.outline 无规划时报错引导先跑规划', async () => {
    const projectId = await createProject(app, 1)
    await expect(app.executeCommand('novel.outline', { project: projectId })).rejects.toThrow(/尚未完成规划/)
  })

  it('novel.outline --chapters 子集只处理目标章，随后可补全', async () => {
    const projectId = await createProject(app, 3)
    await app.executeCommand('novel.plan', { project: projectId })
    const gateway = app.gateway as unknown as FakeLlmGateway

    const subset = (await app.executeCommand('novel.outline', { project: projectId, chapters: [2] })) as { outline: Array<{ chapter: number }> }
    expect(subset.outline?.map((o) => o.chapter)).toEqual([2])
    expect(gateway.calls.filter((c) => c.role === 'outliner').map((c) => c.chapter)).toEqual([2])
    expect((await app.projects.loadProject(projectId)).status).toBe('paused')

    const full = (await app.executeCommand('novel.outline', { project: projectId })) as { outline: Array<{ chapter: number }> }
    expect(full.outline?.map((o) => o.chapter)).toEqual([1, 2, 3])
  })

  it('novel.write --temperature 覆盖 writer 绑定并完成全书', async () => {
    const projectId = await createProject(app, 2)
    await app.executeCommand('novel.plan', { project: projectId })
    await app.executeCommand('novel.outline', { project: projectId })

    const result = (await app.executeCommand('novel.write', { project: projectId, temperature: 0.4 })) as { phase: string }
    expect(result.phase).toBe('done')
    const config = await app.projects.loadProject(projectId)
    expect(config.status).toBe('completed')
    expect(config.bindings.find((b) => b.role === 'writer')?.temperature).toBe(0.4)
  })
})

describe('startStepped 逐阶段驱动（聊天式默认）', () => {
  it('询问继续/停止：停止后暂停项目并保留已产出阶段', async () => {
    const projectId = await createProject(app, 2)
    const gateway = app.gateway as unknown as FakeLlmGateway
    const ask = vi.fn().mockResolvedValueOnce('continue').mockResolvedValueOnce('stop')

    const result = (await app.executeCommand('novel.start', { project: projectId }, ask)) as {
      stopped: boolean
      summaries: string
      phase: string
    }
    expect(result.stopped).toBe(true)
    expect(ask).toHaveBeenCalledTimes(2)
    expect(result.summaries).toContain('【规划】')
    expect(result.summaries).toContain('【章纲】')
    expect((await app.projects.loadProject(projectId)).status).toBe('paused')
    const roles = gateway.calls.map((c) => c.role)
    expect(roles).not.toContain('writer')
  })

  it('持续继续：规划→章纲→正文→全书完成', async () => {
    const projectId = await createProject(app, 2)
    const ask = vi.fn().mockResolvedValue('continue')

    const result = (await app.executeCommand('novel.start', { project: projectId }, ask)) as {
      stopped: boolean
      phase: string
      summaries: string
    }
    expect(result.stopped).toBe(false)
    expect(result.phase).toBe('done')
    expect(ask).toHaveBeenCalledTimes(2)
    expect(result.summaries).toContain('【全书完成】')
    expect((await app.projects.loadProject(projectId)).status).toBe('completed')
    const { existsSync } = await import('node:fs')
    expect(existsSync(join(root, 'novels', projectId, 'chapters', 'final', 'chapter_0001.txt'))).toBe(true)
  })

  it('ask 抛出（无提问通道）时不阻塞、连续跑完', async () => {
    const projectId = await createProject(app, 2)
    const ask = vi.fn().mockRejectedValue(new Error('no provider'))

    const result = (await app.executeCommand('novel.start', { project: projectId }, ask)) as { stopped: boolean; phase: string }
    expect(result.stopped).toBe(false)
    expect(result.phase).toBe('done')
    expect((await app.projects.loadProject(projectId)).status).toBe('completed')
  })
})

describe('phaseSummaryText 阶段摘要呈现', () => {
  it('规划摘要含世界观/人物/地点', () => {
    const text = phaseSummaryText({
      phase: 'planning',
      projectId: 'p',
      status: 'done',
      planning: { worldview: '民国武林', characters: ['沈孤鸿'], locations: ['长街'] },
    })
    expect(text).toContain('民国武林')
    expect(text).toContain('沈孤鸿')
    expect(text).toContain('长街')
  })

  it('章纲摘要逐章呈现标题', () => {
    const text = phaseSummaryText({
      phase: 'outline',
      projectId: 'p',
      status: 'done',
      outline: [{ chapter: 1, title: '灯亮的那一夜', summary: '沈孤鸿回到长街。' }],
    })
    expect(text).toContain('第1章「灯亮的那一夜」')
  })
})
