import { countWords, splitParagraphs } from '../text-utils.js'
import type { DeAiHit } from './checker.js'

export function countChar(text: string, ch: string): number {
  let count = 0
  for (const c of text) {
    if (c === ch) count++
  }
  return count
}

export function countDash(text: string): number {
  let count = 0
  for (const c of text) {
    if (c === '—' || c === '——') count++
  }
  return count
}

export function perKChar(count: number, totalWords: number): number {
  if (totalWords === 0) return 0
  return Number(((count * 1000) / totalWords).toFixed(2))
}

export function detectPunctuation(
  text: string,
  thresholds: { maxColonDensityPerKChar: number; maxDashDensityPerKChar: number },
): DeAiHit[] {
  const hits: DeAiHit[] = []
  const paragraphs = splitParagraphs(text)
  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i]
    const words = countWords(p)
    if (words < 30) continue
    const colons = countChar(p, '：') + countChar(p, ':')
    const colonDensity = perKChar(colons, words)
    if (colonDensity > thresholds.maxColonDensityPerKChar) {
      hits.push({
        type: 'punctuation-colon',
        severity: 'general',
        paragraph: i + 1,
        excerpt: p.slice(0, 60),
        detail: { density: colonDensity, limit: thresholds.maxColonDensityPerKChar, symbol: '：' },
      })
    }
    const dashes = countDash(p)
    const dashDensity = perKChar(dashes, words)
    if (dashDensity > thresholds.maxDashDensityPerKChar) {
      hits.push({
        type: 'punctuation-dash',
        severity: 'general',
        paragraph: i + 1,
        excerpt: p.slice(0, 60),
        detail: { density: dashDensity, limit: thresholds.maxDashDensityPerKChar, symbol: '—' },
      })
    }
  }
  return hits
}