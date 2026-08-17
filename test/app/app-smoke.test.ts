import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { NovelHarnessApp } from '../../src/app'
import { FakeHost } from '../../src/host/dsh-adapter'
import type { ModelGateway, LlmRequest, InvokeContext } from '../../src/model/gateway'
import type { PipelineRole } from '../../src/project/schema'
import { diverseParagraphText } from '../helpers/text'

let root: string
let app: NovelHarnessApp

const PLANNING = JSON.stringify({
  world: { worldview: '民国武林', themes: ['孤独'] },
  characters: [
    { name: '沈孤鸿', tier: '主角', surfaceIdentity: '刀客', trueCore: '旧案幸存者', coreDesire: '查明真相', relations: [{ target: '白老板', relation: '故人' }], narrativeFunction: '推进主线' },
    { name: '白老板', tier: '重要配角', surfaceIdentity: '酒馆老板', trueCore: '线人', coreDesire: '护住女儿', relations: [{ target: '沈孤鸿', relation: '故人' }], narrativeFunction: '提供情报' },
  ],
  locations: [
    { name: '长街', spatialFeatures: '青石板', moodTone: '冷冽', relatedCharacters: [], narrativeFunction: '' },
    { name: '酒馆', spatialFeatures: '木楼', moodTone: '暖浊', relatedCharacters: [], narrativeFunction: '' },
  ],
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
            chapter: ch,
            title: `第${ch}章`,
            summary: '摘要',
            keyEvents: ['事件'],
            scenes: [{ seq: 1, locationRef: '长街', timeAdvance: '当日', purpose: '寻人' }],
            crossChapterHandoff: '衔接',
            foreshadowPlan: [],
          }),
          finishReason: 'stop',
          usage: null,
          raw: {},
        }
      }
      if (role === 'outline-reviewer') return { content: JSON.stringify({ score: 9, issues: [], styleDeviation: 'none' }), finishReason: 'stop', usage: null, raw: {} }
      if (role === 'writer') return { content: diverseParagraphText(18, 2200), finishReason: 'stop', usage: null, raw: {} }
      return { content: JSON.stringify({ score: 8, issues: [], styleDeviation: 'none' }), finishReason: 'stop', usage: null, raw: {} }
    },
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'app-'))
  app = new NovelHarnessApp({ dataRoot: root, host: new FakeHost(root), gateway: makeGateway() })
})

describe('novel harness app commands (smoke: create → start → status → pause → guidance → export)', () => {
  it('runs the full command chain', async () => {
    const created = (await app.executeCommand('novel.create', {
      name: `smoke-${Date.now()}`,
      premise: '民国刀客查案，风雪长街，旧恨新仇，真相层层揭开的故事。',
      chapters: 2,
      stylePack: 'generic',
    })) as { project: { projectId: string }; warnings: string[] }
    const projectId = created.project.projectId
    expect(created.project.status).toBe('pending')

    await app.executeCommand('novel.start', { project: projectId })
    await waitUntil(async () => (await app.projects.loadProject(projectId)).status === 'completed', 15000)

    const status = await app.executeCommand('novel.status', { project: projectId })
    expect(status).toMatchObject({ stages: { final: { done: 2, total: 2 } } })

    await app.executeCommand('novel.pause', { project: projectId }).catch(() => {})
    const note = (await app.executeCommand('novel.guidance.add', {
      project: projectId,
      chapter: 1,
      stage: 'content',
      content: '增加环境描写',
    })) as { note: { status: string } }
    expect(note.note.status).toBe('pending')

    const exported = (await app.executeCommand('novel.export', { project: projectId })) as {
      compiled: { ok: boolean; finalCount: number }
      bundle: { files: string[] }
    }
    expect(exported.compiled.ok).toBe(true)
    expect(exported.compiled.finalCount).toBe(2)
    expect(exported.bundle.files.length).toBeGreaterThan(3)

    const report = await app.executeCommand('novel.report', { project: projectId })
    expect(report).toMatchObject({ finalCount: 2 })
    expect(existsSync(join(root, 'novels', projectId, 'reports', 'summary_report.json'))).toBe(true)
  }, 30000)

  it('provider registration stores credential via host (no plaintext in config files)', async () => {
    await app.executeCommand('novel.admin.provider', {
      providerId: 'glm',
      kind: 'openai-compat',
      baseURL: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'sk-plaintext-secret',
    })
    const providers = app.gateway.channelStatus()
    expect(providers).toEqual([])
    const all = JSON.stringify(app)
    expect(all).not.toContain('sk-plaintext-secret')
  })

  it('commands list is complete', () => {
    const names = app.commands().map((c) => c.name)
    for (const expected of [
      'novel.create',
      'novel.start',
      'novel.pause',
      'novel.resume',
      'novel.stop',
      'novel.status',
      'novel.report',
      'novel.export',
      'novel.guidance.add',
      'novel.guidance.regen',
      'novel.admin.provider',
      'novel.regenerate',
    ]) {
      expect(names).toContain(expected)
    }
  })
})

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('waitUntil timeout')
}