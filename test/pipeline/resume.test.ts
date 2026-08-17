import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResumeScanner } from '../../src/pipeline/resume'

async function makeProject(): Promise<{ root: string; scanner: ResumeScanner }> {
  const root = await mkdtemp(join(tmpdir(), 'resume-'))
  const chaptersRoot = join(root, 'chapters')
  for (const sub of ['outline', 'outline_review', 'draft', 'review', 'final']) {
    await mkdir(join(chaptersRoot, sub), { recursive: true })
  }
  const scanner = new ResumeScanner({
    chaptersRoot,
    planningFiles: { world: join(root, 'world.json'), characters: join(root, 'characters.json'), locations: join(root, 'locations.json') },
  })
  return { root, scanner }
}

describe('resume scanner', () => {
  it('ch1~17 final + ch18 draft → ch18 continues at review stage (spec 5.6.1 rule 2)', async () => {
    const { root, scanner } = await makeProject()
    for (let ch = 1; ch <= 17; ch++) {
      await writeFile(join(root, 'chapters', 'final', `chapter_${String(ch).padStart(4, '0')}.txt`), '终稿内容')
    }
    await writeFile(join(root, 'chapters', 'draft', 'chapter_0018.txt'), '初稿内容')
    const result = await scanner.scan()
    expect(result.progress.get(18)).toEqual({ outline: false, outlineReview: false, draft: true, review: false, final: false })
    expect(ResumeScanner.nextActionFor(result.progress.get(18)!)).toBe('outline')
    expect(result.maxFinalChapter).toBe(17)
    expect(result.hasAnyArtifacts).toBe(true)
  })

  it('corrupted outline json counts as missing (spec 5.6.3 scenario 1)', async () => {
    const { root, scanner } = await makeProject()
    await writeFile(join(root, 'chapters', 'outline', 'chapter_0001.json'), '{broken')
    const result = await scanner.scan()
    expect(result.progress.get(1)?.outline ?? false).toBe(false)
  })

  it('planning missing without artifacts → hasPlanning=false, hasAnyArtifacts=false', async () => {
    const { scanner } = await makeProject()
    const result = await scanner.scan()
    expect(result.hasPlanning).toBe(false)
    expect(result.hasAnyArtifacts).toBe(false)
  })

  it('complete planning files detected', async () => {
    const { root, scanner } = await makeProject()
    await writeFile(join(root, 'world.json'), '{}')
    await writeFile(join(root, 'characters.json'), '[]')
    await writeFile(join(root, 'locations.json'), '[]')
    const result = await scanner.scan()
    expect(result.hasPlanning).toBe(true)
  })

  it('empty draft file counts as missing', async () => {
    const { root, scanner } = await makeProject()
    await writeFile(join(root, 'chapters', 'draft', 'chapter_0003.txt'), '   ')
    const result = await scanner.scan()
    expect(result.progress.get(3)?.draft ?? false).toBe(false)
  })
})