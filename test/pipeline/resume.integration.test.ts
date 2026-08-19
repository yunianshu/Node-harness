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

const PLANNING = JSON.stringify({
  world: { worldview: '民国武林', themes: ['孤独'] },
  characters: [
    { name: '沈孤鸿', tier: '主角', surfaceIdentity: '刀客', trueCore: '旧案幸存者', coreDesire: '查明真相', relations: [{ target: '白老板', relation: '故人' }], narrativeFunction: '推进主线' },
    { name: '白老板', tier: '重要配角', surfaceIdentity: '酒馆老板', trueCore: '线人', coreDesire: '护女儿', relations: [{ target: '沈孤鸿', relation: '故人' }], narrativeFunction: '情报' },
  ],
  locations: [
    { name: '长街', spatialFeatures: '', moodTone: '冷冽', relatedCharacters: [], narrativeFunction: '' },
    { name: '酒馆', spatialFeatures: '', moodTone: '暖浊', relatedCharacters: [], narrativeFunction: '' },
  ],
})

function outlineJson(ch: number) {
  return JSON.stringify({
    chapter: ch,
    title: `第${ch}章`,
    summary: '摘要',
    keyEvents: ['事件'],
    scenes: [{ seq: 1, locationRef: '长街', timeAdvance: '当日', purpose: '寻人' }],
    crossChapterHandoff: '衔接',
    foreshadowPlan: [],
  })
}

let root: string
let host: FakeHost
let service: ProjectService
const writerCalls = new Map<number, number>()
const events: Array<Record<string, unknown>> = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'resume-it-'))
  host = new FakeHost(root)
  service = new ProjectService({ host, listStylePacks: async () => ['generic'] })
  writerCalls.clear()
  events.length = 0
})

function makeGateway(): ModelGateway {
  return {
    setBindings: () => {},
    channelStatus: () => [],
    async invoke(role: PipelineRole, _req: LlmRequest, ctx: InvokeContext) {
      if (role === 'planner') return { content: PLANNING, finishReason: 'stop', usage: null, raw: {} }
      if (role === 'outliner') return { content: outlineJson(ctx.chapter ?? 1), finishReason: 'stop', usage: null, raw: {} }
      if (role === 'outline-reviewer') return { content: JSON.stringify({ score: 9, issues: [], styleDeviation: 'none' }), finishReason: 'stop', usage: null, raw: {} }
      if (role === 'writer') {
        const ch = ctx.chapter ?? 0
        writerCalls.set(ch, (writerCalls.get(ch) ?? 0) + 1)
        return { content: diverseParagraphText(18, 2200), finishReason: 'stop', usage: null, raw: {} }
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

function makeScheduler(): PipelineScheduler {
  return new PipelineScheduler({
    host,
    gateway: makeGateway(),
    projectService: service,
    stylePackLoader: new StylePackLoader(join(process.cwd(), 'style-packs')),
    onEvent: (e) => events.push(e),
  })
}

describe('resume across restart (spec 4.2.1)', () => {
  it('abort after chapter 1 final → restart completes 2..3 with zero duplicate generation', async () => {
    const { project } = await service.create(
      { name: `resume-${Date.now()}`, premise: '刀客查案重回故地揭开灭门惨案真相的悬疑故事，风雪长街，旧恨新仇。', totalChapters: 3, stylePackId: 'generic' },
      'tester',
    )
    await service.start(project.projectId, 'tester')

    const controller1 = new AbortController()
    const run1 = makeScheduler().run(project.projectId, controller1.signal)

    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      if (existsSync(join(root, 'novels', project.projectId, 'chapters', 'final', 'chapter_0001.txt'))) break
      await new Promise((r) => setTimeout(r, 20))
    }
    controller1.abort()
    const summary1 = await run1
    expect(summary1.aborted).toBe(true)
    expect(existsSync(join(root, 'novels', project.projectId, 'chapters', 'final', 'chapter_0001.txt'))).toBe(true)

    await service.start(project.projectId, 'tester')
    const summary2 = await makeScheduler().run(project.projectId, new AbortController().signal)

    expect(summary2.aborted).toBe(false)
    expect(summary2.finalCount).toBe(3)
    expect(summary2.isolated).toEqual([])
    expect((await service.loadProject(project.projectId)).status).toBe('completed')

    expect(writerCalls.get(1)).toBe(1)
    expect(writerCalls.get(2)!).toBeGreaterThanOrEqual(1)
    expect(writerCalls.get(3)!).toBeGreaterThanOrEqual(1)
    expect((writerCalls.get(2) ?? 0) + (writerCalls.get(3) ?? 0)).toBeLessThanOrEqual(4)
  }, 30000)

  it('simulated crash leaves no half-written artifacts (atomic writes)', async () => {
    const { project } = await service.create(
      { name: `crash-${Date.now()}`, premise: '另一个足够长的前提'.repeat(3), totalChapters: 1, stylePackId: 'generic' },
      'tester',
    )
    await service.start(project.projectId, 'tester')
    const controller = new AbortController()
    const run = makeScheduler().run(project.projectId, controller.signal)
    await new Promise((r) => setTimeout(r, 200))
    controller.abort()
    await run.catch(() => {})
    const { readdir } = await import('node:fs/promises')
    const dirs = ['outline', 'outline_review', 'draft', 'review', 'final']
    for (const d of dirs) {
      const files = await readdir(join(root, 'novels', project.projectId, 'chapters', d)).catch(() => [] as string[])
      expect(files.filter((f) => f.includes('.tmp'))).toHaveLength(0)
    }
  })
})