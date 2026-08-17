import { describe, expect, it } from 'vitest'
import { StructuredQualitySchema } from '../../src/project/schema'
import { checkStructured } from '../../src/quality/structured-checker'
import { diverseParagraphText, diverseText } from '../helpers/text'

describe('structured checker', () => {
  const config = StructuredQualitySchema.parse({})
  const relaxed = StructuredQualitySchema.parse({ minWords: 1, maxWords: 999999, hardFloorWords: 1, minParagraphs: 1 })

  it('1800 words fails below lower bound (spec 5.4.1 rule 2a)', () => {
    const text = diverseParagraphText(16, 1800)
    const result = checkStructured(text, config)
    expect(result.wordCount).toBeGreaterThanOrEqual(1800)
    expect(result.wordCount).toBeLessThan(2000)
    expect(result.passed).toBe(false)
    expect(result.failures.some((f) => f.type === 'word-count')).toBe(true)
  })

  it('text within 2000~3000 words and enough paragraphs passes', () => {
    const text = diverseParagraphText(18, 2200)
    const result = checkStructured(text, config)
    expect(result.wordCount).toBeGreaterThanOrEqual(2000)
    expect(result.wordCount).toBeLessThanOrEqual(3000)
    expect(result.paragraphCount).toBeGreaterThanOrEqual(15)
    expect(result.passed).toBe(true)
  })

  it('below hard floor 1500 marks hard failure', () => {
    const text = diverseParagraphText(16, 900)
    const result = checkStructured(text, config)
    expect(result.wordCount).toBeLessThan(1500)
    const wc = result.failures.find((f) => f.type === 'word-count')!
    expect(wc.detail.hard).toBe(true)
  })

  it('detects duplicate paragraphs beyond 25%', () => {
    const dup = '这一段被原样复制了一遍又一遍，内容完全相同。'
    const unique = Array.from({ length: 10 }, (_, i) => `独一无二的段落内容编号${i}，山高水远各走一方，马蹄声碎在长街尽头。`)
    const text = [dup, dup, dup, dup, dup, ...unique].join('\n')
    const result = checkStructured(text, relaxed)
    expect(result.failures.some((f) => f.type === 'duplicate-ratio')).toBe(true)
  })

  it('detects similar paragraphs beyond 20%', () => {
    const base = '他走进那间昏暗的屋子，桌上摆着一盏还没有熄灭的油灯，窗外的风吹得纸窗沙沙作响。'
    const similar = '他走进那间昏暗的屋子，桌上摆着一盏还没有熄灭的油灯，窗外的风吹得纸窗沙沙作响着。'
    const filler = Array.from({ length: 10 }, (_, i) => `完全不同的内容${i}：潮水退去，礁石裸露，海鸟飞远。`)
    const text = [base, similar, base, similar, base, similar, ...filler].join('\n')
    const result = checkStructured(text, relaxed)
    expect(result.failures.some((f) => f.type === 'similar-ratio')).toBe(true)
  })

  it('insufficient paragraphs fails paragraph-count', () => {
    const text = diverseText(2000)
    const result = checkStructured(text, config)
    expect(result.failures.some((f) => f.type === 'paragraph-count')).toBe(true)
  })
})
