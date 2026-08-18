import { splitSentences } from '../text-utils.js'
import type { DeAiHit } from './checker.js'

/**
 * 翻案句分级（spec 术语：先给读者立一个误解，再推翻它）：
 * - severe：认知翻案（立破/恍然类，读者的预期被刻意建立后推翻）
 * - general：客观对比（「不是A，而是B」式的客观陈述/揭示，非认知翻案；
 *   对比短句同时是古龙等风格的核心修辞，降级为 general 不再直接重写）
 */
const PATTERNS: Array<{ re: RegExp; label: string; severity: 'severe' | 'general'; requiresNegation?: boolean }> = [
  { re: /不是[^。！？;；]{0,30}?而是/, label: '不是……而是……', severity: 'general' },
  { re: /你不是[^。！？;；]{0,30}[，,]?\s*(你)?(以为|认为|觉得)[^。！？;；]{0,30}[。！？?？]/, label: '你以为……其实……（立破）', severity: 'severe' },
  { re: /(你)?以为[^。！？;；]{0,30}(其实|实际上|事实上|殊不知)/, label: '以为……其实……', severity: 'severe' },
  // 仅匹配省悟用法「回头才发现/看懂/明白」；裸「回头看」是动作描写，武侠文高频正常句
  { re: /回头才(发现|看懂|明白)/, label: '回头才发现', severity: 'severe' },
  { re: /与其说[^。！？;；]{0,40}不如说/, label: '与其说……不如说……', severity: 'severe' },
  { re: /看似[^。！？;；]{0,30}(实则|实为|其实|实际上)/, label: '看似……实则……', severity: 'severe' },
  { re: /表面上[^。！？;；]{0,30}(实际上|实则|背地里|其实)/, label: '表面上……实际上……', severity: 'severe' },
  { re: /(曾经|从前)[^。！？;；]{0,20}(以为|以为)[^。！？;；]{0,30}(如今|现在|后来)(才)?(懂|明白|发现)/, label: '曾经以为……如今才懂', severity: 'severe' },
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
          severity: pattern.severity,
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