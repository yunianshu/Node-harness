import type { StructuredQuality } from '../project/schema.js'
import { countWords, splitParagraphs } from './text-utils.js'
import { duplicateParagraphRatio, similarParagraphRatio } from './similarity.js'

export type StructuredCheckType =
  | 'word-count'
  | 'paragraph-count'
  | 'duplicate-ratio'
  | 'similar-ratio'

export interface StructuredFailure {
  type: StructuredCheckType
  message: string
  detail: Record<string, unknown>
}

export interface StructuredCheckResult {
  passed: boolean
  wordCount: number
  paragraphCount: number
  duplicateRatio: number
  similarRatio: number
  failures: StructuredFailure[]
}

export function checkStructured(text: string, config: StructuredQuality): StructuredCheckResult {
  const paragraphs = splitParagraphs(text)
  const wordCount = countWords(text)
  const failures: StructuredFailure[] = []

  if (wordCount < config.hardFloorWords) {
    failures.push({
      type: 'word-count',
      message: `字数 ${wordCount} 低于硬性下限 ${config.hardFloorWords}，判硬失败`,
      detail: { wordCount, hardFloorWords: config.hardFloorWords, hard: true },
    })
  } else if (wordCount < config.minWords || wordCount > config.maxWords) {
    failures.push({
      type: 'word-count',
      message: `字数 ${wordCount} 超出区间 [${config.minWords}, ${config.maxWords}]`,
      detail: { wordCount, minWords: config.minWords, maxWords: config.maxWords },
    })
  }

  if (paragraphs.length < config.minParagraphs) {
    failures.push({
      type: 'paragraph-count',
      message: `段落数 ${paragraphs.length} 少于下限 ${config.minParagraphs}`,
      detail: { paragraphCount: paragraphs.length, minParagraphs: config.minParagraphs },
    })
  }

  const dup = duplicateParagraphRatio(paragraphs)
  if (dup.ratio > config.maxDuplicateParagraphRatio) {
    failures.push({
      type: 'duplicate-ratio',
      message: `重复段落比例 ${(dup.ratio * 100).toFixed(1)}% 超上限 ${(config.maxDuplicateParagraphRatio * 100).toFixed(0)}%`,
      detail: { ratio: dup.ratio, pairs: dup.pairs.slice(0, 10) },
    })
  }

  const sim = similarParagraphRatio(paragraphs, config.similarThreshold)
  if (sim.ratio > config.maxSimilarParagraphRatio) {
    failures.push({
      type: 'similar-ratio',
      message: `相似段落比例 ${(sim.ratio * 100).toFixed(1)}% 超上限 ${(config.maxSimilarParagraphRatio * 100).toFixed(0)}%`,
      detail: { ratio: sim.ratio, pairs: sim.pairs.slice(0, 10) },
    })
  }

  return {
    passed: failures.length === 0,
    wordCount,
    paragraphCount: paragraphs.length,
    duplicateRatio: dup.ratio,
    similarRatio: sim.ratio,
    failures,
  }
}

export function isHardFailure(failure: StructuredFailure): boolean {
  return failure.detail.hard === true
}