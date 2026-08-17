import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stat } from 'node:fs/promises'
import { ensureProjectLayout, projectPaths, chapterFile, novelsRoot } from '../../src/storage/layout'

async function dirExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p)
    return s.isDirectory()
  } catch {
    return false
  }
}

describe('storage layout', () => {
  it('creates full project skeleton', async () => {
    const root = await mkdtemp(join(tmpdir(), 'layout-'))
    const paths = projectPaths(root, 'proj-1')
    await ensureProjectLayout(paths)
    for (const dir of [
      paths.root,
      paths.charactersArchiveDir,
      paths.chapters.outline,
      paths.chapters.outlineReview,
      paths.chapters.draft,
      paths.chapters.review,
      paths.chapters.final,
      paths.memory.snapshotsDir,
      paths.guidance.root,
      paths.state.root,
      paths.logs.rawResponsesDir,
      paths.reports.root,
      paths.output.bundleDir,
    ]) {
      await expect(dirExists(dir)).resolves.toBe(true)
    }
    expect(paths.projectJson.endsWith(join('proj-1', 'project.json'))).toBe(true)
    expect(paths.chapters.final.endsWith('final')).toBe(true)
  })

  it('chapterFile pads chapter number to 4 digits', () => {
    expect(chapterFile(1)).toBe('chapter_0001')
    expect(chapterFile(123)).toBe('chapter_0123')
    expect(chapterFile(5000)).toBe('chapter_5000')
  })

  it('novelsRoot nests under dataRoot', () => {
    expect(novelsRoot('C:/data')).toBe(join('C:/data', 'novels'))
  })
})