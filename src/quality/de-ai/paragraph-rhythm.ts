import { countWords, splitParagraphs } from '../text-utils.js'
import { coefficientOfVariation } from './sentence-rhythm.js'
import type { DeAiHit } from './checker.js'

/**
 * 段落节奏两级检查（分布指纹第二信号）：人类写作的段落长短悬殊
 * （单行对话段与多行叙述段交错），机器段落长度高度规整。
 * 软下限 general 反馈、硬下限 severe 阻断，语义同句长节奏。
 */
export function detectParagraphRhythm(text: string, minCV: number, minCVHard: number): DeAiHit[] {
  const paragraphs = splitParagraphs(text)
  const lengths = paragraphs.map((p) => countWords(p))
  if (lengths.length < 6) return []
  const cv = coefficientOfVariation(lengths)
  if (cv < minCVHard) {
    return [
      {
        type: 'paragraph-rhythm',
        severity: 'severe',
        paragraph: -1,
        excerpt: `段长变异系数 ${cv} 低于硬下限 ${minCVHard}（段落节奏塌平）`,
        detail: { cv, limit: minCV, hardLimit: minCVHard, paragraphCount: lengths.length },
      },
    ]
  }
  if (cv < minCV) {
    return [
      {
        type: 'paragraph-rhythm',
        severity: 'general',
        paragraph: -1,
        excerpt: `段长变异系数 ${cv} 低于下限 ${minCV}（段落长短过于规整）`,
        detail: { cv, limit: minCV, paragraphCount: lengths.length },
      },
    ]
  }
  return []
}
