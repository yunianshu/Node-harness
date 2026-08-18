import { describe, expect, it } from 'vitest'
import { AiFlavorConfigSchema } from '../../src/project/schema'
import { runDeAiChecks } from '../../src/quality/de-ai/checker'

const clean = '他把刀放下。门外有风。风里有雪。雪落了三天，落满了整座城。城里的灯一盏一盏灭下去，只剩下他这一盏。他数着灯花，等一个人。那人没有来。天亮的时候，他吹熄了灯，走进风雪里。雪很冷，刀更冷。他笑了笑，继续往前走。路还很长，长得像他这一辈子。他不在乎。他在乎的，只是那盏灯还在不在。'

describe('de-ai checks', () => {
  const config = AiFlavorConfigSchema.parse({})

  it('clean text passes all seven checks', () => {
    const result = runDeAiChecks(clean.repeat(3), config)
    expect(result.hits.filter((h) => h.severity === 'severe')).toHaveLength(0)
  })

  it('cognitive reversal patterns hit severe while contrast is general (spec 5.4.1 rule 2b)', () => {
    const text = '你以为他是刀客，其实他是杀手。这不是结束，而是新的开始。回头才发现，一切都晚了。看似平静的湖面，实则暗流涌动。与其说是失误，不如说是背叛。'
    const result = runDeAiChecks(text, config)
    const reversal = result.hits.filter((h) => h.type === 'reversal-sentence')
    expect(reversal.length).toBeGreaterThanOrEqual(4)
    // 认知翻案（立破/恍然类）保持 severe
    const labels = reversal.filter((h) => h.severity === 'severe').map((h) => h.detail.pattern)
    expect(labels).toContain('以为……其实……')
    expect(labels).toContain('回头才发现')
    expect(labels).toContain('看似……实则……')
    expect(labels).toContain('与其说……不如说……')
    // 「不是……而是……」客观对比降级 general（古龙式对比修辞，不再是硬阻断）
    expect(reversal.some((h) => h.severity === 'general' && h.detail.pattern === '不是……而是……')).toBe(true)
    expect(result.hasSevere).toBe(true)
  })

  it('physical look-back action is not a reversal (回头看 误报修复)', () => {
    const text = '走到门口时，他忽然停住，回头看了一眼那幅屏风。'
    const result = runDeAiChecks(text, config)
    expect(result.hits.filter((h) => h.type === 'reversal-sentence')).toHaveLength(0)
  })

  it('general-only hits no longer fail the gate (general 不一票否决)', () => {
    const text = '灯亮了：他进门。刀出鞘：人倒下。灯又亮了：雪落了。' + '他又走了很远，夜色始终未散。'.repeat(40)
    const result = runDeAiChecks(text, config)
    expect(result.hits.length).toBeGreaterThanOrEqual(1)
    expect(result.hits.every((h) => h.severity === 'general')).toBe(true)
    expect(result.passed).toBe(true)
    expect(result.hasSevere).toBe(false)
  })

  it('jargon words hit severe', () => {
    const text = '在他看来，这场雨仿佛在诉说着什么。空气中弥漫着岁月的沉淀，令人窒息。'
    const result = runDeAiChecks(text, config)
    const jargon = result.hits.filter((h) => h.type === 'jargon')
    expect(jargon.length).toBeGreaterThanOrEqual(3)
    expect(jargon.every((h) => h.severity === 'severe')).toBe(true)
  })

  it('colon overload hits punctuation check', () => {
    const parts = Array.from({ length: 8 }, (_, i) => `他看见：远处的山上有一座庙：庙里有三个和尚：和尚正在念经，第${i}遍。`)
    const result = runDeAiChecks(parts.join('\n'), config)
    expect(result.hits.some((h) => h.type === 'punctuation-colon')).toBe(true)
  })

  it('uniform sentence lengths hit rhythm check', () => {
    const sentences = Array.from({ length: 15 }, () => '他慢慢地走向前方那座城。')
    const result = runDeAiChecks(sentences.join(''), config)
    expect(result.hits.some((h) => h.type === 'sentence-rhythm')).toBe(true)
  })

  it('conjunction density overload hits conjunction check', () => {
    const sentences = Array.from({ length: 15 }, (_, i) => `但是因为所以然而虽然第${i}个人还是来了，然后接着并且走了。`)
    const result = runDeAiChecks(sentences.join(''), config)
    expect(result.hits.some((h) => h.type === 'conjunction')).toBe(true)
  })

  it('parallel run of same-structure sentences hits parallelism', () => {
    const run = Array.from({ length: 5 }, () => '他看着窗外的雪花一片一片地飘下来。')
    const tail = Array.from({ length: 4 }, (_, i) => `不同的句子结构${i}，长短不一，其间夹杂着别的东西。他停住。`)
    const result = runDeAiChecks([...run, ...tail].join(''), config)
    expect(result.hits.some((h) => h.type === 'parallelism')).toBe(true)
  })

  it('abstract similes hit lyric-metaphor check', () => {
    const sentences = [
      '他站在门口，像孤独一样沉默。',
      '她的笑容像时光一样短暂。',
      '那些话像命运一样无法更改。',
      '夜色像记忆一样漫上来。',
      '他的背影像希望一样远去。',
      '沉默像岁月一样漫长地流淌着，落满了灰。',
    ]
    const result = runDeAiChecks(sentences.join(''), config)
    expect(result.hits.some((h) => h.type === 'lyric-metaphor')).toBe(true)
  })

  it('disabling a check suppresses its hits (spec 5.1.1 rule 5)', () => {
    const text = '在他看来，这场雨仿佛在诉说着什么。'
    const disabledConfig = AiFlavorConfigSchema.parse({ checks: { jargon: false } })
    const result = runDeAiChecks(text, disabledConfig)
    expect(result.hits.filter((h) => h.type === 'jargon')).toHaveLength(0)
    const enabled = runDeAiChecks(text, config)
    expect(enabled.hits.some((h) => h.type === 'jargon')).toBe(true)
  })

  it('threshold override changes outcome (lower CV limit lets uniform text pass)', () => {
    const sentences = Array.from({ length: 15 }, () => '他慢慢地走向前方那座城。')
    const strict = runDeAiChecks(sentences.join(''), config)
    expect(strict.hits.some((h) => h.type === 'sentence-rhythm')).toBe(true)
    const relaxed = AiFlavorConfigSchema.parse({ thresholds: { minSentenceLengthCV: 0 } })
    const relaxedResult = runDeAiChecks(sentences.join(''), relaxed)
    expect(relaxedResult.hits.filter((h) => h.type === 'sentence-rhythm')).toHaveLength(0)
  })
})