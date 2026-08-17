import { describe, expect, it } from 'vitest'
import { DE_AI_WRITING_RULES, PromptBuilder } from '../../src/pipeline/prompt-builder'
import { StylePackLoader } from '../../src/quality/style-pack-loader'
import { emptyMatrix } from '../../src/memory/matrix-store'
import { buildInjection } from '../../src/memory/injection-builder'
import { join } from 'node:path'

const builder = new PromptBuilder()

async function loadPack(id: string) {
  return new StylePackLoader(join(process.cwd(), 'style-packs')).load(id)
}

describe('prompt builder', () => {
  it('writing prompt contains BOTH style pack rules and de-AI rules (spec 5.3.1 rule 8a)', async () => {
    const pack = await loadPack('gulong')
    const prompt = builder.buildWriterPrompt({
      chapter: 3,
      outline: {
        chapter: 3,
        title: 't',
        summary: 's',
        keyEvents: ['e'],
        scenes: [{ seq: 1, locationRef: '长街', timeAdvance: '次日', purpose: 'p' }],
        foreshadowPlan: [],
        rewriteTrace: [],
      },
      world: { worldview: 'w' },
      charactersDigest: '沈孤鸿（主角）',
      injection: buildInjection(emptyMatrix(), 3),
      previousChapterEnding: null,
      mode: 'first',
      reviewFeedback: null,
      aiFlavorHits: [],
      guidanceNote: null,
      stylePack: pack,
      wordRange: { min: 2000, max: 3000 },
    })
    expect(prompt.system).toContain('不写招式写意境')
    expect(prompt.system).toContain('去AI味')
    expect(prompt.system).toContain('翻案句')
    expect(prompt.system).toContain('2000~3000')
  })

  it('generic pack also overlays de-AI rules (global layer independent of pack)', async () => {
    const pack = await loadPack('generic')
    const prompt = builder.buildWriterPrompt({
      chapter: 1,
      outline: {
        chapter: 1,
        title: 't',
        summary: 's',
        keyEvents: ['e'],
        scenes: [{ seq: 1, locationRef: 'x', timeAdvance: 'y', purpose: 'z' }],
        foreshadowPlan: [],
        rewriteTrace: [],
      },
      world: { worldview: 'w' },
      charactersDigest: '',
      injection: null,
      previousChapterEnding: null,
      mode: 'first',
      reviewFeedback: null,
      aiFlavorHits: [],
      guidanceNote: null,
      stylePack: pack,
      wordRange: { min: 2000, max: 3000 },
    })
    expect(prompt.system).toContain('每个场景必须有目标、有动作、有变化')
  })

  it('review prompt never contains writer model identity (spec 5.4.1 rule 9)', async () => {
    const pack = await loadPack('generic')
    const prompt = builder.buildReviewPrompt({
      kind: 'draft',
      chapter: 2,
      content: '正文',
      stylePack: pack,
      gate: 7,
      consistencySignalsDigest: null,
      previousSpacetimeDigest: null,
    })
    expect(prompt.system).not.toContain('glm-4.6')
    expect(prompt.system).not.toContain('deepseek')
    expect(prompt.system).toContain('不要猜测内容由哪个模型生成')
  })

  it('injection section boosts overdue foreshadow with mandatory hint', () => {
    const matrix = emptyMatrix()
    matrix.foreshadows.push({ id: 'F-001', title: '断刀', plantedChapter: 2, expectedRevealChapter: 5, status: 'planted' })
    const injection = buildInjection(matrix, 10)
    const section = builder.injectionSection(injection)
    expect(section).toContain('必须处理')
    expect(section).toContain('F-001')
  })

  it('de-AI rules text is stable and complete', () => {
    expect(DE_AI_WRITING_RULES.length).toBeGreaterThanOrEqual(5)
    expect(DE_AI_WRITING_RULES.some((r) => r.includes('不是……而是……'))).toBe(true)
  })
})