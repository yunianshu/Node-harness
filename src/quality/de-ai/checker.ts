import type { AiFlavorConfig } from '../../project/schema.js'
import { detectReversalSentences } from './reversal-sentence.js'
import { detectJargon } from './jargon.js'
import { detectPunctuation } from './punctuation.js'
import { detectSentenceRhythm } from './sentence-rhythm.js'
import { detectConjunction } from './conjunction.js'
import { detectLyricMetaphor, detectParallelism } from './rhetoric-patterns.js'

export type DeAiSeverity = 'severe' | 'general'

export interface DeAiHit {
  type: string
  severity: DeAiSeverity
  paragraph: number
  sentence?: number
  excerpt: string
  detail: Record<string, unknown>
}

export interface DeAiCheckResult {
  passed: boolean
  hasSevere: boolean
  hits: DeAiHit[]
}

export function runDeAiChecks(text: string, config: AiFlavorConfig): DeAiCheckResult {
  const hits: DeAiHit[] = []
  const { checks, thresholds } = config

  if (checks.reversalSentence) hits.push(...detectReversalSentences(text))
  if (checks.jargon) hits.push(...detectJargon(text))
  if (checks.punctuation) {
    hits.push(
      ...detectPunctuation(text, {
        maxColonDensityPerKChar: thresholds.maxColonDensityPerKChar,
        maxDashDensityPerKChar: thresholds.maxDashDensityPerKChar,
      }),
    )
  }
  if (checks.sentenceRhythm) hits.push(...detectSentenceRhythm(text, thresholds.minSentenceLengthCV))
  if (checks.conjunction) hits.push(...detectConjunction(text, thresholds.maxConjunctionDensityPerKChar))
  if (checks.parallelism) hits.push(...detectParallelism(text, thresholds.maxParallelismRuns))
  if (checks.lyricMetaphor) {
    hits.push(...detectLyricMetaphor(text, { maxSimileDensityPerKChar: thresholds.maxSimileDensityPerKChar }))
  }

  const hasSevere = hits.some((h) => h.severity === 'severe')
  return {
    passed: hits.length === 0,
    hasSevere,
    hits,
  }
}