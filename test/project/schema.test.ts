import { describe, expect, it } from 'vitest'
import {
  AiFlavorConfigSchema,
  ModelBindingSchema,
  ProjectConfigSchema,
  ProjectCreateInputSchema,
  QualityGatesSchema,
  StructuredQualitySchema,
} from '../../src/project/schema'

describe('config schema', () => {
  it('rejects totalChapters=1000 and gates=11', () => {
    expect(ProjectCreateInputSchema.safeParse({ name: 'x', premise: 'p', totalChapters: 1000 }).success).toBe(false)
    expect(QualityGatesSchema.safeParse({ draftGate: 11 }).success).toBe(false)
    expect(QualityGatesSchema.safeParse({ draftGate: 9.5 }).success).toBe(true)
  })

  it('rejects empty premise', () => {
    expect(ProjectCreateInputSchema.safeParse({ name: 'x', premise: '', totalChapters: 30 }).success).toBe(false)
  })

  it('parses defaults for legal minimal input', () => {
    const parsed = ProjectCreateInputSchema.parse({ name: '风暴', premise: '一个故事', totalChapters: 30 })
    expect(parsed.totalChapters).toBe(30)
    const gates = QualityGatesSchema.parse({})
    expect(gates.outlineGate).toBe(8.0)
    expect(gates.draftGate).toBe(7.0)
    expect(gates.draftRewriteLimit).toBe(3)
    expect(gates.outlineDirectedLimit).toBe(2)
    expect(gates.outlineFullRegenLimit).toBe(1)
  })

  it('structured quality defaults to 2000~3000 words', () => {
    const s = StructuredQualitySchema.parse({})
    expect(s.minWords).toBe(2000)
    expect(s.maxWords).toBe(3000)
    expect(s.hardFloorWords).toBe(1500)
    expect(s.minParagraphs).toBe(15)
  })

  it('ai flavor config defaults all checks enabled', () => {
    const cfg = AiFlavorConfigSchema.parse({})
    expect(cfg.checks.reversalSentence).toBe(true)
    expect(cfg.checks.lyricMetaphor).toBe(true)
    expect(cfg.thresholds.minSentenceLengthCV).toBe(0.35)
  })

  it('model binding validates temperature range and fallback threshold', () => {
    const ok = {
      role: 'writer',
      primary: { providerId: 'glm', model: 'glm-4.6', accessMode: 'glm-plan-cn' },
      temperature: 0.7,
    }
    expect(ModelBindingSchema.safeParse(ok).success).toBe(true)
    expect(ModelBindingSchema.safeParse({ ...ok, temperature: 3 }).success).toBe(false)
    const parsed = ModelBindingSchema.parse(ok)
    expect(parsed.fallbackThreshold).toBe(5)
    expect(parsed.maxOutputTokens).toBe(8192)
  })

  it('full project config round-trips with defaults filled', () => {
    const parsed = ProjectConfigSchema.safeParse({
      projectId: 'p1',
      name: '风暴',
      totalChapters: 30,
      stylePackId: 'generic',
      premiseSha256: 'a'.repeat(64),
      premiseLength: 100,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.status).toBe('pending')
      expect(parsed.data.scheduling.outlineLookahead).toBe(5)
      expect(parsed.data.bindings).toEqual([])
    }
  })
})