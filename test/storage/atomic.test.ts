import { describe, expect, it } from 'vitest'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atomicWriteFile, atomicWriteJson, readJsonValidated, readTextIfExists, fileExists } from '../../src/storage/atomic'

describe('atomic write', () => {
  it('writes content readable afterwards', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atomic-'))
    const target = join(dir, 'project.json')
    await atomicWriteFile(target, 'hello')
    await expect(readFile(target, 'utf-8')).resolves.toBe('hello')
  })

  it('overwrites existing file completely (no partial merge)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atomic-'))
    const target = join(dir, 'data.json')
    await atomicWriteFile(target, '{"a":1,"longPadding":"xxxxx"}')
    await atomicWriteFile(target, '{"a":2}')
    await expect(readFile(target, 'utf-8')).resolves.toBe('{"a":2}')
  })

  it('leaves no tmp files after successful write', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atomic-'))
    await atomicWriteJson(join(dir, 'a.json'), { x: 1 })
    const files = await readdir(dir)
    expect(files.filter((f) => f.includes('.tmp'))).toHaveLength(0)
  })

  it('simulated crash (tmp left behind) is treated as nonexistent on read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atomic-'))
    const target = join(dir, 'matrix.json')
    await writeFile(join(dir, '.crash-tmp.tmp'), '{"half":')
    expect(await readJsonValidated(target)).toBeNull()
  })

  it('corrupted json file returns null (nonexistent semantics)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atomic-'))
    const target = join(dir, 'progress.json')
    await writeFile(target, '{"seq": 3, "half', 'utf-8')
    expect(await readJsonValidated(target)).toBeNull()
  })

  it('shape-validated read rejects structurally wrong payloads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atomic-'))
    const target = join(dir, 'item.json')
    await atomicWriteJson(target, { wrong: true })
    const isItem = (raw: unknown): raw is { id: number } => typeof raw === 'object' && raw !== null && 'id' in raw
    expect(await readJsonValidated(target, isItem)).toBeNull()
    await atomicWriteJson(target, { id: 7 })
    expect(await readJsonValidated(target, isItem)).toEqual({ id: 7 })
  })

  it('readTextIfExists and fileExists behave on missing files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atomic-'))
    const missing = join(dir, 'none.txt')
    expect(await readTextIfExists(missing)).toBeNull()
    expect(await fileExists(missing)).toBe(false)
    await writeFile(missing, 'x')
    expect(await fileExists(missing)).toBe(true)
  })
})