import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { StylePackLoader, StylePackError } from '../../src/quality/style-pack-loader'

const packRoot = join(process.cwd(), 'style-packs')

describe('style pack loader', () => {
  it('loads both built-in packs', async () => {
    const loader = new StylePackLoader(packRoot)
    const generic = await loader.load('generic')
    expect(generic.packId).toBe('generic')
    expect(generic.anchors.length).toBeGreaterThanOrEqual(1)
    expect(generic.exemplars.length).toBeGreaterThanOrEqual(3)
    const gulong = await loader.load('gulong')
    expect(gulong.anchors.some((a) => a.rule.includes('招式'))).toBe(true)
    expect(gulong.anchors.some((a) => a.rule.includes('极简'))).toBe(true)
    expect(gulong.environmentStrategy).toContain('气象')
  })

  it('lists available pack ids', async () => {
    const loader = new StylePackLoader(packRoot)
    const list = await loader.list()
    expect(list).toContain('generic')
    expect(list).toContain('gulong')
  })

  it('unknown pack id throws with available hint', async () => {
    const loader = new StylePackLoader(packRoot)
    await expect(loader.load('wuxia')).rejects.toBeInstanceOf(StylePackError)
  })

  it('checklist must map one-to-one with anchors', async () => {
    const { writeFile, mkdtemp } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const dir = await mkdtemp(join(tmpdir(), 'pack-'))
    const broken = {
      packId: 'broken',
      displayName: '坏包',
      anchors: [
        { anchorId: 'a1', rule: 'r1' },
        { anchorId: 'a2', rule: 'r2' },
      ],
      exemplars: [
        { plain: 'p1', styled: 's1' },
        { plain: 'p2', styled: 's2' },
        { plain: 'p3', styled: 's3' },
      ],
      checklist: [{ anchorId: 'a1', question: 'q1' }],
    }
    await writeFile(join(dir, 'broken', 'pack.json'), JSON.stringify(broken), { flag: 'wx' }).catch(async () => {
      const { mkdir } = await import('node:fs/promises')
      await mkdir(join(dir, 'broken'), { recursive: true })
      await writeFile(join(dir, 'broken', 'pack.json'), JSON.stringify(broken))
    })
    const loader = new StylePackLoader(dir)
    await expect(loader.load('broken')).rejects.toThrow(/一一对应/)
  })
})