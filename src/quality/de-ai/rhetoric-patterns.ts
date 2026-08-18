import { countWords, splitParagraphs, splitSentences } from '../text-utils.js'
import { perKChar } from './punctuation.js'
import type { DeAiHit } from './checker.js'

export function detectParallelism(text: string, maxRuns: number): DeAiHit[] {
  const hits: DeAiHit[] = []
  const sentences = splitSentences(text)
  let runStart = 0
  let runLength = 1

  const isSameStructure = (a: string, b: string): boolean => {
    const la = countWords(a)
    const lb = countWords(b)
    if (la < 6 || lb < 6) return false
    const ratio = Math.min(la, lb) / Math.max(la, lb)
    if (ratio < 0.75) return false
    const headA = a.slice(0, 2)
    const headB = b.slice(0, 2)
    if (headA === headB) return true
    const tailA = a.slice(-3)
    const tailB = b.slice(-3)
    return tailA === tailB
  }

  for (let i = 1; i <= sentences.length; i++) {
    if (i < sentences.length && isSameStructure(sentences[i - 1].text, sentences[i].text)) {
      runLength++
    } else {
      if (runLength > maxRuns) {
        hits.push({
          type: 'parallelism',
          severity: 'general',
          paragraph: -1,
          sentence: sentences[runStart].index + 1,
          excerpt: sentences.slice(runStart, runStart + runLength).map((s) => s.text.slice(0, 20)).join(' / '),
          detail: { runLength, from: runStart + 1, to: runStart + runLength },
        })
      }
      runStart = i
      runLength = 1
    }
  }
  return hits
}

const ABSTRACT_NOUNS = ['命运', '时光', '岁月', '孤独', '寂寞', '人生', '灵魂', '记忆', '悲伤', '希望', '永恒', '温柔']

export function detectLyricMetaphor(
  text: string,
  thresholds: { maxSimileDensityPerKChar: number },
): DeAiHit[] {
  const hits: DeAiHit[] = []
  const paragraphs = splitParagraphs(text)
  // 裸「像」与「像…一样/似的」都算明喻：此前只匹配带尾词的「像…一样」，
  // 漏掉全部裸「像」比喻（如「像两条干涸的河」），密度统计失真。
  // 宁滥勿漏——本检查为 general 反馈层，不阻断，少量误报无害。
  const simileRegex = /像[^。！？\n]{1,16}/g
  let abstractSimiles = 0
  let totalSimiles = 0

  for (const p of paragraphs) {
    let match: RegExpExecArray | null
    const regex = new RegExp(simileRegex.source, 'g')
    while ((match = regex.exec(p)) !== null) {
      totalSimiles++
      if (ABSTRACT_NOUNS.some((n) => match![0].includes(n))) {
        abstractSimiles++
        hits.push({
          type: 'lyric-metaphor',
          severity: 'general',
          paragraph: -1,
          excerpt: match[0],
          detail: { kind: 'abstract-simile' },
        })
      }
    }
  }

  const words = countWords(text)
  if (words >= 300) {
    const density = perKChar(totalSimiles, words)
    if (density > thresholds.maxSimileDensityPerKChar) {
      hits.push({
        type: 'lyric-metaphor',
        severity: 'general',
        paragraph: -1,
        excerpt: `"像……一样"密度 ${density}/千字 超上限 ${thresholds.maxSimileDensityPerKChar}/千字`,
        detail: { kind: 'simile-density', density, limit: thresholds.maxSimileDensityPerKChar, totalSimiles },
      })
    }
    if (abstractSimiles >= 3) {
      const existing = hits.find((h) => h.detail.kind === 'abstract-simile-count')
      if (!existing) {
        hits.push({
          type: 'lyric-metaphor',
          severity: 'general',
          paragraph: -1,
          excerpt: `抽象喻体明喻命中 ${abstractSimiles} 处`,
          detail: { kind: 'abstract-simile-count', count: abstractSimiles },
        })
      }
    }
  }
  return hits
}