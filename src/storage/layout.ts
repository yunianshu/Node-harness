import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

export const NOVELS_ROOT = 'novels'

export interface ProjectPaths {
  root: string
  projectJson: string
  premiseTxt: string
  worldJson: string
  charactersJson: string
  charactersArchiveDir: string
  locationsJson: string
  chapters: {
    root: string
    outline: string
    outlineReview: string
    draft: string
    review: string
    final: string
  }
  memory: {
    root: string
    matrixJson: string
    snapshotsDir: string
  }
  guidance: {
    root: string
    notesJson: string
  }
  state: {
    root: string
    pipelineLock: string
    progressJson: string
    isolationJson: string
    channelsJson: string
  }
  logs: {
    root: string
    pipelineLog: string
    auditLog: string
    rawResponsesDir: string
  }
  reports: {
    root: string
    summaryReport: string
    progressSnapshots: string
  }
  output: {
    root: string
    fullNovel: string
    bundleDir: string
  }
}

export function chapterFile(chapter: number): string {
  return `chapter_${String(chapter).padStart(4, '0')}`
}

export function novelsRoot(dataRoot: string): string {
  return join(dataRoot, NOVELS_ROOT)
}

export function projectPaths(dataRoot: string, projectId: string): ProjectPaths {
  const root = join(novelsRoot(dataRoot), projectId)
  const chaptersRoot = join(root, 'chapters')
  const memoryRoot = join(root, 'memory')
  const guidanceRoot = join(root, 'guidance')
  const stateRoot = join(root, 'state')
  const logsRoot = join(root, 'logs')
  const reportsRoot = join(root, 'reports')
  const outputRoot = join(root, 'output')
  return {
    root,
    projectJson: join(root, 'project.json'),
    premiseTxt: join(root, 'premise.txt'),
    worldJson: join(root, 'world.json'),
    charactersJson: join(root, 'characters.json'),
    charactersArchiveDir: join(root, 'characters.archive'),
    locationsJson: join(root, 'locations.json'),
    chapters: {
      root: chaptersRoot,
      outline: join(chaptersRoot, 'outline'),
      outlineReview: join(chaptersRoot, 'outline_review'),
      draft: join(chaptersRoot, 'draft'),
      review: join(chaptersRoot, 'review'),
      final: join(chaptersRoot, 'final'),
    },
    memory: {
      root: memoryRoot,
      matrixJson: join(memoryRoot, 'matrix.json'),
      snapshotsDir: join(memoryRoot, 'snapshots'),
    },
    guidance: {
      root: guidanceRoot,
      notesJson: join(guidanceRoot, 'notes.json'),
    },
    state: {
      root: stateRoot,
      pipelineLock: join(stateRoot, 'pipeline.lock'),
      progressJson: join(stateRoot, 'progress.json'),
      isolationJson: join(stateRoot, 'isolation.json'),
      channelsJson: join(stateRoot, 'channels.json'),
    },
    logs: {
      root: logsRoot,
      pipelineLog: join(logsRoot, 'pipeline.jsonl'),
      auditLog: join(logsRoot, 'audit.jsonl'),
      rawResponsesDir: join(logsRoot, 'raw_responses'),
    },
    reports: {
      root: reportsRoot,
      summaryReport: join(reportsRoot, 'summary_report.json'),
      progressSnapshots: join(reportsRoot, 'progress_snapshots.json'),
    },
    output: {
      root: outputRoot,
      fullNovel: join(outputRoot, 'full_novel.txt'),
      bundleDir: join(outputRoot, 'bundle'),
    },
  }
}

export async function ensureProjectLayout(paths: ProjectPaths): Promise<void> {
  const dirs = [
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
  ]
  await Promise.all(dirs.map((dir) => mkdir(dir, { recursive: true })))
}