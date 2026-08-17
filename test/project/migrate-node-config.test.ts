import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateFromNodeConfig, migrateNodeConfigObject, NodeConfig } from '../../src/project/migrate-node-config'
import { ProjectCreateInputSchema } from '../../src/project/schema'

const nodeConfig: NodeConfig = {
  total_chapters: 30,
  model: 'deepseek-chat',
  webhook_url: 'https://hook.example/x',
  api_qps: 2.0,
  writer: { max_tokens: 8192, temperature: 0.7, max_retries: 3, retry_delay: 5.0 },
  reviewer: { max_tokens: 4096, temperature: 0.3, min_score: 7.0, origin_max_chars: 4000 },
  outline_reviewer: { max_tokens: 4096, temperature: 0.3, min_score: 8.0, origin_max_chars: 4000 },
  planner: { max_tokens: 8192, temperature: 0.5, parallel_agents: 2 },
  coordinator: {
    batch_size: 10,
    num_workers: 2,
    review_workers: 2,
    draft_workers: 2,
    pause_between_batches: 3.0,
    push_interval_seconds: 120,
    outline_lookahead_chapters: 5,
  },
  repair: { max_consecutive_failures: 5 },
  quality: {
    min_chapter_words: 4500,
    max_chapter_words: 12000,
    warn_min_chapter_words: 4000,
    warn_max_chapter_words: 15000,
    hard_fail_min_chapter_words: 2500,
    min_paragraphs: 15,
    max_duplicate_paragraph_ratio: 0.25,
    max_similar_paragraph_ratio: 0.2,
    similar_paragraph_threshold: 0.88,
  },
}

describe('node config migration', () => {
  it('migrates real-shape config and output passes new schema', () => {
    const { input, extras } = migrateNodeConfigObject(nodeConfig)
    expect(input.totalChapters).toBe(30)
    expect(input.structured?.minWords).toBe(4500)
    expect(input.structured?.maxWords).toBe(12000)
    expect(input.structured?.hardFloorWords).toBe(2500)
    expect(input.structured?.minParagraphs).toBe(15)
    expect(input.gates?.draftGate).toBe(7.0)
    expect(input.gates?.outlineGate).toBe(8.0)
    expect(input.scheduling?.writerConcurrency).toBe(2)
    expect(input.scheduling?.reviewerConcurrency).toBe(2)
    expect(input.scheduling?.outlineLookahead).toBe(5)
    expect(input.scheduling?.chapterFailureLimit).toBe(5)
    expect(input.retry?.initialDelayMs).toBe(5000)
    expect(extras.webhookUrl).toBe('https://hook.example/x')
    expect(extras.apiQps).toBe(2.0)
    expect(input.bindings).toHaveLength(5)
    const writer = input.bindings!.find((b) => b.role === 'writer')!
    expect(writer.primary.model).toBe('deepseek-chat')
    expect(writer.temperature).toBe(0.7)
    expect(writer.maxOutputTokens).toBe(8192)
    const reviewer = input.bindings!.find((b) => b.role === 'reviewer')!
    expect(reviewer.temperature).toBe(0.3)
    const check = ProjectCreateInputSchema.safeParse({ ...input, premise: '一个足够长的故事前提'.repeat(5) })
    expect(check.success).toBe(true)
  })

  it('keeps legacy word range 4500~12000 untouched (no new-default overwrite)', () => {
    const { input } = migrateNodeConfigObject(nodeConfig)
    expect(input.structured?.minWords).not.toBe(2000)
    expect(input.structured?.maxWords).not.toBe(3000)
  })

  it('missing sections fall back to new defaults', () => {
    const { input, extras } = migrateNodeConfigObject({ total_chapters: 5 })
    expect(input.totalChapters).toBe(5)
    expect(input.structured).toBeUndefined()
    expect(extras.webhookUrl).toBeUndefined()
  })

  it('migrateFromNodeConfig reads file from disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'migrate-'))
    const path = join(dir, 'config.json')
    await writeFile(path, JSON.stringify(nodeConfig), 'utf-8')
    const { input } = await migrateFromNodeConfig(path)
    expect(input.totalChapters).toBe(30)
  })
})