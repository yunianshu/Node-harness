import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { FakeHost } from '../../src/host/dsh-adapter'
import { ProjectService } from '../../src/project/service'
import { StylePackLoader } from '../../src/quality/style-pack-loader'
import { PipelineScheduler } from '../../src/pipeline/scheduler'
import type { ModelGateway, LlmRequest, InvokeContext } from '../../src/model/gateway'
import type { PipelineRole } from '../../src/project/schema'
import { diverseParagraphText } from '../helpers/text'

type RoleHandler = (role: PipelineRole, request: LlmRequest, ctx: InvokeContext) => string

/** 记录各角色调用，invokeStream 一次性回调全文（Task #10 writer 走流式面）。 */
class FakeLlmGateway implements ModelGateway {
  readonly calls: Array<{ role: string; chapter?: number }> = []
  constructor(private readonly handler: RoleHandler) {}
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

function outlineJson(chapter: number): string {
  return JSON.stringify({
    chapter,
    title: `第${chapter}章`,
    summary: `第${chapter}章摘要`,
    keyEvents: ['夜探'],
    scenes: [{ seq: 1, locationRef: '长街', timeAdvance: '当日黄昏', purpose: '寻人' }],
    crossChapterHandoff: 'x',
    foreshadowPlan: [{ title: '断刀', action: 'planted' }],
  })
}

const OUTLINE_REVIEW_OK = JSON.stringify({ score: 9.0, issues: [], styleDeviation: 'none', rewriteFeedback: '' })
const DRAFT_REVIEW_OK = JSON.stringify({ score: 8.0, issues: [], styleDeviation: 'none', aiFlavorVerdict: { softFindings: [] }, rewriteFeedback: '' })

function defaultDraft(): string {
  return diverseParagraphText(18, 2200)
}

let root: string
let host: FakeHost
let service: ProjectService

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sched-phase-'))
  host = new FakeHost(root)
  service = new ProjectService({ host, listStylePacks: async () => ['generic', 'gulong'] })
})

