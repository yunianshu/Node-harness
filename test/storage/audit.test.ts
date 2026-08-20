import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendJsonl, AuditLog } from '../../src/storage/audit'

describe('audit log', () => {
  it('appends entries with increasing seq and reads them back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'audit-'))
    const log = new AuditLog(join(dir, 'logs', 'audit.jsonl'))
    await log.append('user-a', 'project.create', { projectId: 'p1' })
    await log.append('user-a', 'project.start', { projectId: 'p1' })
    const entries = await log.readAll()
    expect(entries).toHaveLength(2)
    expect(entries[0].seq).toBe(1)
    expect(entries[1].seq).toBe(2)
    expect(entries[0].action).toBe('project.create')
    expect(entries[1].operator).toBe('user-a')
  })

  it('existing lines are never rewritten by later appends', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'audit-'))
    const file = join(dir, 'audit.jsonl')
    const log = new AuditLog(file)
    await log.append('user-a', 'project.create', { projectId: 'p1' })
    const firstSnapshot = await readFile(file, 'utf-8')
    await log.append('user-b', 'guidance.attach', { noteId: 'n1' })
    const after = await readFile(file, 'utf-8')
    expect(after.startsWith(firstSnapshot)).toBe(true)
    expect(after.split('\n').filter(Boolean)).toHaveLength(2)
  })

  it('new instance continues seq after restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'audit-'))
    const file = join(dir, 'audit.jsonl')
    const first = new AuditLog(file)
    await first.append('user-a', 'project.create')
    const second = new AuditLog(file)
    await second.append('user-a', 'project.pause')
    expect((await second.readAll()).map((e) => e.seq)).toEqual([1, 2])
  })

  it('corrupted trailing line is skipped without losing earlier entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'audit-'))
    const file = join(dir, 'audit.jsonl')
    await writeFile(file, '{"seq":1,"timestamp":"t","operator":"u","action":"project.create"}\n{broken\n', 'utf-8')
    const log = new AuditLog(file)
    const entries = await log.readAll()
    expect(entries).toHaveLength(1)
    await log.append('u', 'project.stop')
    expect((await log.readAll()).map((e) => e.seq)).toEqual([1, 2])
  })
})

describe('appendJsonl（独立 JSONL 追加，pipeline-errors 等专用日志）', () => {
  it('自动创建目录并逐行追加 JSON，不读回不计 seq', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jsonl-'))
    const file = join(dir, 'nested', 'pipeline-errors.jsonl')
    await appendJsonl(file, { projectId: 'p1', message: '规划失败' })
    await appendJsonl(file, { projectId: 'p2' })
    const text = await readFile(file, 'utf-8')
    const lines = text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    expect(lines).toHaveLength(2)
    expect(lines[0].projectId).toBe('p1')
    expect(lines[0].message).toBe('规划失败')
    expect(lines[1].message).toBeUndefined()
  })
})