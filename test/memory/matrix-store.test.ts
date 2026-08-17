import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { MatrixConsistencyError, MatrixStore } from '../../src/memory/matrix-store'

let store: MatrixStore
let dir: string
let validChapters: Set<number>

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'matrix-'))
  validChapters = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
  store = new MatrixStore({
    matrixFile: join(dir, 'matrix.json'),
    snapshotsDir: join(dir, 'snapshots'),
    chapterArtifactExists: async (ch) => validChapters.has(ch),
  })
  await store.load()
})

describe('matrix store', () => {
  it('foreshadow lifecycle: add → reveal with artifact check', async () => {
    const f = await store.addForeshadow({ title: '海棠信物', plantedChapter: 2, expectedRevealChapter: 8 })
    expect(f.id).toBe('F-001')
    await store.revealForeshadow(f.id, 9)
    expect(store.current().foreshadows[0].status).toBe('revealed')
    expect(store.current().foreshadows[0].revealedChapter).toBe(9)
  })

  it('dangling reveal pointing to missing chapter artifact is rejected', async () => {
    const f = await store.addForeshadow({ title: '断刀', plantedChapter: 1 })
    await expect(store.revealForeshadow(f.id, 999)).rejects.toBeInstanceOf(MatrixConsistencyError)
  })

  it('motif accumulation and mystery advancement', async () => {
    await store.recordMotif('雪', 1)
    await store.recordMotif('雪', 4)
    await store.recordMotif('刀', 2)
    const m = await store.addMystery('谁是内鬼', 3)
    await store.advanceMystery(m.id, 6)
    await store.resolveMystery(m.id, 10)
    const cur = store.current()
    expect(cur.motifs.find((x) => x.motif === '雪')?.count).toBe(2)
    expect(cur.mysteries[0].status).toBe('resolved')
    expect(cur.mysteries[0].resolvedChapter).toBe(10)
  })

  it('character state update merges patch and logs change', async () => {
    await store.updateCharacterState('沈孤鸿', '主角', 3, { location: '长街', injury: '左臂中刀' })
    await store.updateCharacterState('沈孤鸿', '主角', 5, { injury: '伤愈' })
    const entry = store.current().characterStates[0]
    expect(entry.status.location).toBe('长街')
    expect(entry.status.injury).toBe('伤愈')
    expect(entry.changeLog).toHaveLength(2)
    expect(entry.lastUpdatedChapter).toBe(5)
  })

  it('spatiotemporal keeps only latest entry + rolling history summary', async () => {
    for (let ch = 1; ch <= 8; ch++) {
      await store.setSpatiotemporal({
        chapter: ch,
        startScene: { location: `地${ch}`, description: '' },
        endScene: { location: `地${ch}尾`, description: '' },
        timeline: `第${ch}章`,
        status: 'valid',
      })
    }
    const cur = store.current()
    expect(cur.spatiotemporalLatest?.chapter).toBe(8)
    expect(cur.spatiotemporalHistory).toHaveLength(5)
    expect(cur.spatiotemporalHistory[4].chapter).toBe(7)
  })

  it('pending-manual marking works on latest spacetime entry', async () => {
    await store.setSpatiotemporal({
      chapter: 4,
      startScene: { location: '雪山', description: '' },
      endScene: { location: '山洞', description: '' },
      timeline: '当夜',
      status: 'valid',
    })
    await store.markSpatiotemporalPendingManual(4)
    expect(store.current().spatiotemporalLatest?.status).toBe('pending-manual')
  })

  it('persists matrix and writes per-chapter snapshot', async () => {
    await store.addForeshadow({ title: '旧伤', plantedChapter: 1 })
    await store.snapshot(1)
    expect(existsSync(join(dir, 'matrix.json'))).toBe(true)
    expect(existsSync(join(dir, 'snapshots', 'chapter_0001.json'))).toBe(true)
    const reloaded = new MatrixStore({ matrixFile: join(dir, 'matrix.json'), snapshotsDir: join(dir, 'snapshots') })
    await reloaded.load()
    expect(reloaded.current().foreshadows).toHaveLength(1)
  })
})