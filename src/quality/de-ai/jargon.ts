import { splitSentences } from '../text-utils.js'
import type { DeAiHit } from './checker.js'

export const AI_JARGON_WORDS: readonly string[] = [
  '在他看来',
  '在他眼中',
  '仿佛在诉说',
  '仿佛在低语',
  '空气中弥漫着',
  '空气中凝固着',
  '岁月的沉淀',
  '时光的沉淀',
  '不禁让人',
  '令人窒息',
  '无声地诉说',
  '诉说着什么',
  '见证了',
  '承载了太多',
  '内心深处',
  '灵魂深处',
  '无法言喻',
  '难以名状',
  '只可意会',
  '不可言传',
  '眼神里闪过一丝',
  '眼中闪过一丝',
  '嘴角勾起一抹',
  '眼底掠过',
  '一丝不易察觉',
  '几不可察',
  '岁月静好',
  '诗和远方',
  '重新定义',
  '赋能',
  '底层逻辑',
  '认知升级',
  '情绪价值',
  '松弛感',
  '氛围感拉满',
]

export function detectJargon(text: string): DeAiHit[] {
  const hits: DeAiHit[] = []
  const sentences = splitSentences(text)
  const seen = new Set<string>()
  for (const sentence of sentences) {
    for (const word of AI_JARGON_WORDS) {
      if (sentence.text.includes(word) && !seen.has(`${sentence.index}:${word}`)) {
        seen.add(`${sentence.index}:${word}`)
        hits.push({
          type: 'jargon',
          severity: 'severe',
          paragraph: -1,
          sentence: sentence.index + 1,
          excerpt: sentence.text.slice(0, 60),
          detail: { word },
        })
      }
    }
  }
  return hits
}