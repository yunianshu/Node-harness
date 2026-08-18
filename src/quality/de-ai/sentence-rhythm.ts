import { countWords, splitSentences } from '../text-utils.js'
import type { DeAiHit } from './checker.js'

export function coefficientOfVariation(lengths: number[]): number {
  if (lengths.length < 2) return Infinity
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length
  if (mean === 0) return Infinity
  const variance = lengths.reduce((acc, l) => acc + (l - mean) ** 2, 0) / lengths.length
  return Number((Math.sqrt(variance) / mean).toFixed(3))
}

/**
 * 句长节奏两级检查（burstiness 双检测器核心信号）：
 * - 低于软下限：general，进入重写反馈（句群需穿插长句蓄力）；
 * - 低于硬下限：severe，分布塌平直接阻断——过于均匀是检测器最强指纹。
 */
export function detectSentenceRhythm(text: string, minCV: number, minCVHard: number): DeAiHit[] {
  const sentences = splitSentences(text)
  const lengths = sentences.map((s) => countWords(s.text))
  if (lengths.length < 8) return []
  const cv = coefficientOfVariation(lengths)
  if (cv < minCVHard) {
    return [
      {
        type: 'sentence-rhythm',
        severity: 'severe',
        paragraph: -1,
        excerpt: `句长变异系数 ${cv} 低于硬下限 ${minCVHard}（句长分布塌平，最强机器指纹）`,
        detail: { cv, limit: minCV, hardLimit: minCVHard, sentenceCount: lengths.length },
      },
    ]
  }
  if (cv < minCV) {
    return [
      {
        type: 'sentence-rhythm',
        severity: 'general',
        paragraph: -1,
        excerpt: `句长变异系数 ${cv} 低于下限 ${minCV}（句长过于均匀）`,
        detail: { cv, limit: minCV, sentenceCount: lengths.length },
      },
    ]
  }
  return []
}
