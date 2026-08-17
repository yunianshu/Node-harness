import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { FakeHost } from '../../src/host/dsh-adapter'
import { ProjectError, ProjectService } from '../../src/project/service'
import { transition } from '../../src/project/state-machine'

let service: ProjectService
let host: FakeHost
let root: string
const packs = ['generic', 'gulong']

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'proj-svc-'))
  host = new FakeHost(root)
  service = new ProjectService({ host, listStylePacks: async () => packs })
})

const premise = 'a'.repeat(80)

describe('project create', () => {
  it('creates project with defaults and warns on short premise', async () => {
    const { project, warnings } = await service.create({ name: '风暴', premise: '短前提', totalChapters: 30 })
    expect(project.status).toBe('pending')
    expect(project.stylePackId).toBe('generic')
    expect(warnings.some((w) => w.includes('自动绑定'))).toBe(true)
    expect(warnings.some((w) => w.includes('故事前提较短'))).toBe(true)
  })

  it('rejects empty premise with PREMISE_EMPTY', async () => {
    await expect(service.create({ name: 'x', premise: '', totalChapters: 30 })).rejects.toMatchObject({
      code: 'PREMISE_EMPTY',
    })
  })

  it('rejects chapters=1000 with CHAPTER_RANGE', async () => {
    await expect(service.create({ name: 'x', premise, totalChapters: 1000 })).rejects.toMatchObject({
      code: 'CHAPTER_RANGE',
    })
  })

  it('rejects duplicate name with NAME_DUP', async () => {
    await service.create({ name: '风暴', premise, totalChapters: 30 })
    await expect(service.create({ name: '风暴', premise, totalChapters: 10 })).rejects.toMatchObject({
      code: 'NAME_DUP',
    })
  })

  it('rejects unknown style pack and lists available', async () => {
    await expect(
      service.create({ name: 'x', premise, totalChapters: 30, stylePackId: 'wuxia' }),
    ).rejects.toMatchObject({ code: 'STYLE_PACK_NOT_FOUND', detail: { available: packs } })
  })

  it('persists project.json + premise.txt + audit entry', async () => {
    const { project } = await service.create({ name: '风暴', premise, totalChapters: 30 }, 'user-a')
    const dir = join(root, 'novels', project.projectId)
    const config = JSON.parse(await readFile(join(dir, 'project.json'), 'utf-8'))
    expect(config.totalChapters).toBe(30)
    expect(await readFile(join(dir, 'premise.txt'), 'utf-8')).toBe(premise)
    const audit = await readFile(join(dir, 'logs', 'audit.jsonl'), 'utf-8')
    expect(audit).toContain('project.create')
    expect(audit).toContain('user-a')
  })
})

describe('project lifecycle', () => {
  it('walks start → pause → resume → stop with persisted status', async () => {
    const { project } = await service.create({ name: '风暴', premise, totalChapters: 30 })
    const id = project.projectId
    expect((await service.start(id)).status).toBe('planning')
    expect((await service.markPlanningDone(id)).status).toBe('generating')
    expect((await service.pause(id)).status).toBe('paused')
    expect((await service.resume(id)).status).toBe('generating')
    expect((await service.stop(id)).status).toBe('aborted')
  })

  it('rejects illegal operations with INVALID_STATE', async () => {
    const { project } = await service.create({ name: '风暴', premise, totalChapters: 30 })
    await expect(service.pause(project.projectId)).rejects.toMatchObject({ code: 'INVALID_STATE' })

  })

  it('premise change is always rejected (immutable after create)', async () => {
    const { project } = await service.create({ name: '风暴', premise, totalChapters: 30 })
    await expect(service.updatePremise(project.projectId, '新前提')).rejects.toMatchObject({
      code: 'PROJECT_IMMUTABLE',
    })
  })
})

describe('mutex lock', () => {
  it('second concurrent start is rejected with ALREADY_RUNNING', async () => {
    const { project } = await service.create({ name: '风暴', premise, totalChapters: 30 })
    await service.start(project.projectId)
    await expect(service.start(project.projectId)).rejects.toMatchObject({ code: 'ALREADY_RUNNING' })
  })

  it('stale lock (dead pid) is overridden', async () => {
    const { project } = await service.create({ name: '风暴', premise, totalChapters: 30 })
    await service.start(project.projectId)
    await service.pause(project.projectId)
    const lockPath = join(root, 'novels', project.projectId, 'state', 'pipeline.lock')
    await writeFile(lockPath, JSON.stringify({ pid: 999999999, startedAt: 'old', projectId: project.projectId }))
    const resumed = await service.start(project.projectId)
    expect(resumed.status).toBe('generating')
  })
})

describe('regenerate ticket', () => {
  it('validates chapter range and dedups', async () => {
    const { project } = await service.create({ name: '风暴', premise, totalChapters: 30 })
    const ticket = await service.regenerate(project.projectId, [5, 3, 3])
    expect(ticket.chapters).toEqual([3, 5])
    await expect(service.regenerate(project.projectId, [31])).rejects.toMatchObject({ code: 'CHAPTER_RANGE' })
  })
})

describe('corrupted project.json', () => {
  it('reports PROJECT_CORRUPTED for invalid json', async () => {
    const { project } = await service.create({ name: '风暴', premise, totalChapters: 30 })
    const path = join(root, 'novels', project.projectId, 'project.json')
    await writeFile(path, '{broken', 'utf-8')
    await expect(service.loadProject(project.projectId)).rejects.toMatchObject({ code: 'PROJECT_CORRUPTED' })
  })

  it('reports PROJECT_NOT_FOUND for missing project', async () => {
    await expect(service.loadProject('no-such')).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' })
  })
})

describe('state machine integration guard', () => {
  it('service throws typed ProjectError wrapping InvalidStateError', async () => {
    const { project } = await service.create({ name: '风暴', premise, totalChapters: 30 })
    const err = await service.pause(project.projectId).catch((e) => e)
    expect(err).toBeInstanceOf(ProjectError)
    expect(err.detail.from).toBe('pending')
    expect(() => transition('pending', 'pause')).toThrow()
  })
})