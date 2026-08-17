import { readFile } from 'node:fs/promises'
import {
  ProjectCreateInput,
} from './schema.js'

export interface NodeQualitySection {
  min_chapter_words?: number
  max_chapter_words?: number
  warn_min_chapter_words?: number
  warn_max_chapter_words?: number
  hard_fail_min_chapter_words?: number
  min_paragraphs?: number
  max_duplicate_paragraph_ratio?: number
  max_similar_paragraph_ratio?: number
  similar_paragraph_threshold?: number
}

export interface NodeRoleSection {
  max_tokens?: number
  temperature?: number
  max_retries?: number
  retry_delay?: number
  min_score?: number
}

export interface NodeCoordinatorSection {
  batch_size?: number
  num_workers?: number
  review_workers?: number
  draft_workers?: number
  pause_between_batches?: number
  push_interval_seconds?: number
  outline_lookahead_chapters?: number
}

export interface NodeConfig {
  total_chapters?: number
  model?: string
  webhook_url?: string
  api_qps?: number
  writer?: NodeRoleSection
  reviewer?: NodeRoleSection & { origin_max_chars?: number }
  outline_reviewer?: NodeRoleSection & { origin_max_chars?: number }
  planner?: NodeRoleSection & { parallel_agents?: number }
  outliner?: NodeRoleSection
  coordinator?: NodeCoordinatorSection
  repair?: { max_consecutive_failures?: number }
  quality?: NodeQualitySection
}

export interface MigrationExtras {
  webhookUrl?: string
  apiQps?: number
  sourceModel?: string
}

export interface MigrationResult {
  input: ProjectCreateInput
  extras: MigrationExtras
}

export async function migrateFromNodeConfig(configPath: string): Promise<MigrationResult> {
  const raw = JSON.parse(await readFile(configPath, 'utf-8')) as NodeConfig
  return migrateNodeConfigObject(raw)
}

export function migrateNodeConfigObject(raw: NodeConfig): MigrationResult {
  const q = raw.quality ?? {}
  const reviewer = raw.reviewer ?? {}
  const outlineReviewer = raw.outline_reviewer ?? {}
  const writer = raw.writer ?? {}
  const planner = raw.planner ?? {}
  const outliner = raw.outliner ?? {}
  const coordinator = raw.coordinator ?? {}
  const repair = raw.repair ?? {}
  const model = raw.model ?? 'deepseek-chat'

  const wordRange: { minWords?: number; maxWords?: number; hardFloorWords?: number } = {}
  if (q.min_chapter_words !== undefined) wordRange.minWords = q.min_chapter_words
  if (q.max_chapter_words !== undefined) wordRange.maxWords = q.max_chapter_words
  if (q.hard_fail_min_chapter_words !== undefined) wordRange.hardFloorWords = q.hard_fail_min_chapter_words

  const structured: Record<string, number> = { ...wordRange }
  if (q.min_paragraphs !== undefined) structured.minParagraphs = q.min_paragraphs
  if (q.max_duplicate_paragraph_ratio !== undefined) structured.maxDuplicateParagraphRatio = q.max_duplicate_paragraph_ratio
  if (q.max_similar_paragraph_ratio !== undefined) structured.maxSimilarParagraphRatio = q.max_similar_paragraph_ratio
  if (q.similar_paragraph_threshold !== undefined) structured.similarThreshold = q.similar_paragraph_threshold

  const gates: Record<string, number> = {}
  if (outlineReviewer.min_score !== undefined) gates.outlineGate = outlineReviewer.min_score
  if (reviewer.min_score !== undefined) gates.draftGate = reviewer.min_score
  if (writer.max_retries !== undefined) gates.draftRewriteLimit = writer.max_retries

  const scheduling: Record<string, number> = {}
  const writerWorkers = coordinator.draft_workers ?? coordinator.num_workers
  if (writerWorkers !== undefined) scheduling.writerConcurrency = writerWorkers
  if (coordinator.review_workers !== undefined) scheduling.reviewerConcurrency = coordinator.review_workers
  if (coordinator.outline_lookahead_chapters !== undefined) scheduling.outlineLookahead = coordinator.outline_lookahead_chapters
  if (repair.max_consecutive_failures !== undefined) scheduling.chapterFailureLimit = repair.max_consecutive_failures

  const retry: Record<string, number> = {}
  if (writer.max_retries !== undefined) retry.maxRetries = writer.max_retries
  if (writer.retry_delay !== undefined) retry.initialDelayMs = Math.round(writer.retry_delay * 1000)

  const bindings = [
    roleBinding('planner', planner, model),
    roleBinding('outliner', outliner, model),
    roleBinding('outline-reviewer', outlineReviewer, model),
    roleBinding('writer', writer, model),
    roleBinding('reviewer', reviewer, model),
  ]

  const input: ProjectCreateInput = {
    name: `migrated-${new Date().toISOString().slice(0, 10)}`,
    premise: '（迁移自 Node 项目，请补充故事前提原文）',
    totalChapters: raw.total_chapters ?? 30,
    ...(Object.keys(gates).length > 0 ? { gates } : {}),
    ...(Object.keys(structured).length > 0 ? { structured } : {}),
    ...(Object.keys(scheduling).length > 0 ? { scheduling } : {}),
    ...(Object.keys(retry).length > 0 ? { retry } : {}),
    bindings,
  }

  const extras: MigrationExtras = {}
  if (raw.webhook_url) extras.webhookUrl = raw.webhook_url
  if (raw.api_qps !== undefined) extras.apiQps = raw.api_qps
  if (raw.model) extras.sourceModel = raw.model

  return { input, extras }
}

function roleBinding(
  role: 'planner' | 'outliner' | 'outline-reviewer' | 'writer' | 'reviewer',
  section: NodeRoleSection,
  model: string,
): NonNullable<ProjectCreateInput['bindings']>[number] {
  return {
    role,
    primary: { providerId: 'deepseek', model, accessMode: 'pay-as-you-go' },
    fallbacks: [],
    temperature: section.temperature ?? 0.7,
    maxOutputTokens: section.max_tokens ?? 8192,
    fallbackThreshold: 5,
  }
}