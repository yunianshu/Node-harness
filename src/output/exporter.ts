import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ProjectPaths } from '../storage/layout.js'
import { buildSummaryReport } from '../notify/progress.js'

export interface ExportBundle {
  bundleDir: string
  files: string[]
  totalWords: number
}

export async function exportPackage(
  paths: ProjectPaths,
  name: string,
  startedAt: string | null,
): Promise<ExportBundle> {
  const bundleDir = join(paths.output.bundleDir, `bundle-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  await mkdir(join(bundleDir, '设定集'), { recursive: true })

  const files: string[] = []

  const copyIfExists = async (src: string, dest: string): Promise<void> => {
    const content = await readFile(src, 'utf-8').catch(() => null)
    if (content === null) return
    await writeFile(join(bundleDir, dest), content, 'utf-8')
    files.push(dest)
  }

  if (await readFile(paths.output.fullNovel, 'utf-8').catch(() => null)) {
    await copyIfExists(paths.output.fullNovel, '全文.txt')
  }

  await copyIfExists(paths.worldJson, join('设定集', '世界观.json'))
  await copyIfExists(paths.charactersJson, join('设定集', '角色档案.json'))
  await copyIfExists(paths.locationsJson, join('设定集', '地点档案.json'))
  await copyIfExists(paths.premiseTxt, join('设定集', '故事前提.txt'))

  const summary = await buildSummaryReport(paths, name, JSON.parse(await readFile(paths.projectJson, 'utf-8')).totalChapters, startedAt)
  await writeFile(join(bundleDir, '总结报告.json'), JSON.stringify(summary, null, 2), 'utf-8')
  files.push('总结报告.json')

  return { bundleDir, files, totalWords: summary.totalWords }
}