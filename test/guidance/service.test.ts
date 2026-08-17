import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GuidanceError, GuidanceService } from '../../src/guidance/service'
import { FakeHost } from '../../src/host/dsh-adapter'
import { ProjectService } from '../../src/project/service'
import { projectPaths } from '../../src/storage/layout'
import { ensureProjectLayout } from '../../src/storage/layout'

let root: string
let host: FakeHost
let service: ProjectService
let guidance: GuidanceService
let projectId: string
let paused = false
let hasArtifacts = true

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'guid-'))
  host = new FakeHost(root)
  service = new ProjectService({ host, listStylePacks: async () => ['generic'] })
  const { project } = await service.create(
    { name: `g-${Date.now()}`, premise: '一个足够长的故事前提'.repeat(5), totalChapters: 10, stylePackId: 'generic' },
    'tester',
  )
  projectId = project.projectId
  paused = false
  hasArtifacts = true
  guidance = new GuidanceService({
    isProjectPaused: async () => paused,
    hasArtifactsFor: async () => hasArtifacts,
    projectRoot: async (id) => {
      const paths = projectPaths(root, id)
      await ensureProjectLayout(paths)
      return { guidanceFile: paths.guidance.notesJson, auditFile: paths.logs.auditLog }
    },
  })
})

describe('guidance service', () => {
  it('rejects attach when project not paused (spec 5.9.1 rule 8)', async () => {
    await expect(guidance.attach(projectId, { chapters: [3], stage: 'content' }, '加强环境描写')).rejects.toMatchObject({
      code: 'NOT_PAUSED',
    })
  })

  it('attaches when paused; status pending; audited', async () => {
    paused = true
    const { note } = await guidance.attach(projectId, { chapters: [3], stage: 'content' }, '加强环境描写', 'wen')
    expect(note.status).toBe('pending')
    expect(note.noteId).toMatch(/^G-/)
    const audit = await readFile(join(root, 'novels', projectId, 'logs', 'audit.jsonl'), 'utf-8')
    expect(audit).toContain('guidance.attach')
    expect(audit).toContain('wen')
  })

  it('content length validated to 1~2000 chars', async () => {
    paused = true
    await expect(guidance.attach(projectId, { chapters: [1], stage: 'outline' }, '')).rejects.toMatchObject({
      code: 'CONTENT_LENGTH',
    })
    await expect(guidance.attach(projectId, { chapters: [1], stage: 'outline' }, 'x'.repeat(2001))).rejects.toMatchObject({
      code: 'CONTENT_LENGTH',
    })
  })

  it('later attach at same chapter×stage revokes earlier one with trace (spec 5.9.1 rule 3)', async () => {
    paused = true
    const first = await guidance.attach(projectId, { chapters: [3], stage: 'content' }, '第一条意见')
    const second = await guidance.attach(projectId, { chapters: [3], stage: 'content' }, '第二条意见')
    const all = await guidance.list(projectId)
    expect(all.find((n) => n.noteId === first.note.noteId)?.status).toBe('revoked')
    expect(all.find((n) => n.noteId === second.note.noteId)?.status).toBe('pending')
  })

  it('warning returned when target chapter has no artifacts yet (spec 5.9.3 scenario 1)', async () => {
    paused = true
    hasArtifacts = false
    const { warning } = await guidance.attach(projectId, { chapters: [8], stage: 'content' }, '意见')
    expect(warning).toContain('尚未生成')
  })

  it('consume marks consumed once; never re-injected (spec 5.9.1 rule 5)', async () => {
    paused = true
    await guidance.attach(projectId, { chapters: [2], stage: 'content' }, '重写第二幕')
    const first = await guidance.consume(projectId, 2, 'content', 'req-1')
    expect(first?.status).toBe('consumed')
    expect(first?.consumedBy?.requestId).toBe('req-1')
    const second = await guidance.consume(projectId, 2, 'content', 'req-2')
    expect(second).toBeNull()
    const pending = await guidance.list(projectId, { status: 'pending' })
    expect(pending).toHaveLength(0)
  })

  it('revoke only allowed for pending notes', async () => {
    paused = true
    const { note } = await guidance.attach(projectId, { chapters: [2], stage: 'content' }, '意见')
    await guidance.consume(projectId, 2, 'content', 'req-1')
    await expect(guidance.revoke(projectId, note.noteId)).rejects.toMatchObject({ code: 'NOT_REVOKABLE' })
    const { note: note2 } = await guidance.attach(projectId, { chapters: [3], stage: 'content' }, '可撤销')
    await expect(guidance.revoke(projectId, note2.noteId)).resolves.toBeUndefined()
    const all = await guidance.list(projectId)
    expect(all.find((n) => n.noteId === note2.noteId)?.status).toBe('revoked')
  })
})

describe('guidance error type', () => {
  it('exposes typed codes', () => {
    const err = new GuidanceError('NOT_PAUSED', 'x')
    expect(err.code).toBe('NOT_PAUSED')
  })
})