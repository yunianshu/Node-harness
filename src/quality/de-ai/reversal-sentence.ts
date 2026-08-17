import { splitSentences } from '../text-utils.js'
import type { DeAiHit } from './checker.js'

const PATTERNS: Array<{ re: RegExp; label: string; requiresNegation?: boolean }> = [
  { re: /不是[^。！？;；]{0,30}?而是/, label: '不是……而是……' },
  { re: /你不是[^。！？;；]{0,30}[，,]?\s*(你)?(以为|认为|觉得)[^。！？;；]{0,30}[。！？?？]/, label: '你以为……其实……（立破）' },
  { re: /(你)?以为[^。！？;；]{0,30}(其实|实际上|事实上|殊不知)/, label: '以为……其实……' },
  { re: /回头(才)?(发现|看|看懂|明白)/, label: '回头才发现' },
  { re: /与其说[^。！？;；]{0,40}不如说/, label: '与其说……不如说……' },
  { re: /看似[^。！？;；]{0,30}(实则|实为|其实|实际上)/, label: '看似……实则……' },
  { re: /表面上[^。！？;；]{0,30}(实际上|实则|背地里|其实)/, label: '表面上……实际上……' },
  { re: /(曾经|从前)[^。！？;；]{0,20}(以为|以为)[^。！？;；]{0,30}(如今|现在|后来)(才)?(懂|明白|发现)/, label: '曾经以为……如今才懂' },
]

const NEGATION_WORDS = ['不', '没', '别', '无', '非', '未']

function hasNegation(sentence: string): boolean {
  return NEGATION_WORDS.some((w) => sentence.includes(w))
}

export function detectReversalSentences(text: string): DeAiHit[] {
  const hits: DeAiHit[] = []
  const sentences = splitSentences(text)
  for (const sentence of sentences) {
    for (const pattern of PATTERNS) {
      if (pattern.re.test(sentence.text)) {
        if (pattern.requiresNegation && !hasNegation(sentence.text)) continue
        hits.push({
          type: 'reversal-sentence',
          severity: 'severe',
          paragraph: -1,
          sentence: sentence.index + 1,
          excerpt: sentence.text.slice(0, 60),
          detail: { pattern: pattern.label },
        })
        break
      }
    }
  }
  return hits
}