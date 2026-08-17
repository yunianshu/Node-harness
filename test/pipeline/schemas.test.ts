import { describe, expect, it } from 'vitest'
import { ChapterOutlineSchema, resolveLocationName, validateOutlineStructure } from '../../src/pipeline/schemas'

const baseOutline = {
  chapter: 1,
  title: '雪夜',
  summary: '摘要',
  keyEvents: ['事件'],
  scenes: [{ seq: 1, locationRef: '长街', timeAdvance: '当日', purpose: '寻人' }],
  crossChapterHandoff: '衔接',
  foreshadowPlan: [],
}

describe('resolveLocationName（地点引用别名归一）', () => {
  it('exact match returns the ref', () => {
    expect(resolveLocationName('长街', ['长街', '酒馆'])).toBe('长街')
  })

  it('resolves a bare name to an annotated profile name', () => {
    expect(resolveLocationName('旧宅废墟', ['边城酒馆', '旧宅废墟（沈家老宅）'])).toBe('旧宅废墟（沈家老宅）')
  })

  it('resolves an annotated ref to a bare profile name', () => {
    expect(resolveLocationName('酒馆（老周的）', ['酒馆'])).toBe('酒馆')
  })

  it('returns null when annotation-stripped names collide', () => {
    expect(resolveLocationName('废墟', ['废墟（东）', '废墟（西）'])).toBeNull()
  })

  it('returns null for a genuinely unknown location', () => {
    expect(resolveLocationName('皇宫', ['长街'])).toBeNull()
  })
})

describe('validateOutlineStructure（地点归一回写）', () => {
  it('canonicalizes an aliased locationRef and returns the normalized outline', () => {
    const outline = {
      ...baseOutline,
      scenes: [{ seq: 1, locationRef: '旧宅废墟', timeAdvance: '当日', purpose: '查案' }],
    }
    const result = validateOutlineStructure(outline, ['旧宅废墟（沈家老宅）'], [])
    expect(result.ok).toBe(true)
    expect(result.value?.scenes[0].locationRef).toBe('旧宅废墟（沈家老宅）')
  })

  it('rejects a dangling location and lists available names', () => {
    const result = validateOutlineStructure(
      { ...baseOutline, scenes: [{ seq: 1, locationRef: '皇宫', timeAdvance: '当日', purpose: '查案' }] },
      ['长街'],
      [],
    )
    expect(result.ok).toBe(false)
    expect(result.problems[0]).toContain('可用：长街')
  })

  it('passes schema-invalid outlines through as problems', () => {
    const result = validateOutlineStructure({ chapter: 1 }, ['长街'], [])
    expect(result.ok).toBe(false)
    expect(result.problems[0]).toContain('章纲结构不合法')
  })
})

describe('ChapterOutlineSchema 基线', () => {
  it('accepts a conforming outline', () => {
    expect(ChapterOutlineSchema.safeParse(baseOutline).success).toBe(true)
  })
})
