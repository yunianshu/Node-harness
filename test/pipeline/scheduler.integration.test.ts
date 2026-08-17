import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { FakeHost } from '../../src/host/dsh-adapter'
import { ProjectService } from '../../src/project/service'
import { StylePackLoader } from '../../src/quality/style-pack-loader'
import { PipelineScheduler } from '../../src/pipeline/scheduler'
import type { ModelGateway, LlmRequest, InvokeContext } from '../../src/model/gateway'
import type { PipelineRole } from '../../src/project/schema'
import { diverseParagraphText } from '../helpers/text'

type RoleHandler = (role: PipelineRole, request: LlmRequest, ctx: InvokeContext) => string

class FakeLlmGateway implements ModelGateway {
  readonly calls: Array<{ role: string; user: string; chapter?: number }> = []
  constructor(private readonly handler: RoleHandler) {}
  setBindings(): void {}
  channelStatus():[] { return [] }
  async invoke(role: PipelineRole, request: LlmRequest, ctx: InvokeContext) {
    this.calls.push({ role, user: request.user, chapter: ctx.chapter })
    const content = this.handler(role, request, ctx)
    return { content, finishReason: 'stop' as const, usage: null, raw: {} }
  }
}

const PLANNING = JSON.stringify({
  world: { worldview: '民国武林', themes: ['孤独'] },
  characters: [
    {
      name: '沈孤鸿',
      tier: '主角',
      surfaceIdentity: '刀客',
      trueCore: '旧案幸存者',
      coreDesire: '查明真相',
      relations: [{ target: '白老板', relation: '故人' }],
      narrativeFunction: '推进主线',
    },
    {
      name: '白老板',
      tier: '重要配角',
      surfaceIdentity: '酒馆老板',
      trueCore: '线人',
      coreDesire: '护住女儿',
      relations: [{ target: '沈孤鸿', relation: '故人' }],
      narrativeFunction: '提供情报',
    },
  ],
  locations: [
    { name: '长街', spatialFeatures: '青石板', moodTone: '冷冽', relatedCharacters: ['沈孤鸿'], narrativeFunction: '主要场景' },
    { name: '酒馆', spatialFeatures: '木楼', moodTone: '暖浊', relatedCharacters: ['白老板'], narrativeFunction: '情报场' },
  ],
})

function outlineJson(chapter: number): string {
  return JSON.stringify({
    chapter,
    title: `第${chapter}章`,
    summary: `第${chapter}章摘要：沈孤鸿在长街追查线索。`,
    keyEvents: ['夜探酒馆'],
    scenes: [
      { seq: 1, locationRef: '长街', timeAdvance: '当日黄昏', purpose: '寻人' },
      { seq: 2, locationRef: '酒馆', timeAdvance: '当夜', purpose: '对质', transition: '行程过渡' },
    ],
    crossChapterHandoff: '下一章从酒馆离开后开始',
    foreshadowPlan: [{ title: '断刀', action: 'planted' }],
  })
}

const OUTLINE_REVIEW_OK = JSON.stringify({ score: 9.0, issues: [], styleDeviation: 'none', rewriteFeedback: '' })
const DRAFT_REVIEW_OK = JSON.stringify({ score: 8.0, issues: [], styleDeviation: 'none', aiFlavorVerdict: { softFindings: [] }, rewriteFeedback: '' })
const DRAFT_REVIEW_LOW = JSON.stringify({ score: 3.0, issues: [{ severity: 'general', description: '平淡', location: '' }], styleDeviation: 'none', rewriteFeedback: '重写' })

function defaultDraft(): string {
  return diverseParagraphText(18, 2200)
}

let root: string
let host: FakeHost
let service: ProjectService
let events: Array<Record<string, unknown>>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sched-'))
  host = new FakeHost(root)
  service = new ProjectService({ host, listStylePacks: async () => ['generic', 'gulong'] })
  events = []
})