async function createProject(chapters: number) {
  const { project } = await service.create(
    { name: `phase-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, premise: '民国年间，刀客沈孤鸿为查旧案真相重回故地。', totalChapters: chapters, stylePackId: 'generic' },
    'tester',
  )
  await service.start(project.projectId, 'tester')
  return project
}

function makeScheduler(gateway: ModelGateway, events: Array<Record<string, unknown>>) {
  return new PipelineScheduler({
    host,
    gateway,
    projectService: service,
    stylePackLoader: new StylePackLoader(join(process.cwd(), 'style-packs')),
    onEvent: (e) => events.push(e),
  })
}

function happyGateway(): { gateway: FakeLlmGateway } {
  const gateway = new FakeLlmGateway((role, _req, ctx) => {
    if (role === 'planner') return PLANNING
    if (role === 'outliner') return outlineJson(ctx.chapter ?? 1)
    if (role === 'outline-reviewer') return OUTLINE_REVIEW_OK
    if (role === 'writer') return defaultDraft()
    return DRAFT_REVIEW_OK
  })
  return { gateway }
}

describe('pipeline scheduler 阶段化 runPhase', () => {
  it('runPlanning 只跑规划；已规划项目二次调用报 already-done', async () => {
    const project = await createProject(2)
    const { gateway } = happyGateway()
    const scheduler = makeScheduler(gateway, [])

    const first = await scheduler.runPlanning(project.projectId, new AbortController().signal)
    expect(first.phase).toBe('planning')
    expect(first.status).toBe('done')
    expect(first.planning?.worldview).toBe('民国武林')
    expect(first.planning?.characters).toEqual(['沈孤鸿', '白老板'])
    const callsAfterFirst = gateway.calls.map((c) => c.role)
    expect(callsAfterFirst).toEqual(['planner'])

    const second = await scheduler.runPlanning(project.projectId, new AbortController().signal)
    expect(second.status).toBe('already-done')
    expect(gateway.calls.filter((c) => c.role === 'planner')).toHaveLength(1)
  })

  it('runOutline 只跑章纲（outliner+outline-reviewer），不触发正文', async () => {
    const project = await createProject(3)
    const { gateway } = happyGateway()
    const scheduler = makeScheduler(gateway, [])
    await scheduler.runPlanning(project.projectId, new AbortController().signal)

    const result = await scheduler.runOutline(project.projectId, new AbortController().signal)
    expect(result.phase).toBe('outline')
    expect(result.status).toBe('done')
    expect(result.outline).toHaveLength(3)
    expect(result.outline?.[0]?.title).toBe('第1章')
    const roles = gateway.calls.map((c) => c.role)
    expect(roles.filter((r) => r === 'writer')).toHaveLength(0)
    expect(roles.filter((r) => r === 'outliner')).toHaveLength(3)
    expect(roles.filter((r) => r === 'outline-reviewer')).toHaveLength(3)
  })

  it('runOutline --chapters 子集只处理目标章（其余章纲不动）', async () => {
    const project = await createProject(3)
    const { gateway } = happyGateway()
    const scheduler = makeScheduler(gateway, [])
    await scheduler.runPlanning(project.projectId, new AbortController().signal)

    const result = await scheduler.runOutline(project.projectId, new AbortController().signal, [2])
    expect(result.status).toBe('done')
    expect(result.outline?.map((o) => o.chapter)).toEqual([2])
    const outlinerChapters = gateway.calls.filter((c) => c.role === 'outliner').map((c) => c.chapter)
    expect(outlinerChapters).toEqual([2])

    // 第 1 章仍未产出章纲 → outline 阶段未完成
    const again = await scheduler.runOutline(project.projectId, new AbortController().signal)
    expect(again.status).toBe('done')
    expect(again.outline?.map((o) => o.chapter)).toEqual([1, 2, 3])
  })

  it('runWrite 只跑正文；全书完成返回 phase done', async () => {
    const project = await createProject(2)
    const { gateway } = happyGateway()
    const scheduler = makeScheduler(gateway, [])
    await scheduler.runPlanning(project.projectId, new AbortController().signal)
    await scheduler.runOutline(project.projectId, new AbortController().signal)
    gateway.calls.length = 0

    const result = await scheduler.runWrite(project.projectId, new AbortController().signal)
    expect(result.phase).toBe('done')
    expect(result.write?.finalDone).toBe(2)
    const roles = gateway.calls.map((c) => c.role)
    expect(roles.filter((r) => r === 'outliner')).toHaveLength(0)
    expect(roles.filter((r) => r === 'writer')).toHaveLength(2)
    expect(roles.filter((r) => r === 'reviewer')).toHaveLength(2)
    expect((await service.loadProject(project.projectId)).status).toBe('completed')
  })

  it('runPhase 自动串联下一未完成阶段；全书完成后报 done', async () => {
    const project = await createProject(2)
    const { gateway } = happyGateway()
    const scheduler = makeScheduler(gateway, [])

    const p1 = await scheduler.runPhase(project.projectId, new AbortController().signal)
    expect(p1.phase).toBe('planning')
    const p2 = await scheduler.runPhase(project.projectId, new AbortController().signal)
    expect(p2.phase).toBe('outline')
    const p3 = await scheduler.runPhase(project.projectId, new AbortController().signal)
    expect(p3.phase).toBe('done')
    expect(p3.status).toBe('done')
    const dir = join(root, 'novels', project.projectId)
    expect(existsSync(join(dir, 'chapters', 'final', 'chapter_0001.txt'))).toBe(true)
    expect(existsSync(join(dir, 'chapters', 'final', 'chapter_0002.txt'))).toBe(true)
  })

  it('每阶段完成发 pipeline.stage-done 事件（供命令层呈现+询问）', async () => {
    const project = await createProject(1)
    const { gateway } = happyGateway()
    const events: Array<Record<string, unknown>> = []
    const scheduler = makeScheduler(gateway, events)
    await scheduler.runPhase(project.projectId, new AbortController().signal)
    await scheduler.runPhase(project.projectId, new AbortController().signal)
    const stageDones = events.filter((e) => e.type === 'pipeline.stage-done')
    expect(stageDones.map((e) => e.phase)).toEqual(['planning', 'outline'])
  })
})
