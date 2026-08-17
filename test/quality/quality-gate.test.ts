import { describe, expect, it } from 'vitest'
import { AiFlavorConfigSchema, QualityGatesSchema, StructuredQualitySchema } from '../../src/project/schema'
import { checkDraft, verdict } from '../../src/quality/quality-gate'
import { diverseParagraphText } from '../helpers/text'

const structured = StructuredQualitySchema.parse({ minWords: 1, maxWords: 999999, hardFloorWords: 1, minParagraphs: 1 })
const aiFlavor = AiFlavorConfigSchema.parse({})
const gates = QualityGatesSchema.parse({})

describe('quality gate', () => {
  it('clean draft passes and does not trigger direct rewrite', () => {
    const outcome = checkDraft(diverseParagraphText(16, 600), { structured, aiFlavor })
    expect(outcome.passed).toBe(true)
    expect(outcome.directRewrite).toBe(false)
  })

  it('severe jargon forces direct rewrite without model review (spec 5.4.2)', () => {
    const text = diverseParagraphText(16, 600) + '\n在他看来，这一切仿佛在诉说着什么。'
    const outcome = checkDraft(text, { structured, aiFlavor })
    expect(outcome.directRewrite).toBe(true)
    expect(outcome.rewriteReasons.some((r) => r.includes('AI味/severe'))).toBe(true)
  })

  it('model score 9.0 with reversal sentence is rejected (spec 5.4.3 scenario 3)', () => {
    const text = diverseParagraphText(16, 600) + '\n这不是结束，而是新的开始。'
    const draftCheck = checkDraft(text, { structured, aiFlavor })
    const v = verdict({ score: 9.0, styleDeviation: 'none' }, draftCheck, gates)
    expect(v.accepted).toBe(false)
    expect(v.reasons.some((r) => r.includes('reversal-sentence'))).toBe(true)
  })

  it('score below gate is rejected even if hard checks pass', () => {
    const draftCheck = checkDraft(diverseParagraphText(16, 600), { structured, aiFlavor })
    const v = verdict({ score: 6.5, styleDeviation: 'none' }, draftCheck, gates)
    expect(v.accepted).toBe(false)
    expect(v.reasons.some((r) => r.includes('低于门槛'))).toBe(true)
  })

  it('severe style deviation vetoes regardless of score (spec 5.4.1 rule 4)', () => {
    const draftCheck = checkDraft(diverseParagraphText(16, 600), { structured, aiFlavor })
    const v = verdict({ score: 8.5, styleDeviation: 'severe' }, draftCheck, gates)
    expect(v.accepted).toBe(false)
    expect(v.reasons.some((r) => r.includes('严重风格偏离'))).toBe(true)
  })

  it('normal case accepted', () => {
    const draftCheck = checkDraft(diverseParagraphText(16, 600), { structured, aiFlavor })
    const v = verdict({ score: 7.2, styleDeviation: 'none' }, draftCheck, gates)
    expect(v.accepted).toBe(true)
  })
})