async function createProject(chapters: number) {
  const { project } = await service.create(
    {
      name: `sched-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      premise: '民国年间，刀客沈孤鸿为查旧案真相重回故地，揭开十年前灭门惨案背后的惊天秘密。',
      totalChapters: chapters,
      stylePackId: 'generic',
    },
    'tester',
  )
  await service.start(project.projectId, 'tester')
  return project
}

function makeScheduler(gateway: ModelGateway) {
  return new PipelineScheduler({
    host,
    gateway,
    projectService: service,
    stylePackLoader: new StylePackLoader(join(process.cwd(), 'style-packs')),
    onEvent: (e) => events.push(e),
  })
}

describe('pipeline scheduler integration', () => {
  it('runs a 2-chapter project end-to-end: planning gate → outline → draft → review → final', async () => {
    const project = await createProject(2)
    const gateway = new FakeLlmGateway((role, _req, ctx) => {
      if (role === 'planner') return PLANNING
      if (role === 'outliner') return outlineJson(ctx.chapter ?? 1)
      if (role === 'outline-reviewer') return OUTLINE_REVIEW_OK
      if (role === 'writer') return defaultDraft()
      return DRAFT_REVIEW_OK
    })
    const scheduler = makeScheduler(gateway)
    const summary = await scheduler.run(project.projectId, new AbortController().signal)

    
    expect(summary.finalCount).toBe(2)
    expect(summary.isolated).toEqual([])
    const dir = join(root, 'novels', project.projectId)
    expect(existsSync(join(dir, 'world.json'))).toBe(true)
    expect(existsSync(join(dir, 'characters.json'))).toBe(true)
    expect(existsSync(join(dir, 'chapters', 'final', 'chapter_0001.txt'))).toBe(true)
    expect(existsSync(join(dir, 'chapters', 'final', 'chapter_0002.txt'))).toBe(true)
    expect(existsSync(join(dir, 'chapters', 'review', 'chapter_0001_review.json'))).toBe(true)
    expect(existsSync(join(dir, 'memory', 'matrix.json'))).toBe(true)
    expect(existsSync(join(dir, 'memory', 'snapshots', 'chapter_0001.json'))).toBe(true)

    const roles = gateway.calls.map((c) => c.role)
    expect(roles.indexOf('planner')).toBe(0)
    expect(roles).toContain('outliner')
    expect(roles).toContain('writer')
    expect(roles).toContain('reviewer')
    expect((await service.loadProject(project.projectId)).status).toBe('completed')
  })

  it('planning gate: missing world blocks chapter 1 writing until planner runs (spec 5.3.1 rule 1)', async () => {
    const project = await createProject(1)
    let plannerCalled = 0
    const gateway = new FakeLlmGateway((role, _req, ctx) => {
      if (role === 'planner') {
        plannerCalled++
        return PLANNING
      }
      if (role === 'outliner') return outlineJson(ctx.chapter ?? 1)
      if (role === 'outline-reviewer') return OUTLINE_REVIEW_OK
      if (role === 'writer') return defaultDraft()
      return DRAFT_REVIEW_OK
    })
    await makeScheduler(gateway).run(project.projectId, new AbortController().signal)
    const writerCall = gateway.calls.find((c) => c.role === 'writer')
    const plannerCall = gateway.calls.find((c) => c.role === 'planner')
    expect(plannerCall).toBeDefined()
    expect(writerCall).toBeDefined()
    expect(gateway.calls.indexOf(plannerCall!)).toBeLessThan(gateway.calls.indexOf(writerCall!))
    expect(plannerCalled).toBe(1)
  })

  it('chapter with persistently low review score is isolated; others complete (spec 5.6.1 rule 3)', async () => {
    const project = await createProject(3)
    const gateway = new FakeLlmGateway((role, _req, ctx) => {
      if (role === 'planner') return PLANNING
      if (role === 'outliner') return outlineJson(ctx.chapter ?? 1)
      if (role === 'outline-reviewer') return OUTLINE_REVIEW_OK
      if (role === 'writer') return defaultDraft()
      return ctx.chapter === 2 ? DRAFT_REVIEW_LOW : DRAFT_REVIEW_OK
    })
    const scheduler = makeScheduler(gateway)
    const summary = await scheduler.run(project.projectId, new AbortController().signal)

    expect(summary.isolated).toContain(2)
    expect(summary.finalCount).toBe(2)
    const dir = join(root, 'novels', project.projectId)
    expect(existsSync(join(dir, 'chapters', 'final', 'chapter_0002.txt'))).toBe(false)
    expect(existsSync(join(dir, 'chapters', 'final', 'chapter_0003.txt'))).toBe(true)
    const isolation = JSON.parse(readFileSync(join(dir, 'state', 'isolation.json'), 'utf-8'))
    expect(isolation.isolated[0].chapter).toBe(2)
  }, 60000)

  it('review service unavailable → draft stays awaiting review, never auto-final (spec 5.3.1 rule 9)', async () => {
    const project = await createProject(1)
    const gateway = new FakeLlmGateway((role, _req, ctx) => {
      if (role === 'planner') return PLANNING
      if (role === 'outliner') return outlineJson(ctx.chapter ?? 1)
      if (role === 'outline-reviewer') return OUTLINE_REVIEW_OK
      if (role === 'writer') return defaultDraft()
      throw new Error('review service unavailable')
    })
    const scheduler = makeScheduler(gateway)
    const summary = await scheduler.run(project.projectId, new AbortController().signal)

    expect(summary.finalCount).toBe(0)
    const dir = join(root, 'novels', project.projectId)
    expect(existsSync(join(dir, 'chapters', 'draft', 'chapter_0001.txt'))).toBe(true)
    expect(existsSync(join(dir, 'chapters', 'final', 'chapter_0001.txt'))).toBe(false)
  }, 60000)
})


