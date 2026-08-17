import { countWords, splitSentences } from '../text-utils.js'
import { perKChar } from './punctuation.js'
import type { DeAiHit } from './checker.js'

export const CONJUNCTION_WORDS: readonly string[] = [
  '但是',
  '然而',
  '因此',
  '所以',
  '于是',
  '接着',
  '然后',
  '并且',
  '而且',
  '虽然',
  '尽管',
  '如果',
  '因为',
  '由于',
  '不过',
  '反而',
  '其实',
  '显然',
  '当然',
  '与此同时',
  '随后',
]

export function detectConjunction(text: string, maxDensityPerKChar: number): DeAiHit[] {
  const sentences = splitSentences(text)
  let count = 0
  for (const sentence of sentences) {
    for (const word of CONJUNCTION_WORDS) {
      let idx = sentence.text.indexOf(word)
      while (idx !== -1) {
        count++
        idx = sentence.text.indexOf(word, idx + word.length)
      }
    }
  }
  const total = countWords(text)
  const density = perKChar(count, total)
  if (density > maxDensityPerKChar && total >= 200) {
    return [
      {
        type: 'conjunction',
        severity: 'general',
        paragraph: -1,
        excerpt: `连词密度 ${density}/千字 超上限 ${maxDensityPerKChar}/千字`,
        detail: { density, limit: maxDensityPerKChar, count },
      },
    ]
  }
  return []
}